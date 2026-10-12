import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { execFileSync } from 'node:child_process';
import { pbkdf2 } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAdmission,
  envelopeSize,
  generateIdentity,
  MAX_CLOCK_SKEW_MS,
  MAX_ENVELOPE_BYTES,
  MAX_TTL_MS,
  sealEnvelope,
  signDetached,
  verifyDetached,
  type Envelope,
  type Identity,
} from '@drop/protocol';
import {
  allowNode,
  RelayClient,
  readRelayConfig,
  revokeInConfig,
  revokeNode,
  RelayConfigSchema,
  startRelay,
  type RelayHandle,
  type RelayLogEntry,
} from '../src/index.ts';
import { writePrivate } from '../src/private-file.ts';
import { expectPrivateMode } from '../../../test/private-mode.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function relayFor(
  identities: Identity[],
  extra: {
    rateLimitPerMinute?: number;
    admittedPath?: string;
    revokedPath?: string;
    maxAdmissionsPerSponsorPerDay?: number;
    maxAdmissionsPerDay?: number;
    maxQueueBytes?: number;
  } = {},
  options: { now?: () => number; pingIntervalMs?: number } = {},
) {
  const logs: RelayLogEntry[] = [];
  const relay = await startRelay(
    { port: 0, allowedNodeIds: identities.map((identity) => identity.nodeId), ...extra },
    { logger: (entry) => logs.push(entry), revocationPollMs: 20, ...options },
  );
  cleanups.push(() => relay.close());
  return { relay, logs };
}

