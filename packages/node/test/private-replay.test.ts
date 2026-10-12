import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generateIdentity,
  openEnvelope,
  ReplayCache,
  sealEnvelope,
  sha256Hex,
  uuidv7,
  type Envelope,
  type Message,
} from '@drop/protocol';
import { DropHome, MAX_RECEIVED_DROPS, MAX_RECEIVED_DROPS_PER_PEER, REPLAY_LOCK_OWNER } from '../src/home.ts';
import { inspectReplayJournal, REPLAY_JOURNALS, replayLockOwner } from '../src/replay-store.ts';
import { privateConfig } from '../src/private-config.ts';
import { MAX_ACTIVE_EXECUTING_DROPS, NodeEngine, type EngineLogEntry } from '../src/engine.ts';
import { fakeCapability } from './helpers.ts';
import { entries, idsAt, journalIds, NOW, writeJournalStore, writeLegacyStore } from './replay-fixtures.ts';

/** One owner node on a real DropHome, a paired requester, and every reply and log line captured. */
async function ownerNode(root: string, now = NOW) {
  const clock = { now };
  const owner = await generateIdentity('Owner');
  const requester = await generateIdentity('Requester');
  const other = await generateIdentity('Other');
  const home = new DropHome(root);
  home.init(owner, privateConfig('ws://127.0.0.1:7780/v1', 'human', 0));
  for (const peer of [requester, other]) {
    home.savePeer({
      nodeId: peer.nodeId,
      displayName: peer.displayName,
      ownerKind: 'human',
      pairedAt: new Date(now).toISOString(),
    });
  }
  home.publish({
    capabilityId: 'test.state',
    approverNodeIds: [owner.nodeId],
    config: {},
    publishedAt: new Date(now).toISOString(),
  });
  const replies: Envelope[] = [];
  const logs: EngineLogEntry[] = [];
  const transport = {
    fail: false,
    send: (envelope: Envelope): Promise<string> => {
      if (transport.fail) return Promise.reject(new Error('transport offline'));
      replies.push(envelope);
      return Promise.resolve('delivered');
    },
  };
  const engine = new NodeEngine({
    identity: owner,
    ownerKind: 'human',
    store: home,
    capabilities: [fakeCapability('test.state', 'low')],
    transport,
    log: (entry) => logs.push(entry),
    now: () => clock.now,
  });
  const send = async (dropId: string, sender = requester) =>
    engine.handleEnvelope(
      await sealEnvelope(
        sender,
        owner.nodeId,
        {
          type: 'drop_request',
          dropId,
          capabilityId: 'test.state',
          capabilityVersion: '1.0.0',
          input: { mode: 'ok' },
          purpose: 'Test replay',
          requestedBy: { nodeId: sender.nodeId, displayName: sender.displayName, agent: 'codex' },
        },
        { now: clock.now },
      ),
    );
  const lastReply = async (recipient = requester): Promise<Message> =>
    (
      await openEnvelope(recipient, replies.at(-1), {
        isKnownPeer: (id) => id === owner.nodeId,
        replay: new ReplayCache(),
        now: clock.now,
      })
    ).message;
  const errorsTo = async (recipient = requester): Promise<Message[]> => {
    const messages: Message[] = [];
    for (const envelope of replies.filter((candidate) => candidate.to === recipient.nodeId)) {
      const { message } = await openEnvelope(recipient, envelope, {
        isKnownPeer: (id) => id === owner.nodeId,
        replay: new ReplayCache(),
        now: clock.now,
      });
      if (message.type === 'drop_error') messages.push(message);
    }
    return messages;
  };
  return { home, engine, replies, logs, send, lastReply, errorsTo, requester, other, clock, transport };
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid;
}

