import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { generateIdentity, type Identity } from '@drop/protocol';
import { startRelay } from '@drop/relay';
import { startDaemon, type Daemon } from '../../node/src/daemon.ts';
import { DropHome, NodeConfigSchema } from '../../node/src/home.ts';
import { Bridge, linkPage, OAuthServer, pkceMatches, startGatewayHttp } from '../src/index.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const FIXTURE = resolve(
  import.meta.dirname,
  '..',
  '..',
  'capabilities',
  'test',
  'fixtures',
  'fake-design-mcp-stdio.ts',
);
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';

function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        done(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  });
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface LinkRequest {
  sessionId: string;
  clientId: string;
  clientName: string;
  redirectHost: string;
}

/** Registers an assistant, approves its link in the app with what the drop:// link shows, and connects it over MCP. */
async function linkedAssistant(
  publicUrl: string,
  name: string,
  callbackUrl: string,
  approve: (request: LinkRequest) => Promise<void>,
): Promise<Client> {
  const registered = (await (
    await fetch(`${publicUrl}/oauth/register`, {
      method: 'POST',
      body: JSON.stringify({ redirect_uris: [callbackUrl], client_name: name }),
    })
  ).json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL(`${publicUrl}/oauth/authorize`);
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: registered.client_id,
    redirect_uri: callbackUrl,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }))
    authorize.searchParams.set(key, value);
  const page = await (await fetch(authorize)).text();
  const link = /href="(drop:\/\/link\?[^"]+)"/.exec(page)?.[1]?.replaceAll('&#38;', '&') ?? '';
  const params = new URL(link).searchParams;
  const sessionId = params.get('session') ?? '';
  await approve({
    sessionId,
    clientId: params.get('client_id') ?? '',
    clientName: params.get('client') ?? '',
    redirectHost: params.get('redirect') ?? '',
  });
  await until(async () => {
    const status = (await (await fetch(`${publicUrl}/oauth/session/${sessionId}`)).json()) as { approved: boolean };
    return status.approved;
  });
  const complete = await fetch(`${publicUrl}/oauth/complete?session=${sessionId}`, { redirect: 'manual' });
  const code = new URL(complete.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const tokens = (await (
    await fetch(`${publicUrl}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: registered.client_id,
      }),
    })
  ).json()) as { access_token: string };
  const client = new Client({ name: `${name}-test`, version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    }),
  );
  return client;
}

async function daemonFor(identity: Identity, relayUrl: string): Promise<{ home: DropHome; daemon: Daemon }> {
  const home = new DropHome(join(mkdtempSync(join(tmpdir(), 'gw-home-')), 'home'));
  home.init(identity, NodeConfigSchema.parse({ profile: 'legacy', relayUrl, ownerKind: 'human', apiPort: 0 }));
  const daemon = await startDaemon(home, { apiPort: 0, notifications: false, log: () => undefined });
  cleanups.push(() => daemon.stop());
  return { home, daemon };
}

describe('consumer gateway: Claude or ChatGPT reach the team through the user’s node (T2.13)', () => {
  it('runs the whole connector flow: discovery, registration, approval in the app, PKCE, then ask_team over MCP', async () => {
    const [gatewayId, guillaume, julie] = await Promise.all([
      generateIdentity('drop gateway'),
      generateIdentity('Guillaume'),
      generateIdentity('Julie'),
    ]);
    const relay = await startRelay(
      { port: 0, allowedNodeIds: [gatewayId.nodeId, guillaume.nodeId, julie.nodeId] },
      { logger: () => undefined },
    );
    cleanups.push(() => relay.close());

    const g = await daemonFor(guillaume, relay.url);
    const j = await daemonFor(julie, relay.url);
    j.home.publish({
      capabilityId: 'mcp.answer.figma',
      approverNodeIds: [julie.nodeId],
      config: {
        label: 'mon Figma',
        server: { transport: 'stdio', command: process.execPath, args: [FIXTURE], env: [] },
        tools: ['get_design_context'],
      },
      publishedAt: new Date().toISOString(),
    });
    await Promise.all([g.daemon.relay.waitReady(), j.daemon.relay.waitReady()]);
    await g.daemon.engine.pair(await j.daemon.engine.invite(relay.url));
    await until(() => g.daemon.engine.peers().length === 1);

    const port = await freePort();
    const publicUrl = `http://127.0.0.1:${String(port)}`;
    const oauth = new OAuthServer({ resource: `${publicUrl}/mcp` });
    const bridge = new Bridge({
      identity: gatewayId,
      relayUrl: relay.url,
      claimPendingSession: (sessionId) => oauth.claimLink(sessionId),
      onLinkGrant: (sessionId, nodeId, claim) => oauth.approve(sessionId, nodeId, claim),
      isLinkedNode: (nodeId) => oauth.hasNode(nodeId),
      callTimeoutMs: 3000,
    });
    bridge.start();
    cleanups.push(() => {
      bridge.close();
    });
    const http = await startGatewayHttp({
      publicUrl,
      gatewayNodeId: gatewayId.nodeId,
      oauth,
      caller: { call: (link, tool, args) => bridge.call(link, tool, args) },
      port,
    });
    cleanups.push(() => http.close());
    await bridge.client.waitReady();

    // 1. Unauthenticated MCP call: 401 pointing at the resource metadata.
    const unauthorized = await fetch(`${publicUrl}/mcp`, { method: 'POST', body: '{}' });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`,
    );
    // 2. Discovery.
    const resourceMeta = (await (await fetch(`${publicUrl}/.well-known/oauth-protected-resource`)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(resourceMeta).toMatchObject({ resource: `${publicUrl}/mcp`, authorization_servers: [publicUrl] });
    const asMeta = (await (await fetch(`${publicUrl}/.well-known/oauth-authorization-server`)).json()) as Record<
      string,
      unknown
    >;
    expect(asMeta).toMatchObject({
      code_challenge_methods_supported: ['S256'],
      registration_endpoint: `${publicUrl}/oauth/register`,
    });
    // 3. Dynamic client registration.
    const registered = (await (
      await fetch(`${publicUrl}/oauth/register`, {
        method: 'POST',
        body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: 'Claude', token_endpoint_auth_method: 'none' }),
      })
    ).json()) as { client_id: string };
    // 4. Authorization request with PKCE: the page hands the decision to the drop app.
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = new URL(`${publicUrl}/oauth/authorize`);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: registered.client_id,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: `${publicUrl}/mcp`,
    }))
      authorize.searchParams.set(key, value);
    const page = await (await fetch(authorize)).text();
    const link = /href="(drop:\/\/link\?[^"]+)"/.exec(page)?.[1]?.replaceAll('&#38;', '&') ?? '';
    const params = new URL(link).searchParams;
    expect(params.get('gateway')).toBe(gatewayId.nodeId);
    expect(params.get('client')).toBe('Claude');
    expect(params.get('client_id')).toBe(registered.client_id);
    expect(params.get('redirect')).toBe('claude.ai');
    expect(page).toContain('claude.ai');
    const sessionId = params.get('session') ?? '';
    // 5. The user approves in the app (the panel calls this); the node sends its signed link_grant.
    await g.daemon.engine.linkAssistant(gatewayId.nodeId, {
      sessionId,
      clientId: registered.client_id,
      clientName: 'Claude',
      redirectHost: 'claude.ai',
    });
    await until(async () => {
      const status = (await (await fetch(`${publicUrl}/oauth/session/${sessionId}`)).json()) as { approved: boolean };
      return status.approved;
    });
    // 6. Code back to the assistant, then the token exchange with the verifier.
    const complete = await fetch(`${publicUrl}/oauth/complete?session=${sessionId}`, { redirect: 'manual' });
    const callback = new URL(complete.headers.get('location') ?? '');
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK);
    expect(callback.searchParams.get('state')).toBe('xyz');
    const tokenForm = new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code') ?? '',
      code_verifier: verifier,
      client_id: registered.client_id,
      redirect_uri: CALLBACK,
      resource: `${publicUrl}/mcp`,
    });
    const tokens = (await (await fetch(`${publicUrl}/oauth/token`, { method: 'POST', body: tokenForm })).json()) as {
      access_token: string;
      refresh_token: string;
    };
    const replayed = await fetch(`${publicUrl}/oauth/token`, { method: 'POST', body: tokenForm });
    expect(replayed.status).toBe(400);

    // 7. The assistant asks in plain language; the user's node routes it to Julie's Figma.
    const client = new Client({ name: 'claude-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    }) as Transport;
    await client.connect(transport);
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'ask_team',
      'get_drop_results',
      'list_capabilities',
    ]);
    const asked = await client.callTool({
      name: 'ask_team',
      arguments: { question: 'Le bouton de paiement de la maquette est-il prêt ?' },
    });
    const text = (asked.content as { text: string }[])[0]?.text ?? '';
    expect(text).toContain('Julie (« Répondre à partir de mon Figma »)');
    await until(() => j.daemon.engine.pending().length === 1);

    // 8. ChatGPT is linked too, through the same gateway. Removing Claude in the app cuts Claude off, not ChatGPT.
    const chatgpt = await linkedAssistant(publicUrl, 'ChatGPT', CHATGPT_CALLBACK, async (request) => {
      await g.daemon.engine.linkAssistant(gatewayId.nodeId, request);
    });
    cleanups.push(() => chatgpt.close());
    g.daemon.engine.unlinkAssistant(gatewayId.nodeId, 'Claude');
    const cut = await client.callTool({ name: 'list_capabilities', arguments: {} });
    expect(cut.isError).toBe(true);
    const kept = await chatgpt.callTool({ name: 'list_capabilities', arguments: {} });
    expect(kept.isError).toBeFalsy();
  }, 40_000);

  it('binds a link only to the assistant and return domain the user saw in the app (consent phishing)', () => {
    const oauth = new OAuthServer({ resource: 'https://drop.example/mcp' });
    // Someone registers a client called "Claude" that returns to their own server, and sends the authorize page around.
    const { client_id } = oauth.register({ redirect_uris: ['https://evil.example/cb'], client_name: 'Claude' }) as {
      client_id: string;
    };
    const session = oauth.authorize(
      new URLSearchParams({
        response_type: 'code',
        client_id,
        redirect_uri: 'https://evil.example/cb',
        code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
        code_challenge_method: 'S256',
      }),
    );
    expect(linkPage({ session, gatewayNodeId: 'gw', clientName: 'Claude' })).toContain('evil.example');
    const injected = linkPage({ session, gatewayNodeId: 'gw', clientName: '</script><script>alert(1)</script>' });
    expect(injected).not.toContain('<script>alert');
    const node = 'node-of-the-victim';
    // A forged drop:// link made the app show claude.ai: the gateway refuses the grant, the session stays unbound.
    expect(
      oauth.approve(session.id, node, { clientId: client_id, clientName: 'Claude', redirectHost: 'claude.ai' }),
    ).toBe(false);
    expect(
      oauth.approve(session.id, node, { clientId: 'x'.repeat(24), clientName: 'Claude', redirectHost: 'evil.example' }),
    ).toBe(false);
    expect(
      oauth.approve(session.id, node, { clientId: client_id, clientName: 'ChatGPT', redirectHost: 'evil.example' }),
    ).toBe(false);
    expect(oauth.session(session.id)?.nodeId).toBeUndefined();
    // What the user really saw (and was warned about): only then is the session bound.
    expect(
      oauth.approve(session.id, node, { clientId: client_id, clientName: 'Claude', redirectHost: 'evil.example' }),
    ).toBe(true);
  });

  it('forgets clients that never got a token after a day, and the oldest pending client or session beyond its limits', () => {
    let now = 1_000_000;
    const oauth = new OAuthServer({
      resource: 'https://drop.example/mcp',
      now: () => now,
      maxPendingClients: 2,
      maxSessions: 2,
    });
    const register = () =>
      (oauth.register({ redirect_uris: [CALLBACK], client_name: 'Claude' }) as { client_id: string }).client_id;
    const first = register();
    const second = register();
    const third = register();
    // A flood of registrations evicts the oldest pending one rather than locking everyone out.
    expect(oauth.client(first)).toBeUndefined();
    expect(oauth.client(third)).toBeDefined();
    const authorize = () =>
      oauth.authorize(
        new URLSearchParams({
          response_type: 'code',
          client_id: third,
          redirect_uri: CALLBACK,
          code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
          code_challenge_method: 'S256',
        }),
      );
    const oldest = authorize();
    authorize();
    const newest = authorize();
    expect(oauth.session(oldest.id)).toBeUndefined();
    expect(oauth.session(newest.id)).toBeDefined();
    now += 24 * 60 * 60_000;
    expect(oauth.client(second)).toBeDefined();
    register();
    expect(oauth.client(second)).toBeUndefined();
  });

  it('refuses unregistered redirects, plain PKCE and a foreign resource', () => {
    const oauth = new OAuthServer({ resource: 'https://drop.example/mcp' });
    expect(() => oauth.register({ redirect_uris: ['http://evil.example/cb'] })).toThrow(/https/);
    const { client_id } = oauth.register({ redirect_uris: [CALLBACK], client_name: 'ChatGPT' }) as {
      client_id: string;
    };
    const base = {
      response_type: 'code',
      client_id,
      redirect_uri: CALLBACK,
      code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
      code_challenge_method: 'S256',
    };
    expect(() => oauth.authorize(new URLSearchParams({ ...base, redirect_uri: 'https://evil.example/cb' }))).toThrow(
      /registered/,
    );
    expect(() => oauth.authorize(new URLSearchParams({ ...base, code_challenge_method: 'plain' }))).toThrow(/S256/);
    expect(() => oauth.authorize(new URLSearchParams({ ...base, resource: 'https://other.example/mcp' }))).toThrow(
      /resource/,
    );
    const session = oauth.authorize(new URLSearchParams(base));
    expect(() => oauth.complete(session.id)).toThrow(/not approved/);
    expect(pkceMatches('v'.repeat(43), base.code_challenge)).toBe(true);
    expect(pkceMatches('w'.repeat(43), base.code_challenge)).toBe(false);
    expect(oauth.verify('not-a-token')).toBeUndefined();
  });
});
