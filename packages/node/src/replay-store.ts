/**
 * The durable anti-replay store of received drop ids (T3.1b, T3.1e): a request id is admitted at most once, across
 * restarts, crashes, clock rollback and several processes sharing one DROP_HOME.
 *
 * Format 3 (T3.1e) keeps the ids in two journal files, `received-drops-a.journal` and `received-drops-b.journal`,
 * created once. A journal is a header (generation, high-water clock, body size and SHA-256) followed by fixed-size
 * records `<uuidv7> <peer tag> <admission time>`. The active journal is the valid one with the higher generation.
 *
 * - Admission appends one record to the active journal and flushes that file (fsync, FlushFileBuffers on Windows)
 *   before it returns: no rename and no directory change, so a power cut cannot undo an admission the caller saw,
 *   on Windows too, where a directory cannot be flushed.
 * - Compaction rewrites the inactive journal with the live records, the new one and generation + 1, then flushes it.
 *   Until that flush the old journal stays the valid one; a torn rewrite fails its checksum and is ignored.
 * - An in-memory index (ids, per-peer counts, expiry heap) answers each claim; under the lock, the headers and size
 *   of both journals prove it current, or it is reloaded. A claim costs one flush, whatever the number of ids.
 * - A torn record at the end of the journal is one whose flush never returned, so it was never admitted: it is cut.
 *   Anything else that does not add up (missing or corrupt journal, version, legacy markers) is a loss of state: the
 *   store refuses every admission for a full replay window plus clock skew, then starts afresh with a floor past
 *   every id it could have admitted before (quarantine).
 * - Claims are serialized by a lock file created atomically with its owner record. A lock whose owner is provably
 *   dead (same host and boot, process gone) is taken over through a guard; any other lock is never taken.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname, uptime } from 'node:os';
import { join } from 'node:path';
import { MAX_CLOCK_SKEW_MS, REPLAY_WINDOW_MS, sha256Hex, uuidv7Timestamp } from '@drop/protocol';
import { errorCode, syncDirectory, writeDurablePrivate } from './durable.ts';
import type { DropClaim } from './engine.ts';

/** Live ids kept at most, all peers together (T3.1b). */
export const MAX_RECEIVED_DROPS = 16_384;
/** Live ids one peer may hold (T3.1e): one paired peer cannot fill the store and lock the others out. */
export const MAX_RECEIVED_DROPS_PER_PEER = 1_024;
/** Expired records a journal may carry before the next admission compacts it into the other journal. */
export const COMPACT_AFTER_DEAD = 4_096;
/** Peer tag of ids migrated from format 2, which did not record their sender: counted globally, never per peer. */
export const LEGACY_PEER_TAG = '0'.repeat(16);
export const REPLAY_JOURNALS = ['received-drops-a.journal', 'received-drops-b.journal'] as const;

const VERSION_FILE = 'received-drops-version';
const UPGRADING_FILE = 'received-drops-upgrading';
const QUARANTINE_FILE = 'received-drops-quarantine';
const LOCK_FILE = 'received-drops.lock';
const LEGACY_DIR = 'received-drops';
const LEGACY_CLOCK = 'received-drops-clock';
const LEGACY_INTEGRITY = 'received-drops-integrity';
const LEGACY_MIGRATING = 'received-drops-migrating';

const HEADER_BYTES = 114;
const RECORD_BYTES = 67;
const HEADER = /^drop-replay 3 ([0-9a-f]{12}) ([0-9a-f]{12}) ([0-9a-f]{8}) ([0-9a-f]{64})\n$/;
const RECORD = /^([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) ([0-9a-f]{16}) ([0-9a-f]{12})\n$/;
/** Times are written on 48 bits, like the UUIDv7 timestamp. */
const MAX_TIME = 2 ** 48 - 1;

/** One admitted id: its UUIDv7 time, who sent it (tag) and the store clock when it was admitted. */
export interface ReplayEntry {
  id: string;
  tag: string;
  time: number;
  at: number;
}

/** The state on disk does not add up: the store must not admit again before a full window has passed. */
class ReplayStateLoss extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`E_REPLAY_STATE ${reason}`);
    this.reason = reason;
  }
}

const hex = (value: number, width: number): string => value.toString(16).padStart(width, '0');

