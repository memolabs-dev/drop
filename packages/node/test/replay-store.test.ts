import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPLAY_WINDOW_MS, uuidv7 } from '@drop/protocol';
import { DropHome } from '../src/home.ts';
import {
  COMPACT_AFTER_DEAD,
  inspectReplayJournal,
  LEGACY_PEER_TAG,
  MAX_RECEIVED_DROPS_PER_PEER,
  REPLAY_JOURNALS,
} from '../src/replay-store.ts';
import { entries, idsAt, journalIds, NOW, writeJournalStore } from './replay-fixtures.ts';

/** The first moment a store that lost its state at `found`, with its clock at `clock`, admits again. */
const quarantineEnd = (found: number, clock = found): number =>
  Math.max(found, clock) + REPLAY_WINDOW_MS + 5 * 60_000 + 1;

function withRoot(prefix: string, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('replay store per-peer share (T3.1e)', () => {
  it('refuses a peer holding its share of live ids while other peers are still admitted', () => {
    withRoot('drop-replay-quota-', (root) => {
      writeJournalStore(root, NOW, entries(idsAt(NOW, MAX_RECEIVED_DROPS_PER_PEER), 'peer-a', NOW));
      const home = new DropHome(root);
      expect(home.claimDrop(uuidv7(NOW), NOW, 'peer-a')).toBe('peer_quota');
      expect(home.claimDrop(uuidv7(NOW), NOW, 'peer-b')).toBe('claimed');
      // The share is on disk: a restart does not reset it.
      expect(new DropHome(root).claimDrop(uuidv7(NOW + 1), NOW + 1, 'peer-a')).toBe('peer_quota');
      // Once its ids expire, the peer is admitted again.
      const later = NOW + REPLAY_WINDOW_MS + 1;
      expect(home.claimDrop(uuidv7(later), later, 'peer-a')).toBe('claimed');
    });
  });

  it('counts ids migrated without a sender only against the global cap', () => {
    withRoot('drop-replay-quota-legacy-', (root) => {
      writeJournalStore(
        root,
        NOW,
        entries(idsAt(NOW, MAX_RECEIVED_DROPS_PER_PEER + 1), 'legacy', NOW).map((entry) => ({
          ...entry,
          tag: LEGACY_PEER_TAG,
        })),
      );
      expect(new DropHome(root).claimDrop(uuidv7(NOW), NOW, 'peer-a')).toBe('claimed');
    });
  });
});

describe('replay store journal (T3.1e)', () => {
  it('sees the admissions and compactions of another process sharing the home', () => {
    withRoot('drop-replay-two-processes-', (root) => {
      const [first, second] = [new DropHome(root), new DropHome(root)];
      const x = uuidv7(NOW);
      expect(first.claimDrop(x, NOW)).toBe('claimed');
      expect(second.claimDrop(x, NOW)).toBe('duplicate');
      const y = uuidv7(NOW + 1);
      expect(second.claimDrop(y, NOW + 1)).toBe('claimed');
      expect(first.claimDrop(y, NOW + 1)).toBe('duplicate');
      // The first process compacts into journal B: the second must append there, never to the emptied A.
      appendFileSync(
        join(root, REPLAY_JOURNALS[0]),
        entries(idsAt(NOW - REPLAY_WINDOW_MS - 60_000, COMPACT_AFTER_DEAD), 'old', NOW)
          .map((entry) => Buffer.from(`${entry.id} ${entry.tag} ${NOW.toString(16).padStart(12, '0')}\n`))
          .reduce((all, record) => Buffer.concat([all, record]), Buffer.alloc(0)),
      );
      const z = uuidv7(NOW + 2);
      expect(first.claimDrop(z, NOW + 2)).toBe('claimed');
      expect(inspectReplayJournal(root)?.journal).toBe(REPLAY_JOURNALS[1]);
      expect(second.claimDrop(z, NOW + 2)).toBe('duplicate');
      const w = uuidv7(NOW + 3);
      expect(second.claimDrop(w, NOW + 3)).toBe('claimed');
      expect(new DropHome(root).claimDrop(w, NOW + 3)).toBe('duplicate');
      expect(journalIds(root)).toEqual(expect.arrayContaining([x, y, z, w]));
      expect(statSync(join(root, REPLAY_JOURNALS[0])).size).toBe(0);
    });
  });

  it('cuts a torn last record, which no admission returned for, and keeps admitting', () => {
    for (const torn of [Buffer.from('0190'), Buffer.alloc(67)]) {
      withRoot('drop-replay-torn-', (root) => {
        const home = new DropHome(root);
        const admitted = uuidv7(NOW);
        expect(home.claimDrop(admitted, NOW)).toBe('claimed');
        const journal = join(root, REPLAY_JOURNALS[0]);
        const size = statSync(journal).size;
        appendFileSync(journal, torn);
        const restarted = new DropHome(root);
        expect(restarted.claimDrop(admitted, NOW + 1)).toBe('duplicate');
        expect(statSync(journal).size).toBe(size);
        expect(restarted.claimDrop(uuidv7(NOW + 2), NOW + 2)).toBe('claimed');
        expect(journalIds(root)).toHaveLength(2);
      });
    }
  });

  it('quarantines a journal damaged before its last record, then admits again past every id it held', () => {
    withRoot('drop-replay-damaged-', (root) => {
      const home = new DropHome(root);
      const admitted = [uuidv7(NOW), uuidv7(NOW + 1), uuidv7(NOW + 2)];
      for (const id of admitted) expect(home.claimDrop(id, NOW + 2)).toBe('claimed');
      const journal = join(root, REPLAY_JOURNALS[0]);
      const bytes = readFileSync(journal);
      // Damage the middle record: a valid one follows, so this is not a torn append.
      bytes.fill(0x7a, bytes.length - 2 * 67, bytes.length - 67);
      writeFileSync(journal, bytes);
      expect(() => new DropHome(root).claimDrop(uuidv7(NOW + 3), NOW + 3)).toThrow('E_REPLAY_STATE corrupt journal');
      expect(() => home.claimDrop(uuidv7(NOW + 4), NOW + 4)).toThrow('E_REPLAY_STATE quarantined');
      // A clock set back does not shorten it.
      expect(() => home.claimDrop(uuidv7(NOW - 60_000), NOW - 60_000)).toThrow('E_REPLAY_STATE quarantined');
      const end = quarantineEnd(NOW + 3, NOW + 2);
      expect(() => home.claimDrop(uuidv7(end - 1), end - 1)).toThrow('E_REPLAY_STATE quarantined');
      expect(home.claimDrop(uuidv7(end), end)).toBe('claimed');
      for (const id of admitted) expect(new DropHome(root).claimDrop(id, NOW + 2)).toBe('expired');
      expect(inspectReplayJournal(root)?.hw).toBe(end);
    });
  });

  it('quarantines a home whose journal or version disappeared instead of starting afresh', () => {
    const losses: [string, string][] = [
      [REPLAY_JOURNALS[0], 'missing journal'],
      ['received-drops-version', 'missing version'],
    ];
    for (const [file, reason] of losses) {
      withRoot('drop-replay-lost-file-', (root) => {
        const home = new DropHome(root);
        const admitted = uuidv7(NOW);
        expect(home.claimDrop(admitted, NOW)).toBe('claimed');
        unlinkSync(join(root, file));
        expect(() => new DropHome(root).claimDrop(admitted, NOW + 1), reason).toThrow(`E_REPLAY_STATE ${reason}`);
        expect(() => new DropHome(root).claimDrop(admitted, NOW + 2), reason).toThrow('E_REPLAY_STATE quarantined');
        const end = quarantineEnd(NOW + 1, NOW);
        expect(new DropHome(root).claimDrop(admitted, end), reason).toBe('expired');
        expect(new DropHome(root).claimDrop(uuidv7(end), end), reason).toBe('claimed');
      });
    }
  });

  it('refuses a version it does not know, such as one written by a newer node', () => {
    withRoot('drop-replay-version-', (root) => {
      writeFileSync(join(root, 'received-drops-version'), '4\n');
      expect(() => new DropHome(root).claimDrop(uuidv7(NOW), NOW)).toThrow('E_REPLAY_STATE corrupt version');
    });
  });
});
