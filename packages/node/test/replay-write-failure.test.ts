import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPLAY_WINDOW_MS, uuidv7 } from '@drop/protocol';

/**
 * Fault injection on the filesystem calls of the replay store.
 * - fsync: fails always, or only on the listed calls (1-based), so a test can break one step of a claim.
 * - crash: once `counting`, every mutating call is counted; the one numbered `crashAt` stops the "process" there (a
 *   write lands half), and every later mutating call fails too, as nothing runs after a crash.
 */
const fault = vi.hoisted(() => ({
  always: false,
  failOn: new Set<number>(),
  calls: 0,
  counting: false,
  ops: 0,
  crashAt: 0,
  dead: false,
  /** Real flushes cost up to tens of milliseconds; the crash loops only need the order of calls. */
  realSync: true,
  dirSyncs: 0,
  renames: 0,
  listings: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const crash = (): Error => Object.assign(new Error('injected crash'), { code: 'ECRASH' });
  /** Runs a mutating call unless the process "crashed" here or before. */
  const step = (partial?: () => void): void => {
    if (fault.dead) throw crash();
    if (!fault.counting) return;
    fault.ops += 1;
    if (fault.ops !== fault.crashAt) return;
    fault.dead = true;
    partial?.();
    throw crash();
  };
  return {
    ...fs,
    fsyncSync: (fd: number) => {
      step();
      fault.calls += 1;
      if (fs.fstatSync(fd).isDirectory()) fault.dirSyncs += 1;
      if (fault.always || fault.failOn.has(fault.calls))
        throw Object.assign(new Error('injected fsync failure'), { code: 'EIO' });
      if (fault.realSync) fs.fsyncSync(fd);
    },
    writeSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      // A crash in the middle of a write leaves half of it, as a torn write would.
      step(() => fs.writeSync(fd, buffer, offset, Math.floor(length / 2), position));
      return fs.writeSync(fd, buffer, offset, length, position);
    },
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      step();
      return fs.openSync(...args);
    },
    closeSync: (...args: Parameters<typeof fs.closeSync>) => {
      step();
      fs.closeSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      step();
      fs.writeFileSync(...args);
    },
    ftruncateSync: (...args: Parameters<typeof fs.ftruncateSync>) => {
      step();
      fs.ftruncateSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      step();
      fault.renames += 1;
      fs.renameSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
      step();
      fs.unlinkSync(...args);
    },
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      step();
      fs.rmSync(...args);
    },
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      step();
      fs.linkSync(...args);
    },
    mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => {
      step();
      return fs.mkdirSync(...args);
    },
    readdirSync: ((...args: Parameters<typeof fs.readdirSync>) => {
      fault.listings += 1;
      return fs.readdirSync(...args);
    }) as typeof fs.readdirSync,
  };
});

import { DropHome } from '../src/home.ts';
import { COMPACT_AFTER_DEAD, inspectReplayJournal } from '../src/replay-store.ts';
import { entries, idsAt, journalIds, NOW, writeJournalStore, writeLegacyStore } from './replay-fixtures.ts';

const WINDOWS = process.platform === 'win32';
/**
 * Flushes of the first claim on a fresh home or on a format-2 home: upgrade marker (file, folder), journal A, journal
 * B, their folder, version (file, folder), the folder once the legacy files are gone, then the admitted record.
 * Windows cannot flush a folder (syncDirectory), so it keeps only the five file flushes.
 */
const FIRST_CLAIM_SYNCS = WINDOWS ? 5 : 9;
/** A claim that compacts: the rewritten journal, then the emptied one. No folder change on any platform. */
const COMPACTING_CLAIM_SYNCS = 2;
/** The first claim after a quarantine: journal A, journal B, their folder, version (file, folder), folder, record. */
const RESTART_CLAIM_SYNCS = WINDOWS ? 4 : 7;
/**
 * Every transient-failure test makes real durable writes, and Windows flushes each file to disk (FlushFileBuffers). On
 * a loaded Windows runner such loops took up to 8.2 s against a 5 s default (T4.34). The tests are synchronous, so
 * vitest cannot stop them early: the timeout only judges the duration once they end.
 */
const DURABLE_WRITE_TIMEOUT_MS = 20_000;
/** The end of the quarantine that a loss found at NOW + 1, with the store clock at NOW, imposes. */
const QUARANTINE_END = NOW + 1 + REPLAY_WINDOW_MS + 5 * 60_000 + 1;

afterEach(() => {
  Object.assign(fault, {
    always: false,
    calls: 0,
    counting: false,
    ops: 0,
    crashAt: 0,
    dead: false,
    realSync: true,
    dirSyncs: 0,
    renames: 0,
    listings: 0,
  });
  fault.failOn.clear();
});