/** The tag a peer's ids are counted under: a hash, so the journal never names the peer. */
export function replayPeerTag(peer: string): string {
  return createHash('sha256').update(`drop-replay-peer|${peer}`).digest('hex').slice(0, 16);
}

function encodeRecord(entry: ReplayEntry): string {
  return `${entry.id} ${entry.tag} ${hex(entry.at, 12)}\n`;
}

/** A whole journal: header then body. Exported for tests that build a store in a given state. */
export function encodeReplayJournal(gen: number, hw: number, entries: readonly ReplayEntry[]): Buffer {
  const body = entries.map(encodeRecord).join('');
  const digest = createHash('sha256').update(body, 'latin1').digest('hex');
  return Buffer.from(`drop-replay 3 ${hex(gen, 12)} ${hex(hw, 12)} ${hex(entries.length, 8)} ${digest}\n${body}`, 'latin1');
}

function parseRecord(text: string): ReplayEntry | undefined {
  const match = RECORD.exec(text);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const time = uuidv7Timestamp(match[1]);
  if (time === undefined) return undefined;
  return { id: match[1], tag: match[2], time, at: Number.parseInt(match[3], 16) };
}

interface Journal {
  gen: number;
  hw: number;
  header: string;
  entries: ReplayEntry[];
  /** Bytes up to the last whole valid record; the rest is a torn append. */
  validBytes: number;
  size: number;
}

/** A valid journal, or undefined when its header or body does not check (never written whole). */
function parseJournal(bytes: Buffer): Journal | undefined {
  if (bytes.length < HEADER_BYTES) return undefined;
  const header = bytes.toString('latin1', 0, HEADER_BYTES);
  const match = HEADER.exec(header);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return undefined;
  const count = Number.parseInt(match[3], 16);
  const bodyEnd = HEADER_BYTES + count * RECORD_BYTES;
  if (bytes.length < bodyEnd) return undefined;
  if (createHash('sha256').update(bytes.subarray(HEADER_BYTES, bodyEnd)).digest('hex') !== match[4]) return undefined;
  const entries: ReplayEntry[] = [];
  for (let offset = HEADER_BYTES; offset < bodyEnd; offset += RECORD_BYTES) {
    const entry = parseRecord(bytes.toString('latin1', offset, offset + RECORD_BYTES));
    if (!entry) return undefined;
    entries.push(entry);
  }
  let offset = bodyEnd;
  for (; offset + RECORD_BYTES <= bytes.length; offset += RECORD_BYTES) {
    const entry = parseRecord(bytes.toString('latin1', offset, offset + RECORD_BYTES));
    if (!entry) break;
    entries.push(entry);
  }
  // Records are appended one at a time, each flushed before the next: only the last can be torn. A valid record after
  // an invalid one is damage, not a torn append.
  for (let later = offset + RECORD_BYTES; later + RECORD_BYTES <= bytes.length; later += RECORD_BYTES) {
    if (parseRecord(bytes.toString('latin1', later, later + RECORD_BYTES)))
      throw new ReplayStateLoss('corrupt journal');
  }
  return {
    gen: Number.parseInt(match[1], 16),
    hw: Number.parseInt(match[2], 16),
    header,
    entries,
    validBytes: offset,
    size: bytes.length,
  };
}

/** Live ids by UUIDv7 time, with per-peer counts; ids expire as the floor rises. */
class ReplayIndex {
  readonly live = new Map<string, ReplayEntry>();
  private readonly heap: ReplayEntry[] = [];
  private readonly perPeer = new Map<string, number>();
  /** Records in the active journal that are no longer live. */
  dead = 0;
  hw = 0;

