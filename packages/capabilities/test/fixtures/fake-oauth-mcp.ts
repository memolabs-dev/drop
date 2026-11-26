import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/**
 * A stand-in for a remote MCP server behind OAuth, like Notion's (T2.17): protected resource and authorization server
 * metadata, dynamic client registration, authorization code with PKCE S256 and an automatic consent (the test plays
 * the browser), access and refresh tokens, and /mcp that answers 401 without a valid access token.
 */
export interface FakeOAuthMcp {
  url: string;
  registrations: string[];
  /** Makes every access token issued so far invalid, as an expiry would: the next call must refresh. */
  expireAccessTokens(): void;
  /** Makes refresh tokens invalid too, as a revocation in the server's settings would. */
  revokeAll(): void;
  close(): Promise<void>;
}

const random = (): string => randomBytes(24).toString('base64url');

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

function mcp(): McpServer {
  const server = new McpServer({ name: 'fake-notion', version: '1.0.0' });
  server.registerTool(
    'notion-search',
    { description: 'Search pages.', inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
    ({ query }) => ({ content: [{ type: 'text', text: `Atlas roadmap (match for ${query})` }] }),
  );
  server.registerTool(
    'notion-update-page',
    { description: 'Update a page.', inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
    () => ({ content: [{ type: 'text', text: 'updated' }] }),
  );
  return server;
}

export async function startFakeOAuthMcp(): Promise<FakeOAuthMcp> {
  const clients = new Map<string, string[]>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string }>();
  let access = new Set<string>();
  let refresh = new Set<string>();
  const registrations: string[] = [];
  let base = '';

  const issue = () => {
    const tokens = { access_token: random(), token_type: 'Bearer', expires_in: 3600, refresh_token: random() };
    access.add(tokens.access_token);
    refresh.add(tokens.refresh_token);
    return tokens;
  };

  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', base);
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
        return;
      }
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/register') {
        const body = JSON.parse(await readBody(req)) as { client_name?: string; redirect_uris: string[] };
        const clientId = random();
        clients.set(clientId, body.redirect_uris);
        registrations.push(body.client_name ?? '');
        json(201, { ...body, client_id: clientId, token_endpoint_auth_method: 'none' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/authorize') {
        // Automatic consent: straight back to the client with a code.
        const clientId = url.searchParams.get('client_id') ?? '';
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        if (!clients.get(clientId)?.includes(redirectUri) || url.searchParams.get('code_challenge_method') !== 'S256') {
          json(400, { error: 'invalid_request' });
          return;
        }
        const code = random();
        codes.set(code, { clientId, redirectUri, challenge: url.searchParams.get('code_challenge') ?? '' });
        const back = new URL(redirectUri);
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        res.writeHead(302, { Location: back.toString() });
        res.end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        const form = new URLSearchParams(await readBody(req));
        if (form.get('grant_type') === 'authorization_code') {
          const entry = codes.get(form.get('code') ?? '');
          codes.delete(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          if (
            !entry ||
            entry.clientId !== form.get('client_id') ||
            createHash('sha256').update(verifier).digest('base64url') !== entry.challenge
          ) {
            json(400, { error: 'invalid_grant' });
            return;
          }
          json(200, issue());
          return;
        }
        if (form.get('grant_type') === 'refresh_token' && refresh.delete(form.get('refresh_token') ?? '')) {
          json(200, issue());
          return;
        }
        json(400, { error: 'invalid_grant' });
        return;
      }
      if (url.pathname === '/mcp') {
        const header = req.headers.authorization ?? '';
        if (!access.has(header.replace(/^Bearer /, ''))) {
          json(
            401,
            { error: 'invalid_token' },
            {
              'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
            },
          );
          return;
        }
        const body: unknown = req.method === 'POST' ? JSON.parse((await readBody(req)) || 'null') : undefined;
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        const server = mcp();
        res.on('close', () => {
          transport.close().catch(() => undefined);
          server.close().catch(() => undefined);
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      json(404, { error: 'not_found' });
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  const address = http.address();
  base = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
  return {
    url: `${base}/mcp`,
    registrations,
    expireAccessTokens: () => {
      access = new Set();
    },
    revokeAll: () => {
      access = new Set();
      refresh = new Set();
    },
    close: () =>
      new Promise<void>((done) => {
        http.close(() => {
          done();
        });
        http.closeAllConnections();
      }),
  };
}