function withHome(prefix: string, run: (home: DropHome, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    run(new DropHome(root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** After a refused claim, the same id is admitted at most once and another id is admitted. */
function expectAdmissionRecovered(home: DropHome, refused: string, at: number): void {
  expect(['claimed', 'duplicate']).toContain(home.claimDrop(refused, at));
  expect(home.claimDrop(refused, at + 1)).toBe('duplicate');
  expect(home.claimDrop(uuidv7(at + 2), at + 2)).toBe('claimed');
}

/** A home whose next claim is the first one after the upgrade of a format-2 store holding one live id. */
function legacyHome(root: string): string {
  const live = uuidv7(NOW);
  writeLegacyStore(root, { markers: [live], clock: NOW });
  return live;
}

/** A home whose journal carries enough expired records that the next claim compacts it; two ids are still live. */
function compactingHome(root: string): string[] {
  const live = idsAt(NOW, 2);
  writeJournalStore(root, NOW, [
    ...entries(idsAt(NOW - REPLAY_WINDOW_MS - 60_000, COMPACT_AFTER_DEAD), 'old peer', NOW - 60_000),
    ...entries(live, 'peer', NOW),
  ]);
  return live;
}

/** A home in quarantine (its format-2 markers were lost), whose next claim at QUARANTINE_END restarts it. */
function quarantinedHome(home: DropHome, root: string): string {
  const lost = legacyHome(root);
  rmSync(join(root, 'received-drops'), { recursive: true });
  expect(() => home.claimDrop(uuidv7(NOW + 1), NOW + 1)).toThrow('E_REPLAY_STATE missing markers');
  return lost;
}

describe('replay clock write failures', { timeout: DURABLE_WRITE_TIMEOUT_MS }, () => {
  it('does not accumulate temporary files when durable writes repeatedly fail', () => {
    withHome('drop-replay-fsync-', (home, root) => {
      fault.always = true;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(() => home.claimDrop(uuidv7(NOW + attempt), NOW + attempt)).toThrow('injected fsync failure');
      }
      expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
  });

  it('cuts off a record whose flush failed, so the refused id is admitted once and admission keeps working', () => {
    withHome('drop-replay-rollback-', (home, root) => {
      expect(home.claimDrop(uuidv7(NOW), NOW)).toBe('claimed');
      // A claim on an upgraded home makes one flush: its record. Break it.
      fault.calls = 0;
      fault.failOn.add(1);
      const refused = uuidv7(NOW + 1);
      expect(() => home.claimDrop(refused, NOW + 1)).toThrow('injected fsync failure');
      expect(journalIds(root)).not.toContain(refused);
      fault.failOn.clear();
      // A transient I/O error never bricks the store: the next request is admitted, the refused one was never consented.
      expect(home.claimDrop(uuidv7(NOW + 2), NOW + 2)).toBe('claimed');
      expect(home.claimDrop(refused, NOW + 3)).toBe('claimed');
      expect(home.claimDrop(refused, NOW + 4)).toBe('duplicate');
    });
  });

  it('admits with a single flush of the journal, without renaming, listing or flushing a folder', () => {
    withHome('drop-replay-cost-', (home, root) => {
      writeJournalStore(
        root,
        NOW,
        entries(idsAt(NOW, 16_000), 'many', NOW).map((entry, index) => ({
          ...entry,
          tag: index.toString(16).padStart(16, '2'),
        })),
      );
      expect(home.claimDrop(uuidv7(NOW), NOW)).toBe('claimed');
      for (let index = 1; index <= 3; index += 1) {
        Object.assign(fault, { calls: 0, dirSyncs: 0, renames: 0, listings: 0 });
        expect(home.claimDrop(uuidv7(NOW + index), NOW + index)).toBe('claimed');
        expect({
          syncs: fault.calls,
          dirSyncs: fault.dirSyncs,
          renames: fault.renames,
          listings: fault.listings,
        }).toEqual({ syncs: 1, dirSyncs: 0, renames: 0, listings: 0 });
      }
      expect(journalIds(root)).toHaveLength(16_004);
    });
  });

  /**
   * Breaks each sync of one claim in turn, on a home brought by `prepare` to the state under test (it returns the time
   * of the claim). The steps are counted on a fault-free claim from the same state, so every sync this platform makes
   * fails once, each refusal is the injected one, and no iteration runs without a fault.
   */
  function expectRecoveryAtEverySyncStep(
    prefix: string,
    prepare: (home: DropHome, root: string) => number,
    syncs: number,
  ): void {
    withHome(prefix, (home, root) => {
      const at = prepare(home, root);
      fault.calls = 0;
      expect(home.claimDrop(uuidv7(at), at)).toBe('claimed');
      expect(fault.calls).toBe(syncs);
    });
    for (let step = 1; step <= syncs; step += 1) {
      withHome(prefix, (home, root) => {
        const at = prepare(home, root);
        const dropId = uuidv7(at);
        fault.calls = 0;
        fault.failOn.add(step);
        expect(() => home.claimDrop(dropId, at), `sync ${String(step)}`).toThrow('injected fsync failure');
        fault.failOn.clear();
        expectAdmissionRecovered(home, dropId, at + 10);
      });
    }
  }

  it('keeps admitting after a transient sync failure at any step of a claim that compacts the journal', () => {
    expectRecoveryAtEverySyncStep(
      'drop-replay-compact-fault-',
      (_home, root) => {
        compactingHome(root);
        return NOW + 1;
      },
      COMPACTING_CLAIM_SYNCS,
    );
  });

  it('keeps admitting after a transient sync failure at any step of the first claim on a fresh home', () => {
    expectRecoveryAtEverySyncStep('drop-replay-fresh-fault-', () => NOW, FIRST_CLAIM_SYNCS);
  });

  it('keeps admitting after a transient sync failure at any step of the upgrade of a format-2 store', () => {
    expectRecoveryAtEverySyncStep(
      'drop-replay-upgrade-fault-',
      (_home, root) => {
        legacyHome(root);
        return NOW + 1;
      },
      FIRST_CLAIM_SYNCS,
    );
  });

  it('keeps admitting after a transient sync failure at any step of the restart after a quarantine', () => {
    expectRecoveryAtEverySyncStep(
      'drop-replay-restart-fault-',
      (home, root) => {
        quarantinedHome(home, root);
        return QUARANTINE_END;
      },
      RESTART_CLAIM_SYNCS,
    );
  });
});

interface CrashState {
  /** Time of the claim the crash interrupts. */
  at: number;
  /** Ids admitted before: they must stay refused as duplicates. */
  admitted: string[];
  /** Ids of a lost state: they must stay refused as expired. */
  expired?: string[];
}

/**
 * Stops the process at each mutating filesystem call of one claim in turn (counted on a crash-free run from the same
 * state), then restarts on the same files: every id admitted before stays refused, the interrupted id is admitted at
 * most once, and admission resumes at once, without quarantine or manual repair.
 */
function expectRecoveryAtEveryCrashPoint(prefix: string, prepare: (home: DropHome, root: string) => CrashState): void {
  fault.realSync = false;
  let points = 0;
  withHome(prefix, (home, root) => {
    const { at } = prepare(home, root);
    fault.counting = true;
    expect(home.claimDrop(uuidv7(at), at)).toBe('claimed');
    points = fault.ops;
    fault.counting = false;
  });
  expect(points).toBeGreaterThan(5);
  for (let point = 1; point <= points; point += 1) {
    withHome(prefix, (home, root) => {
      const { at, admitted, expired = [] } = prepare(home, root);
      const dropId = uuidv7(at);
      Object.assign(fault, { counting: true, ops: 0, crashAt: point });
      expect(() => home.claimDrop(dropId, at), `crash ${String(point)}`).toThrow();
      Object.assign(fault, { counting: false, ops: 0, crashAt: 0, dead: false });
      const restarted = new DropHome(root);
      const later = at + 10;
      for (const id of admitted) expect(restarted.claimDrop(id, later), `crash ${String(point)}`).toBe('duplicate');
      for (const id of expired) expect(restarted.claimDrop(id, later), `crash ${String(point)}`).toBe('expired');
      expectAdmissionRecovered(restarted, dropId, later);
    });
  }
}

describe('replay store crash points', { timeout: 60_000 }, () => {
  it('recovers from a crash at any point of an ordinary claim', () => {
    expectRecoveryAtEveryCrashPoint('drop-replay-crash-append-', (home) => {
      const admitted = [uuidv7(NOW), uuidv7(NOW + 1)];
      for (const id of admitted) expect(home.claimDrop(id, NOW + 1)).toBe('claimed');
      return { at: NOW + 2, admitted };
    });
  });

  it('recovers from a crash at any point of a claim that compacts the journal', () => {
    expectRecoveryAtEveryCrashPoint('drop-replay-crash-compact-', (_home, root) => ({
      at: NOW + 1,
      admitted: compactingHome(root),
    }));
  });

  it('recovers from a crash at any point of the first claim on a fresh home', () => {
    expectRecoveryAtEveryCrashPoint('drop-replay-crash-fresh-', () => ({ at: NOW, admitted: [] }));
  });

  it('recovers from a crash at any point of the upgrade of a format-2 store', () => {
    expectRecoveryAtEveryCrashPoint('drop-replay-crash-upgrade-', (_home, root) => ({
      at: NOW + 1,
      admitted: [legacyHome(root)],
    }));
  });

  it('recovers from a crash at any point of the restart after a quarantine', () => {
    expectRecoveryAtEveryCrashPoint('drop-replay-crash-restart-', (home, root) => ({
      at: QUARANTINE_END,
      admitted: [],
      expired: [quarantinedHome(home, root)],
    }));
  });

  it('keeps the compacted journal as the only valid one', () => {
    withHome('drop-replay-crash-single-', (home, root) => {
      compactingHome(root);
      expect(home.claimDrop(uuidv7(NOW + 1), NOW + 1)).toBe('claimed');
      expect(inspectReplayJournal(root)).toMatchObject({ journal: 'received-drops-b.journal', gen: 2 });
      expect(journalIds(root)).toHaveLength(3);
    });
  });
});
