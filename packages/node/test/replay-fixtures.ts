import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPLAY_WINDOW_MS, sha256Hex, uuidv7, uuidv7Timestamp } from '@drop/protocol';
import {
  encodeReplayJournal,
  inspectReplayJournal,
  REPLAY_JOURNALS,
  replayPeerTag,
  type ReplayEntry,
} from '../src/replay-store.ts';

/** A test clock: 2026-10-08, well inside the 48-bit range. */
export const NOW = 1_791_460_000_000;

/** `count` distinct UUIDv7 ids sharing the timestamp of `at`. */
export function idsAt(at: number, count: number): string[] {
  const prefix = uuidv7(at).slice(0, 24);
  return Array.from({ length: count }, (_, index) => `${prefix}${(index + 1).toString(16).padStart(12, '0')}`);
}

/**
 * Writes a format-2 store as T3.1b left it: one empty file per id, the clock, the version and (for version 2) the
 * floored digest of the live ids. `digest: false` leaves the digest out, `version: '1'` writes the pre-digest format.
 */
export function writeLegacyStore(
  root: string,
  options: { markers: string[]; clock: number; version?: '1' | '2'; digest?: boolean },
): void {
  const dir = join(root, 'received-drops');
  mkdirSync(dir, { recursive: true });
  for (const name of options.markers) writeFileSync(join(dir, name), '');
  writeFileSync(join(root, 'received-drops-clock'), `${String(options.clock)}\n`);
  const version = options.version ?? '2';
  writeFileSync(join(root, 'received-drops-version'), `${version}\n`);
  if (version === '2' && options.digest !== false) {
    const floor = options.clock - REPLAY_WINDOW_MS;
    const live = options.markers.flatMap((name) => {
      const time = uuidv7Timestamp(name);
      return time !== undefined && time >= floor ? [name.toLowerCase()] : [];
    });
    writeFileSync(join(root, 'received-drops-integrity'), `${String(floor)} ${sha256Hex([...new Set(live)].sort())}\n`);
  }
}

/** Entries for `ids` sent by `peer`, admitted at `at`. */
export function entries(ids: string[], peer: string, at: number): ReplayEntry[] {
  return ids.map((id) => ({ id, tag: replayPeerTag(peer), time: uuidv7Timestamp(id) ?? 0, at }));
}

/** Writes a format-3 store directly: journal A with these entries, journal B empty, version 3. */
export function writeJournalStore(root: string, hw: number, records: ReplayEntry[], gen = 1): void {
  writeFileSync(join(root, REPLAY_JOURNALS[0]), encodeReplayJournal(gen, hw, records), { mode: 0o600 });
  writeFileSync(join(root, REPLAY_JOURNALS[1]), '', { mode: 0o600 });
  writeFileSync(join(root, 'received-drops-version'), '3\n', { mode: 0o600 });
}

/** The ids of the valid journal, in file order. */
export function journalIds(root: string): string[] {
  return inspectReplayJournal(root)?.entries.map((entry) => entry.id) ?? [];
}
