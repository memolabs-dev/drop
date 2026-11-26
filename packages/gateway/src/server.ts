import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ASK_TEAM_DESCRIPTION,
  AskTeamInput,
  GetResultsInput,
  LIST_DESCRIPTION,
  RESULTS_DESCRIPTION,
} from '@drop/requester-mcp';
import { OAuthError, redirectHost, type OAuthServer, type Session } from './oauth.ts';

/**
 * The consumer connector's HTTP surface (T2.13, D31), behind Traefik on https://drop.memolabs.dev:
 * - /.well-known/oauth-protected-resource[/mcp] (RFC 9728) and /.well-known/oauth-authorization-server (RFC 8414);
 * - /oauth/register, /oauth/authorize (the page that opens the drop app), /oauth/session/<id>, /oauth/complete, /oauth/token;
 * - /mcp, the MCP server ChatGPT and Claude call with their bearer token, one stateless transport per request.
 */
export interface Caller {
  call(
    link: { nodeId: string; clientId: string },
    tool: 'ask_team' | 'get_drop_results' | 'list_capabilities',
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }>;
}

export interface GatewayHttpOptions {
  /** e.g. https://drop.memolabs.dev, no trailing slash. */
  publicUrl: string;
  gatewayNodeId: string;
  oauth: OAuthServer;
  caller: Caller;
  port: number;
  host?: string;
}

const MAX_BODY = 64 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY) throw new OAuthError('invalid_request', 'body too large', 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${String(char.charCodeAt(0))};`);
}

/** A JSON string literal safe inside <script>: a client name such as `</script><script>…` cannot close it. */
function scriptString(text: string): string {
  return JSON.stringify(text).replace(/</g, '\\u003c');
}

/**
 * The page the assistant opens: one button that hands the decision to the user's drop app. The link carries the
 * client and the domain the answer returns to, which the app shows and the node's link_grant must repeat (D71).
 */
export function linkPage(options: { session: Session; gatewayNodeId: string; clientName: string }): string {
  const host = redirectHost(options.session.redirectUri);
  const link = new URL('drop://link');
  link.searchParams.set('session', options.session.id);
  link.searchParams.set('gateway', options.gatewayNodeId);
  link.searchParams.set('client', options.clientName);
  link.searchParams.set('client_id', options.session.clientId);
  link.searchParams.set('redirect', host);
  const client = `${escapeHtml(options.clientName)} (${escapeHtml(host)})`;
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relier ${client} à drop</title>
<style>
body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#F7F6F3;color:#1A1A19;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:420px;padding:32px;background:#fff;border:1px solid #DAD8D2;border-radius:16px;margin:16px}
h1{font-size:20px;margin:0 0 12px}p{color:#55534E}
a.button{display:block;text-align:center;background:#0E5F58;color:#fff;text-decoration:none;padding:12px;border-radius:10px;font-weight:600;margin:20px 0 8px}
.wait{font-size:13px;color:#6B6862;text-align:center}
@media (prefers-color-scheme: dark){body{background:#1C1C1B;color:#F2F1EE}main{background:#262624;border-color:#3D3C38}p{color:#C9C6BE}}
</style></head>
<body><main>
<h1>Relier ${client} à ton équipe drop</h1>
<p>${client} pourra poser des questions à tes collègues en ton nom. Chaque collègue accepte ou refuse chaque question ; personne ne reçoit d’accès.</p>
<a class="button" href="${escapeHtml(link.toString())}">Ouvrir drop pour autoriser</a>
<p class="wait" id="wait">En attente de ton accord dans l’app drop…</p>
<p class="wait">Pas encore drop sur ton Mac ? Installe l’app, puis reviens sur cette page.</p>
</main>
<script>
(function () {
  var id = ${scriptString(options.session.id)};
  function poll() {
    fetch('/oauth/session/' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (s) {
      if (s.approved) { location.href = '/oauth/complete?session=' + encodeURIComponent(id); return; }
      if (s.expired) { document.getElementById('wait').textContent = 'Cette demande a expiré. Recommence depuis ' + ${scriptString(options.clientName)} + '.'; return; }
      setTimeout(poll, 1500);
    }, function () { setTimeout(poll, 3000); });
  }
  poll();
})();
</script>
</body></html>`;
}