  add(entry: ReplayEntry): void {
    this.hw = Math.max(this.hw, entry.at);
    if (this.live.has(entry.id) || entry.time < this.hw - REPLAY_WINDOW_MS) {
      this.dead += 1;
      return;
    }
    this.live.set(entry.id, entry);
    this.perPeer.set(entry.tag, (this.perPeer.get(entry.tag) ?? 0) + 1);
    this.heap.push(entry);
    let child = this.heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      const [up, down] = [this.heap[child], this.heap[parent]];
      if (!up || !down || down.time <= up.time) break;
      this.heap[child] = down;
      this.heap[parent] = up;
      child = parent;
    }
  }

  /** Raises the clock (never lowers it) and retires the ids below the new floor. */
  advance(now: number): void {
    this.hw = Math.max(this.hw, now);
    const floor = this.hw - REPLAY_WINDOW_MS;
    for (let top = this.heap[0]; top && top.time < floor; top = this.heap[0]) {
      this.pop();
      this.live.delete(top.id);
      const count = (this.perPeer.get(top.tag) ?? 1) - 1;
      if (count > 0) this.perPeer.set(top.tag, count);
      else this.perPeer.delete(top.tag);
      this.dead += 1;
    }
  }

  peerCount(tag: string): number {
    return this.perPeer.get(tag) ?? 0;
  }

  private pop(): void {
    const last = this.heap.pop();
    if (!last || this.heap.length === 0) return;
    this.heap[0] = last;
    let parent = 0;
    for (;;) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let smallest = parent;
      const at = (index: number): number => this.heap[index]?.time ?? Number.POSITIVE_INFINITY;
      if (at(left) < at(smallest)) smallest = left;
      if (at(right) < at(smallest)) smallest = right;
      if (smallest === parent) return;
      const [a, b] = [this.heap[parent], this.heap[smallest]];
      if (!a || !b) return;
      this.heap[parent] = b;
      this.heap[smallest] = a;
      parent = smallest;
    }
  }
}

interface Probe {
  header: string | undefined;
  size: number;
}

interface Cache {
  index: ReplayIndex;
  active: 0 | 1;
  gen: number;
  probes: [Probe, Probe];
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function readBytes(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/** The first bytes and the size of a journal, without reading it whole. */
function probe(path: string): Probe {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { header: undefined, size: -1 };
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(HEADER_BYTES, size));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return { header: read === HEADER_BYTES ? buffer.toString('latin1') : undefined, size };
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, bytes: Buffer, position: number): void {
  for (let done = 0; done < bytes.length; ) {
    const written = writeSync(fd, bytes, done, bytes.length - done, position + done);
    if (written <= 0) throw new Error('E_REPLAY_STATE short write');
    done += written;
  }
}

// ---- legacy format 2 (T3.1b): one empty file per id, a clock, a version and a digest -----------------------------

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_MARKER =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|0{8}-0{4}-0{4}-0{4}-0{12}|f{8}-f{4}-f{4}-f{4}-f{12})$/i;
const FLOORED_DIGEST = /^(-?(?:0|[1-9][0-9]*)) ([0-9a-f]{64})\n$/;

function floorDigest(floor: number, names: Iterable<string>): string {
  return `${String(floor)} ${sha256Hex([...new Set(names)].sort())}\n`;
}

/** What the marker directory must hash to for a format-2 digest: by its floor, or every name before floors. */
function expectedDigest(stored: string, markerNames: string[]): string {
  const floored = FLOORED_DIGEST.exec(stored);
  if (!floored) return `${sha256Hex([...markerNames].sort())}\n`;
  const floor = Number(floored[1]);
  const live = markerNames.flatMap((name) => {
    const time = uuidv7Timestamp(name);
    return time !== undefined && time >= floor ? [name.toLowerCase()] : [];
  });
  return floorDigest(floor, live);
}

/**
 * Reads a format-1 or format-2 store (or nothing, on a fresh home) without changing it, with every check T3.1b made
 * before admitting: the live ids it holds and its high-water clock. An inconsistency is a loss of state.
 */