function client(relay: RelayHandle, identity: Identity, admission?: unknown) {
  const received: Envelope[] = [];
  const statuses: string[] = [];
  const instance = new RelayClient({
    identity,
    url: relay.url,
    ...(admission === undefined ? {} : { admission: () => admission }),
    onEnvelope: (envelope) => received.push(envelope),
    onStatus: (status) => statuses.push(status),
    minBackoffMs: 20,
    maxBackoffMs: 50,
  });
  instance.start();
  cleanups.push(() => {
    instance.close();
  });
  return { instance, received, statuses };
}

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('relay', () => {
  it('keeps revoked members and their sponsored invitations refused after restore', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const newcomer = await generateIdentity('New');
    const dir = mkdtempSync(join(tmpdir(), 'drop-revoked-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const configPath = join(dir, 'relay.config.json');
    const statePath = join(dir, 'admitted.json');
    writeFileSync(configPath, JSON.stringify({ port: 0, allowedNodeIds: [alice.nodeId], admittedPath: statePath }));
    writeFileSync(
      statePath,
      JSON.stringify({ admitted: [{ nodeId: bob.nodeId, sponsor: alice.nodeId, at: Date.now() }], spentNonces: [] }),
    );
    expect(revokeInConfig(configPath, bob.nodeId)).toBe(true);
    expect(revokeInConfig(configPath, bob.nodeId)).toBe(false);
    // Restoration uses both the config (revocations) and admissions, including the revoked member's old entry.
    const restoredConfig = readRelayConfig(configPath);
    const relay = await startRelay(restoredConfig, { logger: () => undefined });
    cleanups.push(() => relay.close());
    const ticket = await createAdmission(alice, Date.now());
    const denied = client(relay, bob, ticket);
    const sponsored = client(relay, newcomer, await createAdmission(bob, Date.now()));
    const permitted = client(relay, alice);
    await permitted.instance.waitReady();
    await until(() => denied.statuses.includes('unauthorized') && sponsored.statuses.includes('unauthorized'));
    expect(denied.instance.connected).toBe(false);
    expect(sponsored.instance.connected).toBe(false);
  });

  it('reads relay.config.json, with the admission settings optional', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-config-'));
    const minimal = join(dir, 'minimal.json');
    writeFileSync(minimal, JSON.stringify({ port: 8787, allowedNodeIds: ['a'] }));
    expect(RelayConfigSchema.parse(readRelayConfig(minimal))).toMatchObject({
      port: 8787,
      allowedNodeIds: ['a'],
      maxQueuePerNode: 100,
      rateLimitPerMinute: 60,
      maxAdmissionsPerSponsorPerDay: 20,
      maxAdmissionsPerDay: 100,
    });
    const full = join(dir, 'full.json');
    const admittedPath = join(dir, 'admitted.json');
    writeFileSync(
      full,
      JSON.stringify({ port: 1, allowedNodeIds: [], admittedPath, maxAdmissionsPerSponsorPerDay: 0 }),
    );
    expect(readRelayConfig(full)).toMatchObject({ admittedPath, maxAdmissionsPerSponsorPerDay: 0 });
  });

  it('direct delivery between two in-memory nodes', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const { relay } = await relayFor([alice, bob]);
    const a = client(relay, alice);
    const b = client(relay, bob);
    await Promise.all([a.instance.waitReady(), b.instance.waitReady()]);
    const envelope = await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' });
    expect(await a.instance.send(envelope)).toBe('delivered');
    await until(() => b.received.length === 1);
    expect(b.received[0]).toEqual(envelope);
  });

  it('deferred delivery after reconnect', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const { relay } = await relayFor([alice, bob]);
    const a = client(relay, alice);
    await a.instance.waitReady();
    const envelope = await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' });
    expect(await a.instance.send(envelope)).toBe('queued');
    const b = client(relay, bob);
    await until(() => b.received.length === 1);
    expect(b.received[0]?.id).toBe(envelope.id);
  });

  it('drops a queued envelope once it expires', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const { relay } = await relayFor([alice, bob]);
    const a = client(relay, alice);
    await a.instance.waitReady();
    const envelope = await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' }, { ttlMs: 30 });
    expect(await a.instance.send(envelope)).toBe('queued');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const b = client(relay, bob);
    await b.instance.waitReady();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(b.received).toEqual([]);
  });

  it('rejects a spoofed from', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const mallory = await generateIdentity('Mallory');
    const { relay, logs } = await relayFor([alice, bob, mallory]);
    const m = client(relay, mallory);
    await m.instance.waitReady();
    const forged = await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' });
    expect(await m.instance.send(forged)).toBe('offline');
    expect(logs).toContainEqual(expect.objectContaining({ outcome: 'spoofed_from', from: alice.nodeId }));
  });

  it('signs only a 32-byte challenge, never another text a relay sends', async () => {
    const alice = await generateIdentity('Alice');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of server.clients) socket.terminate();
          server.close(() => {
            resolve();
          });
        }),
    );
    const answers: string[] = [];
    server.on('connection', (socket) => {
      socket.on('message', (data) => answers.push(Buffer.isBuffer(data) ? data.toString('utf8') : ''));
      // A text another protocol would accept as proof (a local network session, D63): no answer expected.
      socket.send(JSON.stringify({ type: 'challenge', challenge: `drop-lan-v1|${'a'.repeat(43)}|x|y` }));
      setTimeout(() => {
        socket.send(JSON.stringify({ type: 'challenge', challenge: 'b'.repeat(43) }));
      }, 200);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const client = new RelayClient({
      identity: alice,
      url: `ws://127.0.0.1:${String(port)}/v1`,
      onEnvelope: () => undefined,
    });
    cleanups.push(() => {
      client.close();
    });
    client.start();
    await until(() => answers.length > 0);
    expect(answers).toHaveLength(1);
    const auth = JSON.parse(answers[0] ?? '{}') as { type: string; sig: string };
    expect(auth.type).toBe('auth');
    expect(await verifyDetached(alice.nodeId, 'b'.repeat(43), auth.sig)).toBe(true);
  });

  it('rejects a node that is not allowed', async () => {
    const alice = await generateIdentity('Alice');
    const stranger = await generateIdentity('Stranger');
    const { relay } = await relayFor([alice]);
    const code = await new Promise<number>((resolve) => {
      const socket = new WebSocket(relay.url);
      socket.on('message', (data) => {
        const frame = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : '{}') as { challenge: string };
        void signDetached(stranger, frame.challenge).then((sig) => {
          socket.send(JSON.stringify({ type: 'auth', nodeId: stranger.nodeId, sig }));
        }, resolve);
      });
      socket.on('close', (closeCode) => {
        resolve(closeCode);
      });
    });
    expect(code).toBe(4401);
  });

  it('rate limit', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const { relay } = await relayFor([alice, bob], { rateLimitPerMinute: 3 });
    const a = client(relay, alice);
    await a.instance.waitReady();
    const outcomes: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      outcomes.push(await a.instance.send(await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' })));
    }
    expect(outcomes).toEqual(['queued', 'queued', 'queued', 'E_RATE']);
  });

  it('restores a sender once its rate window has passed, with idle windows swept', async () => {
    // The relay's pinger, which sweeps idle rate windows, ticks only when the test moves it, so the sweep runs exactly
    // once, after the window has passed. Sockets and timeouts keep real time (T4.38).
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    cleanups.push(() => {
      vi.useRealTimers();
    });
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const clock = { now: Date.now() };
    const { relay } = await relayFor(
      [alice, bob],
      { rateLimitPerMinute: 1 },
      { now: () => clock.now, pingIntervalMs: 20 },
    );
    const sender = client(relay, alice);
    await sender.instance.waitReady();
    const send = async () => sender.instance.send(await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' }));
    expect(await send()).toBe('queued');
    expect(await send()).toBe('E_RATE');
    // E_RATE closes the connection; the client dials again after its backoff and authenticates anew. A fixed delay
    // raced that reconnection and lost it under load, sending while offline (T4.38).
    await until(() => sender.statuses.includes('disconnected'));
    await sender.instance.waitReady();
    clock.now += 60_001;
    vi.advanceTimersByTime(20);
    expect(await send()).toBe('queued');
    expect(await send()).toBe('E_RATE');
  });

  it('keeps a node rate limit after reconnect', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const { relay } = await relayFor([alice, bob], { rateLimitPerMinute: 2 });
    const first = client(relay, alice);
    await first.instance.waitReady();
    for (let index = 0; index < 2; index += 1) {
      expect(await first.instance.send(await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' }))).toBe(
        'queued',
      );
    }
    first.instance.close();
    const second = client(relay, alice);
    await second.instance.waitReady();
    expect(await second.instance.send(await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' }))).toBe(
      'E_RATE',
    );
  });

  it('counts oversized envelopes against the sender rate limit', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const { relay } = await relayFor([alice, bob], { rateLimitPerMinute: 1 });
    const a = client(relay, alice);
    await a.instance.waitReady();
    const oversized = await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' });
    oversized.body = 'A'.repeat(MAX_ENVELOPE_BYTES);
    expect(await a.instance.send(oversized)).toBe('E_TOO_LARGE');
    expect(await a.instance.send(await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' }))).toBe('E_RATE');
  });

  it('counts a frame rejected by the WebSocket payload limit before reconnect', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const { relay, logs } = await relayFor([alice, bob], { rateLimitPerMinute: 1 });
    const socket = new WebSocket(relay.url);
    cleanups.push(() => {
      socket.terminate();
    });
    let ready = false;
    let closed = false;
    socket.on('message', (data) => {
      const frame = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : '') as {
        type: string;
        challenge?: string;
      };
      if (frame.type === 'challenge' && frame.challenge) {
        void signDetached(alice, frame.challenge).then(
          (sig) => {
            socket.send(JSON.stringify({ type: 'auth', nodeId: alice.nodeId, sig }));
          },
          () => {
            socket.close();
          },
        );
      }
      if (frame.type === 'ready') ready = true;
    });
    socket.on('close', () => {
      closed = true;
    });
    await until(() => ready);
    socket.send('X'.repeat(MAX_ENVELOPE_BYTES * 2 + 1));
    await until(() => closed);
    const reconnected = client(relay, alice);
    await reconnected.instance.waitReady();
    expect(await reconnected.instance.send(await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' }))).toBe(
      'E_RATE',
    );
    expect(logs).toContainEqual(expect.objectContaining({ nodeId: alice.nodeId, outcome: 'E_TOO_LARGE' }));
  });

  it('counts invalid UTF-8 frames rejected by WebSocket before reconnect', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const { relay, logs } = await relayFor([alice, bob], { rateLimitPerMinute: 1 });
    const socket = new WebSocket(relay.url);
    cleanups.push(() => {
      socket.terminate();
    });
    let ready = false;
    let closed = false;
    socket.on('message', (data) => {
      const frame = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : '') as {
        type: string;
        challenge?: string;
      };
      if (frame.type === 'challenge' && frame.challenge) {
        void signDetached(alice, frame.challenge).then(
          (sig) => {
            socket.send(JSON.stringify({ type: 'auth', nodeId: alice.nodeId, sig }));
          },
          () => {
            socket.close();
          },
        );
      }
      if (frame.type === 'ready') ready = true;
    });
    socket.on('close', () => {
      closed = true;
    });
    await until(() => ready);
    socket.send(Buffer.from([0xff]), { binary: false });
    await until(() => closed);
    const reconnected = client(relay, alice);
    await reconnected.instance.waitReady();
    expect(await reconnected.instance.send(await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' }))).toBe(
      'E_RATE',
    );
    expect(logs).toContainEqual(expect.objectContaining({ nodeId: alice.nodeId, outcome: 'E_SCHEMA' }));
  });

  it('counts malformed authenticated frames before parsing', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const { relay } = await relayFor([alice, bob], { rateLimitPerMinute: 1 });
    const socket = new WebSocket(relay.url);
    cleanups.push(() => {
      socket.terminate();
    });
    const frames: { type?: string; challenge?: string; error?: string; id?: string }[] = [];
    socket.on('message', (data) => {
      const frame = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : '') as (typeof frames)[number];
      frames.push(frame);
      if (frame.type === 'challenge' && frame.challenge) {
        void signDetached(alice, frame.challenge)
          .then((sig) => {
            socket.send(JSON.stringify({ type: 'auth', nodeId: alice.nodeId, sig }));
          })
          .catch(() => {
            frames.push({ error: 'E_AUTH_TEST' });
          });
      }
    });
    await until(() => frames.some((frame) => frame.type === 'ready'));
    socket.send('not-json');
    await until(() => frames.some((frame) => frame.error === 'E_SCHEMA'));
    const envelope = await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' });
    socket.send(JSON.stringify({ type: 'envelope', envelope }));
    await until(() => frames.some((frame) => frame.id === envelope.id));
    expect(frames.find((frame) => frame.id === envelope.id)?.error).toBe('E_RATE');
  });

  it('closes an exhausted connection when a valid frame has an uncorrelatable late id', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const { relay } = await relayFor([alice, bob], { rateLimitPerMinute: 1 });
    const socket = new WebSocket(relay.url);
    cleanups.push(() => {
      socket.terminate();
    });
    const frames: { type?: string; challenge?: string; id?: string; error?: string }[] = [];
    let closed = false;
    socket.on('close', () => {
      closed = true;
    });
    socket.on('message', (data) => {
      const frame = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : '') as (typeof frames)[number];
      frames.push(frame);
      if (frame.type === 'challenge' && frame.challenge) {
        void signDetached(alice, frame.challenge).then(
          (sig) => {
            socket.send(JSON.stringify({ type: 'auth', nodeId: alice.nodeId, sig }));
          },
          () => {
            socket.close();
          },
        );
      }
    });
    await until(() => frames.some((frame) => frame.type === 'ready'));
    const first = await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' });
    socket.send(JSON.stringify({ type: 'envelope', envelope: first }));
    await until(() => frames.some((frame) => frame.id === first.id));
    const second = await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' });
    const { id, ...rest } = second;
    const lateIdFrame = JSON.stringify({ type: 'envelope', envelope: { ...rest, id } });
    expect(lateIdFrame.indexOf('"id"')).toBeGreaterThan(256);
    socket.send(lateIdFrame);
    await until(() => frames.some((frame) => frame.error === 'E_RATE'));
    expect(frames.find((frame) => frame.error === 'E_RATE')?.id).toBeUndefined();
    await until(() => closed);
  });

  it('closes an exhausted connection even when a decoy id appears before the envelope id', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const { relay } = await relayFor([alice, bob], { rateLimitPerMinute: 1 });
    const socket = new WebSocket(relay.url);
    cleanups.push(() => {
      socket.terminate();
    });
    const frames: { type?: string; challenge?: string; id?: string; error?: string }[] = [];
    let closed = false;
    socket.on('close', () => {
      closed = true;
    });
    socket.on('message', (data) => {
      const frame = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : '') as (typeof frames)[number];
      frames.push(frame);
      if (frame.type === 'challenge' && frame.challenge) {
        void signDetached(alice, frame.challenge).then(
          (sig) => {
            socket.send(JSON.stringify({ type: 'auth', nodeId: alice.nodeId, sig }));
          },
          () => {
            socket.close();
          },
        );
      }
    });
    await until(() => frames.some((frame) => frame.type === 'ready'));
    const first = await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' });
    socket.send(JSON.stringify({ type: 'envelope', envelope: first }));
    await until(() => frames.some((frame) => frame.id === first.id));
    const second = await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' });
    const { id, ...rest } = second;
    const decoy = '550e8400-e29b-41d4-a716-446655440000';
    const frame = JSON.stringify({ type: 'envelope', id: decoy, envelope: { ...rest, id } });
    expect(frame.indexOf(`"id":"${id}"`)).toBeGreaterThan(256);
    socket.send(frame);
    await until(() => frames.some((candidate) => candidate.error === 'E_RATE'));
    expect(frames.find((candidate) => candidate.error === 'E_RATE')?.id).toBe(decoy);
    await until(() => closed);
  });

  it('no body field in the logs', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const { relay, logs } = await relayFor([alice, bob]);
    const a = client(relay, alice);
    const b = client(relay, bob);
    await Promise.all([a.instance.waitReady(), b.instance.waitReady()]);
    const envelope = await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' });
    await a.instance.send(envelope);
    const serialized = JSON.stringify(logs);
    expect(logs.some((entry) => entry.outcome === 'delivered')).toBe(true);
    expect(serialized).not.toContain('"body"');
    expect(serialized).not.toContain(envelope.body);
    expect(serialized).not.toContain(envelope.sig);
  });

  it('answers GET /health for probes, and nothing else over plain HTTP', async () => {
    delete process.env.DROP_BUILD;
    const alice = await generateIdentity('Alice');
    const { relay } = await relayFor([alice]);
    const base = relay.url.replace('ws://', 'http://').replace('/v1', '');
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, nodes: 0, build: 'unknown' });
    expect((await fetch(`${base}/peers`)).status).toBe(404);
  });

  it('reports the build identity alongside the connection count', async () => {
    const build = '76cfb890ced3e256921e42bb20bdf11c11a7c1b9';
    process.env.DROP_BUILD = build;
    try {
      const alice = await generateIdentity('Alice');
      const { relay } = await relayFor([alice]);
      const base = relay.url.replace('ws://', 'http://').replace('/v1', '');
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, nodes: 0, build });
    } finally {
      delete process.env.DROP_BUILD;
    }
  });

  it('falls back to an explicit absence instead of failing the probe', async () => {
    delete process.env.DROP_BUILD;
    const alice = await generateIdentity('Alice');
    const { relay } = await relayFor([alice]);
    const base = relay.url.replace('ws://', 'http://').replace('/v1', '');
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { ok: boolean; nodes: number; build: string };
    expect(body.build).toBe('unknown');
  });

  it('client reconnects after the relay restarts', async () => {
    const alice = await generateIdentity('Alice');
    const first = await startRelay({ port: 0, allowedNodeIds: [alice.nodeId] }, { logger: () => undefined });
    const a = client(first, alice);
    await a.instance.waitReady();
    const port = first.port;
    await first.close();
    await until(() => !a.instance.connected);
    const second = await startRelay({ port, allowedNodeIds: [alice.nodeId] }, { logger: () => undefined });
    cleanups.push(() => second.close());
    await until(() => a.instance.connected);
    expect(a.statuses.filter((status) => status === 'connected')).toHaveLength(2);
  });

  it('admits a newcomer who presents a ticket signed by an admitted node, once, and remembers it', async () => {
    const julie = await generateIdentity('Julie');
    const natha = await generateIdentity('Natha');
    const stranger = await generateIdentity('Stranger');
    const admittedPath = join(mkdtempSync(join(tmpdir(), 'relay-')), 'admitted.json');
    const { relay, logs } = await relayFor([julie], { admittedPath });
    const ticket = await createAdmission(julie);

    const n = client(relay, natha, ticket);
    await n.instance.waitReady();
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'admission', outcome: 'admitted', nodeId: natha.nodeId, sponsor: julie.nodeId }),
    );
    expect(readFileSync(admittedPath, 'utf8')).toContain(natha.nodeId);
    expectPrivateMode(admittedPath);

    const s = client(relay, stranger, ticket);
    await until(() => s.statuses.includes('unauthorized'));
    expect(logs).toContainEqual(expect.objectContaining({ event: 'admission', outcome: 'ticket_spent' }));

    n.instance.close();
    await relay.close();
    const { relay: restarted } = await relayFor([julie], { admittedPath });
    const again = client(restarted, natha);
    await again.instance.waitReady();
    expect(again.statuses).toContain('connected');
  });

  it('refuses tickets from a sponsor it does not admit, forged tickets and a sponsor over quota', async () => {
    const julie = await generateIdentity('Julie');
    const outsider = await generateIdentity('Outsider');
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((name) => generateIdentity(name)));
    if (!a || !b || !c) throw new Error('identities');
    const { relay, logs } = await relayFor([julie], { maxAdmissionsPerSponsorPerDay: 1 });

    const fromOutsider = client(relay, a, await createAdmission(outsider));
    await until(() => fromOutsider.statuses.includes('unauthorized'));
    const forged = { ...(await createAdmission(outsider)), sponsor: julie.nodeId };
    const withForged = client(relay, b, forged);
    await until(() => withForged.statuses.includes('unauthorized'));
    const first = client(relay, c, await createAdmission(julie));
    await first.instance.waitReady();
    const overQuota = client(relay, a, await createAdmission(julie));
    await until(() => overQuota.statuses.filter((status) => status === 'unauthorized').length > 0);

    const outcomes = logs.filter((entry) => entry.event === 'admission').map((entry) => entry.outcome);
    expect(outcomes).toEqual(
      expect.arrayContaining(['sponsor_not_admitted', 'bad_signature', 'admitted', 'sponsor_quota']),
    );
  });

  it('revokes a node without a restart: cut off at once, never back, and no longer a sponsor (T2.19)', async () => {
    const [julie, natha, paul] = await Promise.all(['Julie', 'Natha', 'Paul'].map((name) => generateIdentity(name)));
    if (!julie || !natha || !paul) throw new Error('identities');
    const dir = mkdtempSync(join(tmpdir(), 'relay-revoke-'));
    const revokedPath = join(dir, 'revoked.json');
    const { relay, logs } = await relayFor([julie], { admittedPath: join(dir, 'admitted.json'), revokedPath });
    const n = client(relay, natha, await createAdmission(julie));
    await n.instance.waitReady();

    revokeNode(revokedPath, natha.nodeId);
    expectPrivateMode(revokedPath);
    await until(() => n.statuses.includes('unauthorized'));
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'revocation', outcome: 'revoked', nodeId: natha.nodeId }),
    );

    // A fresh ticket from an admitted sponsor does not bring a revoked node back, and its own tickets are worthless.
    const again = client(relay, natha, await createAdmission(julie));
    await until(() => again.statuses.includes('unauthorized'));
    const viaNatha = client(relay, paul, await createAdmission(natha));
    await until(() => viaNatha.statuses.includes('unauthorized'));
    const outcomes = logs.filter((entry) => entry.event === 'admission').map((entry) => entry.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(['revoked', 'sponsor_not_admitted']));
    // Julie, who invited her, keeps her place.
    const j = client(relay, julie);
    await j.instance.waitReady();
  });

  it('applies a revocation file written while the relay starts, even with a busy thread pool', async () => {
    const natha = await generateIdentity('Natha');
    const dir = mkdtempSync(join(tmpdir(), 'relay-revoke-start-'));
    const revokedPath = join(dir, 'revoked.json');
    // Hold every libuv pool thread: a file check that relies on it runs only once the file below is already written.
    const poolSize = Math.max(4, Number(process.env.UV_THREADPOOL_SIZE ?? 4));
    const busy = Array.from(
      { length: poolSize * 2 },
      () =>
        new Promise<void>((resolve) => {
          pbkdf2('drop', 'pool', 150_000, 32, 'sha256', () => {
            resolve();
          });
        }),
    );
    const { logs } = await relayFor([natha], { revokedPath });
    revokeNode(revokedPath, natha.nodeId);
    await Promise.all(busy);
    await until(() =>
      logs.some(
        (entry) => entry.event === 'revocation' && entry.outcome === 'revoked' && entry.nodeId === natha.nodeId,
      ),
    );
  });

  it('revoking with --with-invited also cuts off the nodes it admitted, transitively (T2.19)', async () => {
    const [julie, natha, paul, zoe] = await Promise.all(
      ['Julie', 'Natha', 'Paul', 'Zoé'].map((name) => generateIdentity(name)),
    );
    if (!julie || !natha || !paul || !zoe) throw new Error('identities');
    const dir = mkdtempSync(join(tmpdir(), 'relay-cascade-'));
    const revokedPath = join(dir, 'revoked.json');
    const { relay } = await relayFor([julie], { admittedPath: join(dir, 'admitted.json'), revokedPath });
    const n = client(relay, natha, await createAdmission(julie));
    await n.instance.waitReady();
    const p = client(relay, paul, await createAdmission(natha));
    await p.instance.waitReady();
    const z = client(relay, zoe, await createAdmission(julie));
    await z.instance.waitReady();

    revokeNode(revokedPath, natha.nodeId, { withInvited: true });
    await until(() => n.statuses.includes('unauthorized') && p.statuses.includes('unauthorized'));
    expect(z.statuses).not.toContain('unauthorized');
    expect(readFileSync(revokedPath, 'utf8')).toContain('"withInvited": true');
  });

  it('caps admissions per day across all sponsors (T2.19)', async () => {
    const [julie, bob, a, b, c] = await Promise.all(
      ['Julie', 'Bob', 'A', 'B', 'C'].map((name) => generateIdentity(name)),
    );
    if (!julie || !bob || !a || !b || !c) throw new Error('identities');
    const { relay, logs } = await relayFor([julie, bob], { maxAdmissionsPerDay: 2 });
    await client(relay, a, await createAdmission(julie)).instance.waitReady();
    await client(relay, b, await createAdmission(bob)).instance.waitReady();
    const third = client(relay, c, await createAdmission(julie));
    await until(() => third.statuses.includes('unauthorized'));
    expect(logs).toContainEqual(expect.objectContaining({ event: 'admission', outcome: 'global_quota' }));
  });
});