function mcpServer(caller: Caller, link: { nodeId: string; clientId: string }): McpServer {
  const server = new McpServer({ name: 'drop', version: '0.1.0' });
  const reply = (result: { text: string; isError: boolean }) => ({
    content: [{ type: 'text' as const, text: result.text }],
    ...(result.isError ? { isError: true } : {}),
  });
  server.registerTool(
    'ask_team',
    {
      description: ASK_TEAM_DESCRIPTION,
      inputSchema: AskTeamInput,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => reply(await caller.call(link, 'ask_team', args)),
  );
  server.registerTool(
    'get_drop_results',
    { description: RESULTS_DESCRIPTION, inputSchema: GetResultsInput, annotations: { readOnlyHint: true } },
    async (args) =>
      reply(await caller.call(link, 'get_drop_results', { ...args, wait_seconds: Math.min(args.wait_seconds, 40) })),
  );
  server.registerTool(
    'list_capabilities',
    { description: LIST_DESCRIPTION, annotations: { readOnlyHint: true } },
    async () => reply(await caller.call(link, 'list_capabilities', {})),
  );
  return server;
}

export function startGatewayHttp(
  options: GatewayHttpOptions,
): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const { oauth, publicUrl } = options;
  const resourceMetadata = `${publicUrl}/.well-known/oauth-protected-resource`;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', publicUrl);
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (
      method === 'GET' &&
      (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')
    ) {
      json(res, 200, {
        resource: oauth.resource,
        authorization_servers: [publicUrl],
        bearer_methods_supported: ['header'],
        resource_name: 'drop',
      });
      return;
    }
    if (method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      json(res, 200, {
        issuer: publicUrl,
        authorization_endpoint: `${publicUrl}/oauth/authorize`,
        token_endpoint: `${publicUrl}/oauth/token`,
        registration_endpoint: `${publicUrl}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }
    if (method === 'POST' && path === '/oauth/register') {
      json(res, 201, oauth.register(JSON.parse((await readBody(req)) || '{}')));
      return;
    }
    if (method === 'GET' && path === '/oauth/authorize') {
      const session = oauth.authorize(url.searchParams);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
        'Referrer-Policy': 'no-referrer',
      });
      res.end(
        linkPage({
          session,
          gatewayNodeId: options.gatewayNodeId,
          clientName: oauth.client(session.clientId)?.clientName ?? 'Un assistant',
        }),
      );
      return;
    }
    const sessionMatch = /^\/oauth\/session\/([A-Za-z0-9_-]{16,64})$/.exec(path);
    if (method === 'GET' && sessionMatch?.[1]) {
      const session = oauth.session(sessionMatch[1]);
      json(res, 200, { approved: session?.nodeId !== undefined, expired: session === undefined });
      return;
    }
    if (method === 'GET' && path === '/oauth/complete') {
      res.writeHead(302, {
        Location: oauth.complete(url.searchParams.get('session') ?? ''),
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }
    if (method === 'POST' && path === '/oauth/token') {
      json(res, 200, oauth.token(new URLSearchParams(await readBody(req))));
      return;
    }
    if (path === '/mcp') {
      const header = req.headers.authorization ?? '';
      const record = header.startsWith('Bearer ') ? oauth.verify(header.slice('Bearer '.length)) : undefined;
      if (!record) {
        json(
          res,
          401,
          { error: 'invalid_token' },
          { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadata}"` },
        );
        return;
      }
      const body: unknown = method === 'POST' ? JSON.parse((await readBody(req)) || 'null') : undefined;
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      const server = mcpServer(options.caller, { nodeId: record.nodeId, clientId: record.clientId });
      res.on('close', () => {
        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    if (method === 'GET' && path === '/gateway/health') {
      json(res, 200, { ok: true });
      return;
    }
    json(res, 404, { error: 'not_found' });
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return;
      if (error instanceof OAuthError) json(res, error.status, { error: error.code, error_description: error.message });
      else
        json(res, error instanceof SyntaxError ? 400 : 500, {
          error: error instanceof SyntaxError ? 'invalid_request' : 'server_error',
        });
    });
  });
  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host ?? '127.0.0.1', () => {
      const address = http.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      resolve({
        server: http,
        port,
        close: () =>
          new Promise<void>((done) => {
            http.close(() => {
              done();
            });
            http.closeAllConnections();
          }),
      });
    });
  });
}