function readLegacy(root: string, version: string | undefined, now: number): { entries: ReplayEntry[]; hw: number } {
  const dir = join(root, LEGACY_DIR);
  const clockText = readText(join(root, LEGACY_CLOCK));
  const integrity = readText(join(root, LEGACY_INTEGRITY));
  const migrating = version === undefined && existsSync(join(root, LEGACY_MIGRATING));
  if (version === undefined && !migrating && (clockText !== undefined || integrity !== undefined))
    throw new ReplayStateLoss('missing version');
  const dirExists = existsSync(dir);
  if (!dirExists && (clockText !== undefined || version !== undefined)) throw new ReplayStateLoss('missing markers');
  if (version !== undefined && clockText === undefined) throw new ReplayStateLoss('missing clock');
  const digest = migrating ? undefined : integrity;
  if (version === '2\n' && digest === undefined) throw new ReplayStateLoss('missing integrity');
  let hw = now;
  if (clockText !== undefined) {
    const raw = clockText.trim();
    if (!/^(0|[1-9][0-9]*)$/.test(raw) || Number(raw) > MAX_TIME) throw new ReplayStateLoss('corrupt clock');
    hw = Math.max(hw, Number(raw));
  }
  const floor = hw - REPLAY_WINDOW_MS;
  const entries = dirExists ? readdirSync(dir, { withFileTypes: true }) : [];
  const markers = entries.filter((entry) => UUID_SHAPE.test(entry.name));
  if (digest !== undefined && digest !== expectedDigest(digest, markers.map((entry) => entry.name)))
    throw new ReplayStateLoss('marker integrity');
  const live = new Map<string, ReplayEntry>();
  for (const entry of markers) {
    // Finder, backup and sync tools may drop their own files there; only UUID-shaped names are markers.
    if (!entry.isFile()) throw new ReplayStateLoss('unexpected marker');
    const time = uuidv7Timestamp(entry.name);
    if (time === undefined) {
      // Ids from before T3.1b (any UUID, nil and max included) can no longer be sent: they are dropped.
      if (!LEGACY_MARKER.test(entry.name)) throw new ReplayStateLoss('unexpected marker');
      continue;
    }
    const id = entry.name.toLowerCase();
    if (time >= floor) live.set(id, { id, tag: LEGACY_PEER_TAG, time, at: hw });
  }
  return { entries: [...live.values()], hw };
}

// ---- lock ---------------------------------------------------------------------------------------------------------

/** This boot of this kernel, and on Linux this PID namespace: where a PID names one process. */
function currentBoot(): string {
  if (process.platform === 'linux') {
    try {
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const namespace = readlinkSync('/proc/self/ns/pid');
      if (/^[0-9a-f-]{36}$/.test(boot) && /^pid:\[[0-9]+\]$/.test(namespace)) return `linux:${boot}:${namespace}`;
    } catch {
      // No procfs: fall back to the boot time below.
    }
  }
  return `t:${String(Math.round(Date.now() / 1000 - uptime()))}`;
}

function sameBoot(owner: string, current: string): boolean {
  if (owner.startsWith('linux:') || current.startsWith('linux:')) return owner === current;
  const [a, b] = [Number(owner.slice(2)), Number(current.slice(2))];
  // Boot time read from the wall clock moves when the clock is set: a mismatch only keeps the lock.
  return owner.startsWith('t:') && Number.isSafeInteger(a) && Number.isSafeInteger(b) && Math.abs(a - b) <= 2;
}

const HOST_TAG = createHash('sha256').update(`drop-replay-host|${hostname()}`).digest('hex').slice(0, 16);
const LOCK_NONCE = randomBytes(8).toString('hex');
const OWNER = /^drop-replay-lock 3 ([1-9][0-9]*) ([0-9a-f]{16}) ([0-9a-f]{16}) (\S+)\n$/;

/** The owner record of a lock: process, nonce, hashed host name and boot. Exported for tests. */
export function replayLockOwner(pid: number, nonce: string, boot: string = currentBoot()): string {
  return `drop-replay-lock 3 ${String(pid)} ${nonce} ${HOST_TAG} ${boot}\n`;
}

/** Names this process in the replay lock; a lock carrying it is our own leftover, since claims are synchronous. */
export const REPLAY_LOCK_OWNER = replayLockOwner(process.pid, LOCK_NONCE);

/**
 * Whether the owner of a lock is certainly gone: a record of this format, from this host, this boot (and PID
 * namespace on Linux), whose process no longer exists. A PID reused since, a legacy or unreadable record, another
 * host or another boot all keep the lock: an active claim is never interrupted.
 */
function ownerIsDead(record: string): boolean {
  const match = OWNER.exec(record);
  if (!match?.[1] || !match[3] || !match[4]) return false;
  if (match[3] !== HOST_TAG || !sameBoot(match[4], currentBoot())) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === 'ESRCH';
  }
}