/** Authenticates by hand on a raw socket, to send frames the regular client would refuse to build. */
function rawAuthed(relay: RelayHandle, identity: Identity, options: { autoPong?: boolean } = {}) {
  const socket = new WebSocket(relay.url, { autoPong: options.autoPong ?? true });
  const frames: { type: string; [key: string]: unknown }[] = [];
  const closed = new Promise<number>((resolve) => {
    socket.on('close', (code) => {
      resolve(code);
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : '{}') as {
        type: string;
        challenge?: string;
      };
      frames.push(frame);
      if (frame.type === 'challenge')
        void signDetached(identity, frame.challenge ?? '').then((sig) => {
          socket.send(JSON.stringify({ type: 'auth', nodeId: identity.nodeId, sig }));
        }, reject);
      if (frame.type === 'ready') resolve();
    });
  });
  cleanups.push(() => {
    socket.terminate();
  });
  return { socket, frames, ready, closed };
}

describe('relay contract', () => {
  it('opens every connection with a 32-byte challenge', async () => {
    const alice = await generateIdentity('Alice');
    const { relay } = await relayFor([alice]);
    const first = await new Promise<{ type: string; challenge: string }>((resolve) => {
      const socket = new WebSocket(relay.url);
      cleanups.push(() => {
        socket.terminate();
      });
      socket.once('message', (data) => {
        resolve(
          JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : '{}') as { type: string; challenge: string },
        );
      });
    });
    expect(first.type).toBe('challenge');
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(first.challenge, 'base64url')).toHaveLength(32);
  });

  it('refuses an envelope that breaks the schema, and routes one whose body it cannot read, unchanged', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const { relay, logs } = await relayFor([alice, bob]);
    const a = rawAuthed(relay, alice);
    const b = client(relay, bob);
    await Promise.all([a.ready, b.instance.waitReady()]);
    a.socket.send(JSON.stringify({ type: 'envelope', envelope: { to: bob.nodeId, body: 'x' } }));
    await until(() => a.frames.some((frame) => frame.type === 'error' && frame.error === 'E_SCHEMA'));
    expect(b.received).toEqual([]);
    // The relay holds no key: a body that is not even a sealed box goes through untouched.
    const valid = await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' });
    const opaque = { ...valid, body: Buffer.from('not a sealed box at all').toString('base64url') };
    a.socket.send(JSON.stringify({ type: 'envelope', envelope: opaque }));
    await until(() => b.received.length === 1);
    expect(b.received[0]).toEqual(opaque);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'envelope', outcome: 'E_SCHEMA', nodeId: alice.nodeId }),
    );
  });

  it('logs the id, from, to, size and outcome of each envelope, and keeps no copy once delivered', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const { relay, logs } = await relayFor([alice, bob]);
    const a = client(relay, alice);
    const b = client(relay, bob);
    await Promise.all([a.instance.waitReady(), b.instance.waitReady()]);
    const envelope = await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' });
    expect(await a.instance.send(envelope)).toBe('delivered');
    expect(logs).toContainEqual({
      event: 'envelope',
      outcome: 'delivered',
      id: envelope.id,
      from: alice.nodeId,
      to: bob.nodeId,
      size: expect.any(Number) as number,
    });
    // Bob comes back: nothing is delivered twice, the relay kept nothing.
    b.instance.close();
    const again = client(relay, bob);
    await again.instance.waitReady();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(again.received).toEqual([]);
  });

  it('caps the queue of an offline node at maxQueuePerNode', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const relay = await startRelay(
      { port: 0, allowedNodeIds: [alice.nodeId, bob.nodeId], maxQueuePerNode: 3, rateLimitPerMinute: 100 },
      { logger: () => undefined },
    );
    cleanups.push(() => relay.close());
    const a = client(relay, alice);
    await a.instance.waitReady();
    const outcomes: string[] = [];
    for (let index = 0; index < 4; index += 1)
      outcomes.push(await a.instance.send(await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' })));
    expect(outcomes).toEqual(['queued', 'queued', 'queued', 'E_QUEUE_FULL']);
    const b = client(relay, bob);
    await until(() => b.received.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(b.received).toHaveLength(3);
  });

  it('loses its queue when it restarts, as v1 assumes', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const first = await startRelay(
      { port: 0, allowedNodeIds: [alice.nodeId, bob.nodeId] },
      { logger: () => undefined },
    );
    const a = client(first, alice);
    await a.instance.waitReady();
    expect(await a.instance.send(await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' }))).toBe('queued');
    const port = first.port;
    await first.close();
    const second = await startRelay({ port, allowedNodeIds: [alice.nodeId, bob.nodeId] }, { logger: () => undefined });
    cleanups.push(() => second.close());
    const b = client(second, bob);
    await b.instance.waitReady();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(b.received).toEqual([]);
  });

  it('closes a node that misses two pings', async () => {
    const alice = await generateIdentity('Alice');
    const relay = await startRelay(
      { port: 0, allowedNodeIds: [alice.nodeId] },
      { logger: () => undefined, pingIntervalMs: 20 },
    );
    cleanups.push(() => relay.close());
    const mute = rawAuthed(relay, alice, { autoPong: false });
    await mute.ready;
    expect(await mute.closed).toBeGreaterThan(0);
  });

  it('drop-relay allow adds a node to relay.config.json, which a restart applies', async () => {
    const alice = await generateIdentity('Alice');
    const dir = mkdtempSync(join(tmpdir(), 'relay-allow-'));
    const configPath = join(dir, 'relay.config.json');
    writeFileSync(configPath, JSON.stringify({ port: 0, allowedNodeIds: [] }));
    expect(allowNode(configPath, alice.nodeId)).toBe(true);
    expect(allowNode(configPath, alice.nodeId)).toBe(false);
    expect(readRelayConfig(configPath).allowedNodeIds).toEqual([alice.nodeId]);
    const relay = await startRelay(readRelayConfig(configPath), { logger: () => undefined });
    cleanups.push(() => relay.close());
    await client(relay, alice).instance.waitReady();
  });
});

describe('relay hardening', () => {
  it('resolves revokedPath next to the config file, where drop-relay revoke writes it from any folder', async () => {
    const alice = await generateIdentity('Alice');
    const dir = mkdtempSync(join(tmpdir(), 'relay-revoked-path-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'relay-elsewhere-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    });
    const configPath = join(dir, 'relay.config.json');
    writeFileSync(configPath, JSON.stringify({ port: 0, allowedNodeIds: [], revokedPath: 'revoked.json' }));
    expect(readRelayConfig(configPath).revokedPath).toBe(join(dir, 'revoked.json'));
    execFileSync(process.execPath, [CLI, 'revoke', alice.nodeId, `--config=${configPath}`], {
      cwd: elsewhere,
      stdio: 'pipe',
    });
    expect(readFileSync(join(dir, 'revoked.json'), 'utf8')).toContain(alice.nodeId);
    expect(existsSync(join(elsewhere, 'revoked.json'))).toBe(false);
  });

  it('refuses an envelope for a node it does not admit, or one that would outlive the maximum TTL', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const stranger = await generateIdentity('Stranger');
    const { relay, logs } = await relayFor([alice, bob]);
    const a = client(relay, alice);
    await a.instance.waitReady();
    const seal = () => sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' });
    expect(await a.instance.send(await sealEnvelope(alice, stranger.nodeId, { type: 'catalog_request' }))).toBe(
      'E_SCHEMA',
    );
    const tooLong = await seal();
    expect(await a.instance.send({ ...tooLong, exp: tooLong.ts + MAX_TTL_MS + 1 })).toBe('E_SCHEMA');
    expect(await a.instance.send(await seal())).toBe('queued');
    const outcomes = logs.filter((entry) => entry.event === 'envelope').map((entry) => entry.outcome);
    expect(outcomes).toEqual(['unknown_recipient', 'ttl_too_long', 'queued']);
  });

  it('bounds the deferred queue across all recipients and sweeps expired envelopes before their owner returns', async () => {
    const [alice, bob, carol] = await Promise.all(['Alice', 'Bob', 'Carol'].map((name) => generateIdentity(name)));
    if (!alice || !bob || !carol) throw new Error('identities');
    const clock = { now: Date.now() };
    const sample = await sealEnvelope(alice, bob.nodeId, { type: 'catalog_request' });
    const { relay } = await relayFor(
      [alice, bob, carol],
      { maxQueueBytes: Math.floor(envelopeSize(sample) * 2.5), rateLimitPerMinute: 100 },
      { now: () => clock.now, pingIntervalMs: 20 },
    );
    const a = client(relay, alice);
    await a.instance.waitReady();
    const send = async (to: Identity, now = clock.now) =>
      a.instance.send(await sealEnvelope(alice, to.nodeId, { type: 'catalog_request' }, { now }));
    expect(await send(bob)).toBe('queued');
    // A sender's clock a year ahead: within the TTL by its own `ts`, yet held no longer than any other envelope.
    expect(await send(carol, clock.now + 365 * 86_400_000)).toBe('queued');
    expect(await send(carol)).toBe('E_QUEUE_FULL');
    // Neither Bob nor Carol comes back: the pinger alone frees the room their envelopes held.
    clock.now += MAX_TTL_MS + MAX_CLOCK_SKEW_MS + 1;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await send(bob)).toBe('queued');
    expect(await send(carol)).toBe('queued');
  });

  it('ignores a second auth frame while the first is checked, and never closes its own socket as replaced', async () => {
    const alice = await generateIdentity('Alice');
    const { relay, logs } = await relayFor([alice]);
    const socket = new WebSocket(relay.url);
    cleanups.push(() => {
      socket.terminate();
    });
    const frames: string[] = [];
    let closeCode: number | undefined;
    socket.on('close', (code) => {
      closeCode = code;
    });
    socket.on('message', (data) => {
      const frame = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : '{}') as {
        type: string;
        challenge?: string;
      };
      frames.push(frame.type);
      if (frame.type === 'challenge')
        void signDetached(alice, frame.challenge ?? '').then(
          (sig) => {
            const auth = JSON.stringify({ type: 'auth', nodeId: alice.nodeId, sig });
            socket.send(auth);
            socket.send(auth);
          },
          () => {
            socket.terminate();
          },
        );
    });
    await until(() => frames.includes('ready'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closeCode).toBeUndefined();
    expect(frames.filter((type) => type === 'ready')).toHaveLength(1);
    expect(logs.filter((entry) => entry.event === 'auth' && entry.outcome === 'ok')).toHaveLength(1);
  });

  it('keeps relay files at 0600 even when they already existed with a wider mode', async () => {
    const julie = await generateIdentity('Julie');
    const natha = await generateIdentity('Natha');
    const dir = mkdtempSync(join(tmpdir(), 'relay-private-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const plain = join(dir, 'plain.txt');
    writeFileSync(plain, 'old', { mode: 0o644 });
    chmodSync(plain, 0o644);
    writePrivate(plain, 'new');
    expect(readFileSync(plain, 'utf8')).toBe('new');
    expectPrivateMode(plain);

    const configPath = join(dir, 'relay.config.json');
    writeFileSync(configPath, JSON.stringify({ port: 0, allowedNodeIds: [] }), { mode: 0o644 });
    chmodSync(configPath, 0o644);
    allowNode(configPath, julie.nodeId);
    expectPrivateMode(configPath);
    chmodSync(configPath, 0o644);
    revokeInConfig(configPath, natha.nodeId);
    expectPrivateMode(configPath);

    const admittedPath = join(dir, 'admitted.json');
    writeFileSync(admittedPath, JSON.stringify({ admitted: [], spentNonces: [] }), { mode: 0o644 });
    chmodSync(admittedPath, 0o644);
    const { relay } = await relayFor([julie], { admittedPath });
    await client(relay, natha, await createAdmission(julie)).instance.waitReady();
    expectPrivateMode(admittedPath);
  });
});