describe('bounded received drops', () => {
  it('rejects stale and future identifiers before writing a marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-window-'));
    try {
      const home = new DropHome(root);
      expect(home.claimDrop(uuidv7(NOW - 30 * 60_000 - 1), NOW)).toBe('expired');
      expect(home.claimDrop(uuidv7(NOW + 5 * 60_000 + 1), NOW)).toBe('expired');
      expect(home.claimDrop(uuidv7(NOW), NOW)).toBe('claimed');
      expect(journalIds(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prunes old markers and rejects them after restart and clock rollback', () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-rollback-'));
    try {
      const first = new DropHome(root);
      const oldId = uuidv7(NOW);
      expect(first.claimDrop(oldId, NOW)).toBe('claimed');
      const later = NOW + 31 * 60_000;
      expect(first.claimDrop(uuidv7(later), later)).toBe('claimed');
      // The journal keeps the store clock: a restarted node with its clock back still refuses the expired id.
      const restarted = new DropHome(root);
      expect(restarted.claimDrop(oldId, NOW)).toBe('expired');
      expect(inspectReplayJournal(root)?.entries.at(-1)?.at).toBe(later);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when replay clock state is corrupt', () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-corrupt-'));
    try {
      const home = new DropHome(root);
      expect(home.claimDrop(uuidv7(NOW), NOW)).toBe('claimed');
      // The clock lives in the journal header: a damaged header leaves no valid journal.
      const journal = join(root, REPLAY_JOURNALS[0]);
      writeFileSync(journal, Buffer.concat([Buffer.from('corrupt'), readFileSync(journal).subarray(7)]));
      expect(() => new DropHome(root).claimDrop(uuidv7(NOW + 1), NOW + 1)).toThrow('E_REPLAY_STATE missing journal');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a claim while another process owns the replay lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-lock-'));
    try {
      const home = new DropHome(root);
      const lock = join(root, 'received-drops.lock');
      writeFileSync(lock, replayLockOwner(process.ppid, 'f'.repeat(16)));
      const dropId = uuidv7(NOW);
      expect(() => home.claimDrop(dropId, NOW)).toThrow('E_REPLAY_STATE claim locked');
      expect(readdirSync(root)).not.toContain(REPLAY_JOURNALS[0]);
      unlinkSync(lock);
      expect(home.claimDrop(dropId, NOW)).toBe('claimed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats lowercase and uppercase UUIDv7 as the same claim', () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-case-'));
    try {
      const home = new DropHome(root);
      const dropId = uuidv7(NOW);
      expect(home.claimDrop(dropId.toUpperCase(), NOW)).toBe('claimed');
      expect(journalIds(root)).toEqual([dropId]);
      expect(home.claimDrop(dropId, NOW)).toBe('duplicate');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses another claim at the marker cap', () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-cap-'));
    try {
      writeJournalStore(
        root,
        NOW,
        entries(idsAt(NOW, MAX_RECEIVED_DROPS), 'many peers', NOW).map((entry, index) => ({
          ...entry,
          tag: index.toString(16).padStart(16, '1'),
        })),
      );
      const home = new DropHome(root);
      expect(home.claimDrop(uuidv7(NOW), NOW, 'someone')).toBe('capacity');
      expect(journalIds(root)).toHaveLength(MAX_RECEIVED_DROPS);
      // Once they expire, the next admission compacts them away.
      const later = NOW + 31 * 60_000;
      expect(home.claimDrop(uuidv7(later), later, 'someone')).toBe('claimed');
      expect(journalIds(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('migrates a format-2 store: live ids stay refused, uppercase ones merge, expired and pre-v7 ones go', () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-migration-'));
    try {
      const [live, upper] = [uuidv7(NOW), uuidv7(NOW)];
      const expired = uuidv7(NOW - 31 * 60_000);
      writeLegacyStore(root, {
        markers: [live, upper.toUpperCase(), expired, '550e8400-e29b-41d4-a716-446655440000'],
        clock: NOW,
      });
      const home = new DropHome(root);
      expect(home.claimDrop(uuidv7(NOW + 1), NOW + 1)).toBe('claimed');
      expect(home.claimDrop(live, NOW + 1)).toBe('duplicate');
      expect(home.claimDrop(upper, NOW + 1)).toBe('duplicate');
      expect(home.claimDrop(expired, NOW + 1)).toBe('expired');
      expect(journalIds(root)).toEqual(expect.arrayContaining([live, upper]));
      expect(journalIds(root)).toHaveLength(3);
      for (const name of ['received-drops', 'received-drops-clock', 'received-drops-integrity'])
        expect(readdirSync(root)).not.toContain(name);
      expect(readFileSync(join(root, 'received-drops-version'), 'utf8')).toBe('3\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deletes legacy nil and max UUID markers instead of blocking admission', () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-nil-'));
    try {
      writeLegacyStore(root, {
        markers: ['00000000-0000-0000-0000-000000000000', 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF'],
        clock: NOW,
        version: '1',
      });
      expect(new DropHome(root).claimDrop(uuidv7(NOW + 1), NOW + 1)).toBe('claimed');
      expect(journalIds(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores operating system and foreign entries in the marker directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-foreign-'));
    try {
      const live = uuidv7(NOW);
      writeLegacyStore(root, { markers: [live, '.DS_Store', '._backup'], clock: NOW });
      mkdirSync(join(root, 'received-drops', 'Archive'));
      const home = new DropHome(root);
      expect(home.claimDrop(uuidv7(NOW + 1), NOW + 1)).toBe('claimed');
      expect(home.claimDrop(live, NOW + 2)).toBe('duplicate');
      expect(journalIds(root)).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still fails closed on a marker-shaped entry that is not a file', () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-marker-dir-'));
    try {
      writeLegacyStore(root, { markers: [], clock: NOW, version: '1' });
      mkdirSync(join(root, 'received-drops', uuidv7(NOW)));
      expect(() => new DropHome(root).claimDrop(uuidv7(NOW + 1), NOW + 1)).toThrow('E_REPLAY_STATE unexpected marker');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('quarantines a format-2 store that lost its clock, its markers, one live marker or its version', () => {
    const live = uuidv7(NOW);
    const cases: [string, (root: string) => void][] = [
      [
        'missing clock',
        (root) => {
          unlinkSync(join(root, 'received-drops-clock'));
        },
      ],
      [
        'missing markers',
        (root) => {
          rmSync(join(root, 'received-drops'), { recursive: true });
        },
      ],
      [
        'marker integrity',
        (root) => {
          unlinkSync(join(root, 'received-drops', live));
        },
      ],
      [
        'missing version',
        (root) => {
          unlinkSync(join(root, 'received-drops-version'));
          unlinkSync(join(root, 'received-drops-clock'));
        },
      ],
    ];
    for (const [reason, lose] of cases) {
      const root = mkdtempSync(join(tmpdir(), 'drop-replay-legacy-loss-'));
      try {
        writeLegacyStore(root, { markers: [live], clock: NOW });
        lose(root);
        const home = new DropHome(root);
        expect(() => home.claimDrop(uuidv7(NOW + 1), NOW + 1), reason).toThrow(`E_REPLAY_STATE ${reason}`);
        expect(() => new DropHome(root).claimDrop(uuidv7(NOW + 2), NOW + 2), reason).toThrow(
          'E_REPLAY_STATE quarantined',
        );
        // After a full window and the skew, every id the lost store could hold is expired for good.
        const after = NOW + 1 + 35 * 60_000 + 1;
        expect(home.claimDrop(uuidv7(after), after), reason).toBe('claimed');
        expect(home.claimDrop(live, NOW), reason).toBe('expired');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('verifies a digest written before floors and refuses to migrate a store that lost a marker', () => {
    for (const lost of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), 'drop-replay-legacy-digest-'));
      try {
        const [first, second] = [uuidv7(NOW), uuidv7(NOW)];
        writeLegacyStore(root, { markers: [first, second], clock: NOW, digest: false });
        writeFileSync(join(root, 'received-drops-integrity'), `${sha256Hex([first, second].sort())}\n`);
        if (lost) unlinkSync(join(root, 'received-drops', second));
        const home = new DropHome(root);
        if (lost) {
          expect(() => home.claimDrop(uuidv7(NOW + 1), NOW + 1)).toThrow('E_REPLAY_STATE marker integrity');
        } else {
          expect(home.claimDrop(uuidv7(NOW + 1), NOW + 1)).toBe('claimed');
          expect(home.claimDrop(second, NOW + 2)).toBe('duplicate');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('reclaims only its own replay lock and refuses an old foreign lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-stale-lock-'));
    try {
      const home = new DropHome(root);
      const lock = join(root, 'received-drops.lock');
      writeFileSync(lock, REPLAY_LOCK_OWNER);
      expect(home.claimDrop(uuidv7(NOW), NOW)).toBe('claimed');
      expect(readdirSync(root)).not.toContain('received-drops.lock');
      // A dead process is only provably dead on this host and this boot: a T3.1b record, an empty one, another host
      // or another boot keep the lock, however old.
      const dead = deadPid();
      const foreign = [
        `${String(dead)} 00\n`,
        '',
        replayLockOwner(dead, 'a'.repeat(16)).replace(/ [0-9a-f]{16} (\S+)\n$/, ' 0123456789abcdef $1\n'),
        replayLockOwner(dead, 'b'.repeat(16), 't:12'),
      ];
      for (const [index, owner] of foreign.entries()) {
        writeFileSync(lock, owner);
        const old = new Date(Date.now() - 5 * 60_000);
        utimesSync(lock, old, old);
        expect(() => home.claimDrop(uuidv7(NOW + index + 1), NOW + index + 1), owner).toThrow(
          'E_REPLAY_STATE claim locked',
        );
        expect(readFileSync(lock, 'utf8')).toBe(owner);
        unlinkSync(lock);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('takes over a lock whose owner is provably dead, through a guard a live taker keeps', () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-dead-lock-'));
    try {
      const home = new DropHome(root);
      const lock = join(root, 'received-drops.lock');
      const record = replayLockOwner(deadPid(), 'c'.repeat(16));
      const guard = `${lock}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`;
      writeFileSync(lock, record);
      // Another live process is taking it over: wait for it.
      writeFileSync(guard, replayLockOwner(process.ppid, 'd'.repeat(16)));
      expect(() => home.claimDrop(uuidv7(NOW), NOW)).toThrow('E_REPLAY_STATE claim locked');
      expect(readFileSync(lock, 'utf8')).toBe(record);
      // That taker died too: its guard is taken over the same way.
      writeFileSync(guard, replayLockOwner(deadPid(), 'e'.repeat(16)));
      expect(home.claimDrop(uuidv7(NOW), NOW)).toBe('claimed');
      expect(readdirSync(root).filter((name) => name.startsWith('received-drops.lock'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never takes over a foreign replay lock even when its takeover sentinel is old', () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-takeover-'));
    try {
      const home = new DropHome(root);
      // The T3.1b lock was a directory: it is never taken over, whatever sits next to it.
      const lock = join(root, 'received-drops.lock');
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, 'owner'), `${String(deadPid())} 00\n`);
      const old = new Date(Date.now() - 5 * 60_000);
      utimesSync(lock, old, old);
      mkdirSync(`${lock}.takeover`, { mode: 0o700 });
      expect(() => home.claimDrop(uuidv7(NOW), NOW)).toThrow('E_REPLAY_STATE claim locked');
      expect(readdirSync(root)).toContain('received-drops.lock');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a replay lock owned by another live process', () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-live-lock-'));
    try {
      const home = new DropHome(root);
      const lock = join(root, 'received-drops.lock');
      const owner = replayLockOwner(process.ppid, '1'.repeat(16));
      writeFileSync(lock, owner);
      expect(() => home.claimDrop(uuidv7(NOW), NOW)).toThrow('E_REPLAY_STATE claim locked');
      expect(readFileSync(lock, 'utf8')).toBe(owner);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires manual removal of an ownerless replay lock before admission resumes', () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-ownerless-lock-'));
    try {
      const home = new DropHome(root);
      const lock = join(root, 'received-drops.lock');
      mkdirSync(lock, { mode: 0o700 });
      expect(() => home.claimDrop(uuidv7(NOW), NOW)).toThrow('E_REPLAY_STATE claim locked');
      const old = new Date(Date.now() - 5 * 60_000);
      utimesSync(lock, old, old);
      expect(() => home.claimDrop(uuidv7(NOW), NOW)).toThrow('E_REPLAY_STATE claim locked');
      rmSync(lock, { recursive: true });
      expect(home.claimDrop(uuidv7(NOW), NOW)).toBe('claimed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('replay admission through the engine', () => {
  it('reports a full replay store as E_RATE before consent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-engine-full-'));
    try {
      const node = await ownerNode(root);
      writeJournalStore(
        root,
        NOW,
        entries(idsAt(NOW, MAX_RECEIVED_DROPS), 'legacy', NOW).map((entry) => ({ ...entry, tag: '0'.repeat(16) })),
      );
      await node.send(uuidv7(NOW));
      expect(node.engine.pending()).toHaveLength(0);
      expect(journalIds(root)).toHaveLength(MAX_RECEIVED_DROPS);
      expect(await node.lastReply()).toMatchObject({ type: 'drop_error', code: 'E_RATE' });
      expect(node.logs).toContainEqual(
        expect.objectContaining({ event: 'drop_rejected', code: 'E_RATE', reason: 'replay_capacity' }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a request after clock rollback with E_EXPIRED and logs that the replay clock is ahead', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-engine-rollback-'));
    try {
      const node = await ownerNode(root);
      const ahead = NOW + 31 * 60_000;
      expect(node.home.claimDrop(uuidv7(ahead), ahead)).toBe('claimed');
      await node.send(uuidv7(NOW));
      expect(node.engine.pending()).toHaveLength(0);
      expect(await node.lastReply()).toMatchObject({ type: 'drop_error', code: 'E_EXPIRED' });
      expect(node.logs).toContainEqual(
        expect.objectContaining({ event: 'drop_rejected', code: 'E_EXPIRED', reason: 'replay_clock_ahead' }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('logs the replay store failure cause without a path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-engine-cause-'));
    try {
      const node = await ownerNode(root);
      mkdirSync(join(root, 'received-drops'));
      writeFileSync(join(root, 'received-drops-version'), '1\n');
      writeFileSync(join(root, 'received-drops-clock'), 'corrupt');
      await node.send(uuidv7(NOW));
      expect(node.logs).toContainEqual(
        expect.objectContaining({ event: 'drop_rejected', code: 'E_REPLAY_STATE', reason: 'corrupt clock' }),
      );
      expect(JSON.stringify(node.logs)).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers a duplicate of an active request with its current state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-engine-active-'));
    try {
      const node = await ownerNode(root);
      const dropId = uuidv7(NOW);
      await node.send(dropId);
      expect(node.engine.pending()).toHaveLength(1);
      const before = node.replies.length;
      await node.send(dropId);
      expect(node.replies.length).toBeGreaterThan(before);
      expect(await node.lastReply()).toEqual({ type: 'drop_status', dropId, state: 'awaiting_approval' });
      expect(node.engine.pending()).toHaveLength(1);
      // The active check runs before capability lookup: unpublishing must not turn a duplicate into a failure.
      node.home.unpublish('test.state');
      await node.send(dropId);
      expect(await node.lastReply()).toEqual({ type: 'drop_status', dropId, state: 'awaiting_approval' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses another peer reusing an active drop id without revealing its state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-engine-other-'));
    try {
      const node = await ownerNode(root);
      const dropId = uuidv7(NOW);
      await node.send(dropId);
      await node.send(dropId, node.other);
      expect(await node.lastReply(node.other)).toMatchObject({ type: 'drop_error', dropId, code: 'E_DENIED' });
      expect(node.engine.pending()).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers a duplicate of a finished request with its recorded outcome', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-engine-finished-'));
    try {
      const node = await ownerNode(root);
      const dropId = uuidv7(NOW);
      await node.send(dropId);
      expect(await node.engine.decide(dropId, 'not_now')).toBe(true);
      const [outcome] = await node.errorsTo();
      expect(outcome).toMatchObject({ type: 'drop_error', dropId, code: 'E_NOT_NOW' });
      await node.send(dropId);
      expect(await node.errorsTo()).toEqual([outcome, outcome]);
      expect(node.engine.memoryStats().executing).toBe(0);
      expect(node.engine.memoryStats().completedErrors).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('expires a finished-error summary within 30 minutes even for a future UUIDv7', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-engine-future-summary-'));
    try {
      const node = await ownerNode(root);
      const dropId = uuidv7(NOW + 5 * 60_000);
      await node.send(dropId);
      expect(await node.engine.decide(dropId, 'not_now')).toBe(true);
      expect(node.engine.memoryStats().completedErrors).toBe(1);
      node.clock.now = NOW + 30 * 60_000 + 1;
      await node.engine.tick();
      expect(node.engine.memoryStats().completedErrors).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('frees a delivered request without reopening its durable replay marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-engine-delivered-memory-'));
    try {
      const node = await ownerNode(root);
      const dropId = uuidv7(NOW);
      await node.send(dropId);
      expect(await node.engine.decide(dropId, 'allow_once')).toBe(true);
      expect(node.engine.memoryStats().executing).toBe(0);
      await node.send(dropId);
      expect(node.engine.pending()).toHaveLength(0);
      expect(await node.lastReply()).toMatchObject({ type: 'drop_error', dropId, code: 'E_DENIED' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('frees an expired approval without reopening its durable replay marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-engine-expired-memory-'));
    try {
      const node = await ownerNode(root);
      const dropId = uuidv7(NOW);
      await node.send(dropId);
      node.clock.now += 11 * 60_000;
      await node.engine.tick();
      expect(node.engine.memoryStats().executing).toBe(0);
      expect(node.engine.pending()).toHaveLength(0);
      await node.send(dropId);
      expect(await node.lastReply()).toMatchObject({ type: 'drop_error', dropId, code: 'E_EXPIRED' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not strand an approved request when transport throws on status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-engine-transport-'));
    try {
      const node = await ownerNode(root);
      const dropId = uuidv7(NOW);
      await node.send(dropId);
      node.transport.fail = true;
      expect(await node.engine.decide(dropId, 'allow_once')).toBe(true);
      expect(node.engine.memoryStats().executing).toBe(0);
      expect(node.engine.memoryStats().outbox).toBeGreaterThan(0);
      expect(node.logs).toContainEqual(expect.objectContaining({ code: 'E_RUNNER', reason: 'transport_exception' }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a peer holding its replay share with E_RATE before consent, while another peer is admitted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-engine-peer-quota-'));
    try {
      const node = await ownerNode(root);
      writeJournalStore(root, NOW, entries(idsAt(NOW, MAX_RECEIVED_DROPS_PER_PEER), node.requester.nodeId, NOW));
      await node.send(uuidv7(NOW));
      expect(node.engine.pending()).toHaveLength(0);
      expect(await node.lastReply()).toMatchObject({ type: 'drop_error', code: 'E_RATE' });
      expect(node.logs).toContainEqual(
        expect.objectContaining({ event: 'drop_rejected', code: 'E_RATE', reason: 'replay_peer_quota' }),
      );
      await node.send(uuidv7(NOW), node.other);
      expect(node.engine.pending()).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses another request before consent when active execution memory is full', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-engine-active-cap-'));
    try {
      const node = await ownerNode(root);
      for (let index = 0; index < MAX_ACTIVE_EXECUTING_DROPS; index += 1) await node.send(uuidv7(NOW + index));
      expect(node.engine.memoryStats().executing).toBe(MAX_ACTIVE_EXECUTING_DROPS);
      // From another peer, whose replay share is still free: only the execution cap can refuse it.
      const extra = uuidv7(NOW + MAX_ACTIVE_EXECUTING_DROPS);
      await node.send(extra, node.other);
      expect(node.engine.pending()).toHaveLength(MAX_ACTIVE_EXECUTING_DROPS);
      expect(await node.lastReply(node.other)).toMatchObject({ type: 'drop_error', dropId: extra, code: 'E_RATE' });
      expect(node.logs).toContainEqual(
        expect.objectContaining({ event: 'drop_rejected', code: 'E_RATE', reason: 'execution_capacity' }),
      );
      expect(node.engine.memoryStats().executing).toBe(MAX_ACTIVE_EXECUTING_DROPS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('private replay admission', () => {
  it('refuses an old drop before consent and reports a corrupt replay store as E_RATE', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-engine-'));
    try {
      const owner = await generateIdentity('Owner');
      const requester = await generateIdentity('Requester');
      const home = new DropHome(root);
      home.init(owner, privateConfig('ws://127.0.0.1:7780/v1', 'human', 0));
      home.savePeer({
        nodeId: requester.nodeId,
        displayName: 'Requester',
        ownerKind: 'human',
        pairedAt: new Date(NOW).toISOString(),
      });
      home.publish({
        capabilityId: 'test.state',
        approverNodeIds: [owner.nodeId],
        config: {},
        publishedAt: new Date(NOW).toISOString(),
      });
      const replies: Envelope[] = [];
      const engine = new NodeEngine({
        identity: owner,
        ownerKind: 'human',
        store: home,
        capabilities: [fakeCapability('test.state', 'low')],
        transport: {
          send: (envelope) => {
            replies.push(envelope);
            return Promise.resolve('delivered');
          },
        },
        now: () => NOW,
      });
      const request = async (dropId: string) =>
        sealEnvelope(
          requester,
          owner.nodeId,
          {
            type: 'drop_request',
            dropId,
            capabilityId: 'test.state',
            capabilityVersion: '1.0.0',
            input: { mode: 'ok' },
            purpose: 'Test replay',
            requestedBy: { nodeId: requester.nodeId, displayName: 'Requester', agent: 'codex' },
          },
          { now: NOW },
        );
      await engine.handleEnvelope(await request(uuidv7(NOW - 30 * 60_000 - 1)));
      expect(engine.pending()).toHaveLength(0);
      expect(
        (
          await openEnvelope(requester, replies.at(-1), {
            isKnownPeer: (id) => id === owner.nodeId,
            replay: new ReplayCache(),
            now: NOW,
          })
        ).message,
      ).toMatchObject({ type: 'drop_error', code: 'E_EXPIRED' });
      expect(home.claimDrop(uuidv7(NOW), NOW)).toBe('claimed');
      writeFileSync(join(root, REPLAY_JOURNALS[0]), 'corrupt');
      await engine.handleEnvelope(await request(uuidv7(NOW)));
      expect(engine.pending()).toHaveLength(0);
      expect(
        (
          await openEnvelope(requester, replies.at(-1), {
            isKnownPeer: (id) => id === owner.nodeId,
            replay: new ReplayCache(),
            now: NOW,
          })
        ).message,
      ).toMatchObject({ type: 'drop_error', code: 'E_RATE' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('private restart', () => {
  it('rejects a previously received drop after restart before any consent can be reused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-replay-'));
    try {
      const owner = await generateIdentity('Owner');
      const requester = await generateIdentity('Requester');
      const home = new DropHome(root);
      home.init(owner, privateConfig('ws://127.0.0.1:7780/v1', 'human', 0));
      home.savePeer({
        nodeId: requester.nodeId,
        displayName: 'Requester',
        ownerKind: 'human',
        pairedAt: new Date().toISOString(),
      });
      home.publish({
        capabilityId: 'test.state',
        approverNodeIds: [owner.nodeId],
        config: {},
        publishedAt: new Date().toISOString(),
      });
      const impl = fakeCapability('test.state', 'low');
      let executions = 0;
      const execute = impl.execute.bind(impl);
      impl.execute = async (...args) => {
        executions++;
        return execute(...args);
      };
      const make = () =>
        new NodeEngine({
          identity: owner,
          ownerKind: 'human',
          store: home,
          capabilities: [impl],
          transport: { send: () => Promise.resolve('delivered') },
        });
      const first = make();
      const dropId = uuidv7();
      const request = await sealEnvelope(requester, owner.nodeId, {
        type: 'drop_request',
        dropId,
        capabilityId: impl.card.id,
        capabilityVersion: impl.card.version,
        input: { mode: 'ok' },
        purpose: 'Test restart',
        requestedBy: { nodeId: requester.nodeId, displayName: 'Requester', agent: 'claude_code' },
      });
      await first.handleEnvelope(request);
      expect(first.pending()).toHaveLength(1);
      await first.decide(dropId, 'allow_once');
      expect(executions).toBe(1);
      const restarted = make();
      await restarted.handleEnvelope(request);
      expect(restarted.pending()).toHaveLength(0);
      await restarted.decide(dropId, 'allow_once');
      expect(executions).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