/** Creates `path` holding our owner record, atomically: a hard link of a private temporary file. */
function createOwned(path: string): boolean {
  const temporary = `${path}.${LOCK_NONCE}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, REPLAY_LOCK_OWNER, { mode: 0o600, flag: 'wx' });
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw new Error('E_REPLAY_STATE storage unavailable', { cause: error });
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readOwner(path: string): string | undefined | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    // Gone: free. A directory (the T3.1b lock) or an unreadable file: unknown, so never taken.
    return errorCode(error) === 'ENOENT' ? undefined : null;
  }
}

function removeIfOwn(path: string): void {
  if (readOwner(path) === REPLAY_LOCK_OWNER) unlinkSync(path);
}

/**
 * Removes the lock or guard at `path` if its owner is this process (a leftover) or provably dead. Two processes may
 * find the same dead owner: only the one holding the guard named after that owner record removes it, after reading it
 * again, so a lock taken meanwhile by a live process is never removed. A guard left by a dead taker is itself taken
 * over the same way, at most twice deep.
 */
function removeDeadOwner(path: string, depth: number): boolean {
  const record = readOwner(path);
  if (record === undefined) return true;
  if (record === null) return false;
  if (record === REPLAY_LOCK_OWNER) {
    unlinkSync(path);
    return true;
  }
  if (!ownerIsDead(record)) return false;
  const guard = `${path}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`;
  if (!createOwned(guard) && !(depth < 2 && removeDeadOwner(guard, depth + 1) && createOwned(guard))) return false;
  try {
    if (readOwner(path) === record) rmSync(path, { force: true });
    return true;
  } finally {
    removeIfOwn(guard);
  }
}

function acquireLock(root: string): void {
  const lock = join(root, LOCK_FILE);
  if (createOwned(lock)) return;
  if (!removeDeadOwner(lock, 0) || !createOwned(lock)) throw new Error('E_REPLAY_STATE claim locked');
}

/** Never removes a lock another process has since taken over. */
function releaseLock(root: string): void {
  removeIfOwn(join(root, LOCK_FILE));
}

/** Temporary files of lock creations that a crash left behind; a live one only makes its claim fail closed. */
function removeLockLeftovers(root: string): void {
  for (const name of readdirSync(root)) {
    if (name.startsWith(`${LOCK_FILE}.`) && name.endsWith('.tmp')) rmSync(join(root, name), { force: true });
  }
}

// ---- the store ----------------------------------------------------------------------------------------------------

export class ReplayStore {
  private readonly root: string;
  private cache: Cache | undefined;

  constructor(root: string) {
    this.root = root;
  }

  claim(dropId: string, now: number, peer: string): DropClaim {
    const timestamp = uuidv7Timestamp(dropId);
    if (timestamp === undefined || !Number.isSafeInteger(now) || now < 0 || now > MAX_TIME) return 'expired';
    const id = dropId.toLowerCase();
    acquireLock(this.root);
    try {
      return this.claimLocked(id, replayPeerTag(peer), timestamp, now);
    } catch (error) {
      // Whatever failed, the next claim reads the journals again rather than trusting this copy.
      this.cache = undefined;
      throw error;
    } finally {
      releaseLock(this.root);
    }
  }

  private path(name: string): string {
    return join(this.root, name);
  }

  private claimLocked(id: string, tag: string, timestamp: number, now: number): DropClaim {
    this.leaveQuarantine(now);
    let cache: Cache;
    try {
      cache = this.current(now);
    } catch (error) {
      if (error instanceof ReplayStateLoss) this.enterQuarantine(now, error);
      throw error;
    }
    const { index } = cache;
    index.advance(now);
    if (timestamp < index.hw - REPLAY_WINDOW_MS || timestamp > index.hw + MAX_CLOCK_SKEW_MS) return 'expired';
    if (index.live.has(id)) return 'duplicate';
    if (index.live.size >= MAX_RECEIVED_DROPS) return 'capacity';
    if (tag !== LEGACY_PEER_TAG && index.peerCount(tag) >= MAX_RECEIVED_DROPS_PER_PEER) return 'peer_quota';
    const entry: ReplayEntry = { id, tag, time: timestamp, at: index.hw };
    if (index.dead >= COMPACT_AFTER_DEAD) this.compact(cache, entry);
    else this.append(cache, entry);
    return 'claimed';
  }

  /** The index, proven current by both journal headers and the active size, or read again from disk. */
  private current(now: number): Cache {
    const cache = this.cache;
    if (cache) {
      const probes: [Probe, Probe] = [probe(this.path(REPLAY_JOURNALS[0])), probe(this.path(REPLAY_JOURNALS[1]))];
      const known = cache.probes;
      const other = cache.active === 0 ? 1 : 0;
      const [seen, before] = [probes[cache.active], known[cache.active]];
      if (
        probes[other].header === known[other].header &&
        probes[other].size === known[other].size &&
        seen.header === before.header
      ) {
        if (seen.size === before.size) return cache;
        // Another process appended: read only its records.
        if (seen.size > before.size && (seen.size - before.size) % RECORD_BYTES === 0 && this.readTail(cache, seen.size))
          return cache;
      }
      this.cache = undefined;
    }
    const version = readText(this.path(VERSION_FILE));
    let loaded: Cache;
    if (version === '3\n') {
      loaded = this.load();
      this.removeUpgradeLeftovers();
    } else if (version === undefined || version === '1\n' || version === '2\n') {
      loaded = this.upgrade(version, now);
    } else {
      throw new ReplayStateLoss('corrupt version');
    }
    this.cache = loaded;
    return loaded;
  }

  private readTail(cache: Cache, size: number): boolean {
    const known = cache.probes[cache.active].size;
    const fd = openSync(this.path(REPLAY_JOURNALS[cache.active]), 'r');
    try {
      const bytes = Buffer.alloc(size - known);
      if (readSync(fd, bytes, 0, bytes.length, known) !== bytes.length) return false;
      const entries: ReplayEntry[] = [];
      for (let offset = 0; offset < bytes.length; offset += RECORD_BYTES) {
        const entry = parseRecord(bytes.toString('latin1', offset, offset + RECORD_BYTES));
        if (!entry) return false;
        entries.push(entry);
      }
      for (const entry of entries) cache.index.add(entry);
      cache.probes[cache.active] = { header: cache.probes[cache.active].header, size };
      return true;
    } finally {
      closeSync(fd);
    }
  }

  /** Both journals as found: valid ones parsed, the active one the higher generation. */
  private journals(): { parsed: [Journal | undefined, Journal | undefined]; active: 0 | 1 | undefined } {
    const parsed: [Journal | undefined, Journal | undefined] = [undefined, undefined];
    for (const index of [0, 1] as const) {
      const bytes = readBytes(this.path(REPLAY_JOURNALS[index]));
      parsed[index] = bytes ? parseJournal(bytes) : undefined;
    }
    const [a, b] = parsed;
    if (a && b && a.gen === b.gen) throw new ReplayStateLoss('corrupt journal');
    const active = a && (!b || a.gen > b.gen) ? 0 : b ? 1 : undefined;
    return { parsed, active };
  }

  /** Reads format 3 from disk, cutting a torn last record, which no admission ever returned for. */
  private load(): Cache {
    const { parsed, active } = this.journals();
    const journal = active === undefined ? undefined : parsed[active];
    if (active === undefined || !journal) throw new ReplayStateLoss('missing journal');
    if (journal.validBytes < journal.size) {
      const fd = openSync(this.path(REPLAY_JOURNALS[active]), 'r+');
      try {
        ftruncateSync(fd, journal.validBytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    const index = new ReplayIndex();
    index.hw = journal.hw;
    for (const entry of journal.entries) index.add(entry);
    const other = active === 0 ? 1 : 0;
    const probes: [Probe, Probe] = [
      { header: undefined, size: -1 },
      { header: undefined, size: -1 },
    ];
    probes[active] = { header: journal.header, size: journal.validBytes };
    probes[other] = probe(this.path(REPLAY_JOURNALS[other]));
    return { index, active, gen: journal.gen, probes };
  }

  /**
   * First admission of a fresh home, or of a format-1/2 home: its live ids, and those of any journal an interrupted
   * upgrade left, go into journal A with a generation above any found; journal B is emptied; then version 3 is made
   * durable and only then the legacy files are removed. The marker written first and removed last lets an interrupted
   * upgrade start again; without it, journals and no version mean that the version was lost.
   */
  private upgrade(version: string | undefined, now: number): Cache {
    const upgrading = existsSync(this.path(UPGRADING_FILE));
    const { parsed } = this.journals();
    const found = parsed.filter((journal): journal is Journal => journal !== undefined);
    if (version === undefined && !upgrading && found.length > 0) throw new ReplayStateLoss('missing version');
    const legacy = readLegacy(this.root, version, now);
    if (!upgrading) writeDurablePrivate(this.path(UPGRADING_FILE), '');
    // Union only: an id in any of them stays refused.
    const entries = [...legacy.entries, ...found.flatMap((journal) => journal.entries)];
    const hw = Math.max(legacy.hw, ...found.map((journal) => journal.hw), ...entries.map((entry) => entry.at));
    const gen = Math.max(0, ...found.map((journal) => journal.gen)) + 1;
    const cache = this.writeFresh(gen, hw, entries);
    writeDurablePrivate(this.path(VERSION_FILE), '3\n');
    this.removeUpgradeLeftovers();
    return cache;
  }

  /** Writes journal A with the live entries and empties journal B, both flushed, then flushes their folder. */
  private writeFresh(gen: number, hw: number, entries: readonly ReplayEntry[]): Cache {
    const index = new ReplayIndex();
    index.hw = hw;
    for (const entry of entries) index.add(entry);
    const live = [...index.live.values()];
    index.dead = 0;
    const bytes = encodeReplayJournal(gen, hw, live);
    for (const [name, content] of [
      [REPLAY_JOURNALS[0], bytes],
      [REPLAY_JOURNALS[1], Buffer.alloc(0)],
    ] as const) {
      const fd = openSync(this.path(name), 'w', 0o600);
      try {
        writeAll(fd, content, 0);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    syncDirectory(this.root);
    return {
      index,
      active: 0,
      gen,
      probes: [
        { header: bytes.toString('latin1', 0, HEADER_BYTES), size: bytes.length },
        { header: undefined, size: 0 },
      ],
    };
  }

  /** Removes what an upgrade or a reset leaves once version 3 is durable: legacy files and the upgrade marker. */
  private removeUpgradeLeftovers(): void {
    const legacy = [LEGACY_DIR, LEGACY_CLOCK, LEGACY_INTEGRITY, LEGACY_MIGRATING, UPGRADING_FILE];
    if (!legacy.some((name) => existsSync(this.path(name)))) return;
    // The marker goes last: until then a crash restarts the upgrade from the same files.
    for (const name of legacy) rmSync(this.path(name), { recursive: true, force: true });
    removeLockLeftovers(this.root);
    syncDirectory(this.root);
  }

  /** Appends one record to the active journal and flushes it; on failure, cuts it off again before refusing. */
  private append(cache: Cache, entry: ReplayEntry): void {
    const offset = cache.probes[cache.active].size;
    const bytes = Buffer.from(encodeRecord(entry), 'latin1');
    const fd = openSync(this.path(REPLAY_JOURNALS[cache.active]), 'r+');
    try {
      try {
        writeAll(fd, bytes, offset);
        fsyncSync(fd);
      } catch (error) {
        this.rollBack(fd, offset, error);
        throw error;
      }
    } finally {
      closeSync(fd);
    }
    cache.probes[cache.active] = { header: cache.probes[cache.active].header, size: offset + RECORD_BYTES };
    cache.index.add(entry);
  }

  /**
   * Rewrites the inactive journal with the live ids, the new one and the next generation. Until its flush returns, the
   * active journal stays the valid one; on failure the rewrite is cut to nothing, so it can never become active.
   */
  private compact(cache: Cache, entry: ReplayEntry): void {
    const target = cache.active === 0 ? 1 : 0;
    const { index } = cache;
    const entries = [...index.live.values(), entry];
    const gen = cache.gen + 1;
    const bytes = encodeReplayJournal(gen, index.hw, entries);
    const path = this.path(REPLAY_JOURNALS[target]);
    let created = false;
    let fd: number;
    try {
      fd = openSync(path, 'r+');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      fd = openSync(path, 'wx', 0o600);
      created = true;
    }
    try {
      try {
        writeAll(fd, bytes, 0);
        ftruncateSync(fd, bytes.length);
        fsyncSync(fd);
      } catch (error) {
        this.rollBack(fd, 0, error);
        throw error;
      }
    } finally {
      closeSync(fd);
    }
    // A journal lost since the upgrade is created again: its name must be durable before the admission returns.
    if (created) syncDirectory(this.root);
    removeLockLeftovers(this.root);
    const next = new ReplayIndex();
    next.hw = index.hw;
    for (const live of entries) next.add(live);
    cache.index = next;
    cache.active = target;
    cache.gen = gen;
    cache.probes[target] = { header: bytes.toString('latin1', 0, HEADER_BYTES), size: bytes.length };
  }

  private rollBack(fd: number, size: number, cause: unknown): void {
    try {
      ftruncateSync(fd, size);
      fsyncSync(fd);
    } catch (rollbackError) {
      throw new AggregateError([cause, rollbackError], 'E_REPLAY_STATE claim rollback failed', { cause: rollbackError });
    }
  }

  /** The highest store clock any surviving file shows: a lost state cannot have admitted anything after it. */
  private evidence(): number {
    let hw = 0;
    try {
      const clock = Number(readText(this.path(LEGACY_CLOCK))?.trim());
      if (Number.isSafeInteger(clock)) hw = Math.max(hw, clock);
    } catch {
      // Best effort: an unreadable file adds nothing.
    }
    for (const name of REPLAY_JOURNALS) {
      try {
        const bytes = readBytes(this.path(name));
        if (!bytes) continue;
        const header = HEADER.exec(bytes.toString('latin1', 0, HEADER_BYTES));
        if (header?.[2]) hw = Math.max(hw, Number.parseInt(header[2], 16));
        for (let offset = HEADER_BYTES; offset + RECORD_BYTES <= bytes.length; offset += RECORD_BYTES) {
          const entry = parseRecord(bytes.toString('latin1', offset, offset + RECORD_BYTES));
          if (entry) hw = Math.max(hw, entry.at);
        }
      } catch {
        // Best effort, as above.
      }
    }
    return hw;
  }

  /**
   * The state was lost or damaged: refuse until every id it could hold has expired. An id admitted before has a
   * UUIDv7 time at most the last store clock plus the allowed skew; the store restarts after one more window, with a
   * floor past that time, so such an id stays refused as expired even if the clock goes back.
   */
  private enterQuarantine(now: number, loss: ReplayStateLoss): never {
    this.cache = undefined;
    if (!existsSync(this.path(QUARANTINE_FILE))) {
      const until = Math.max(now, this.evidence()) + REPLAY_WINDOW_MS + MAX_CLOCK_SKEW_MS + 1;
      writeDurablePrivate(this.path(QUARANTINE_FILE), `${String(until)}\n`);
    }
    throw loss;
  }

  /** Refuses during a quarantine; once it is over, starts a fresh store whose clock is at least its end. */
  private leaveQuarantine(now: number): void {
    const raw = readText(this.path(QUARANTINE_FILE));
    if (raw === undefined) return;
    const until = /^(0|[1-9][0-9]*)\n$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(until)) {
      const later = Math.max(now, this.evidence()) + REPLAY_WINDOW_MS + MAX_CLOCK_SKEW_MS + 1;
      writeDurablePrivate(this.path(QUARANTINE_FILE), `${String(later)}\n`);
      throw new Error('E_REPLAY_STATE quarantined');
    }
    if (now < until) throw new Error('E_REPLAY_STATE quarantined');
    this.cache = undefined;
    const gens = [0];
    for (const name of REPLAY_JOURNALS) {
      const header = HEADER.exec(readBytes(this.path(name))?.toString('latin1', 0, HEADER_BYTES) ?? '');
      if (header?.[1]) gens.push(Number.parseInt(header[1], 16));
    }
    const cache = this.writeFresh(Math.max(...gens) + 1, now, []);
    writeDurablePrivate(this.path(VERSION_FILE), '3\n');
    rmSync(this.path(UPGRADING_FILE), { force: true });
    for (const name of [LEGACY_DIR, LEGACY_CLOCK, LEGACY_INTEGRITY, LEGACY_MIGRATING])
      rmSync(this.path(name), { recursive: true, force: true });
    unlinkSync(this.path(QUARANTINE_FILE));
    syncDirectory(this.root);
    this.cache = cache;
  }
}
