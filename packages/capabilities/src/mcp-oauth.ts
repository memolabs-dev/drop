import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';
import { DropError } from '@drop/protocol';
import { McpConnectError } from './mcp-answer.ts';

/**
 * OAuth for the owner's remote MCP servers (T2.17, D74), such as Notion's: drop registers itself as its own client
 * (dynamic registration, client name "drop"), the owner signs in once in their browser, and the tokens stay on their
 * machine, mode 0600 under DROP_HOME/oauth. They are never logged nor sent to a peer, and the tools a colleague's
 * question may use stay the ones chosen when sharing (D19). Built on the MCP SDK's OAuth client.
 */
export const SIGN_IN_TTL_MS = 10 * 60_000;

const RecordSchema = z.object({
  serverUrl: z.string(),
  client: z.record(z.string(), z.unknown()).optional(),
  tokens: z.record(z.string(), z.unknown()).optional(),
});
type OAuthRecord = z.infer<typeof RecordSchema>;

/** One file per server under `directory`, named by a hash of its URL; the directory is 0700 and each file 0600. */
export class OAuthStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }

  private path(serverUrl: string): string {
    return join(this.directory, `${createHash('sha256').update(normalize(serverUrl)).digest('hex').slice(0, 32)}.json`);
  }

  read(serverUrl: string): OAuthRecord {
    const path = this.path(serverUrl);
    if (!existsSync(path)) return { serverUrl: normalize(serverUrl) };
    return RecordSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  }

  update(serverUrl: string, change: (record: OAuthRecord) => OAuthRecord): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const path = this.path(serverUrl);
    writeFileSync(path, `${JSON.stringify(change(this.read(serverUrl)), null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  hasTokens(serverUrl: string): boolean {
    return this.read(serverUrl).tokens !== undefined;
  }
}

function normalize(serverUrl: string): string {
  const url = new URL(serverUrl);
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}

/**
 * The SDK's view of drop as an OAuth client of one server. Without `signIn` it only reuses and refreshes stored tokens:
 * a run never starts a sign-in nor touches one in progress. With `signIn`, the code verifier and the state live in
 * memory, with the sign-in that needs them.
 */
class DropOAuthProvider implements OAuthClientProvider {
  private verifier: string | undefined;
  /** The refresh token this provider handed to the SDK, to tell its own stale tokens from a concurrent refresh's. */
  private usedRefresh: unknown;
  private readonly store: OAuthStore;
  private readonly serverUrl: string;
  private readonly redirect: string;
  private readonly signIn: { state: string; onRedirect: (url: URL) => void } | undefined;

  constructor(
    store: OAuthStore,
    serverUrl: string,
    redirect: string,
    signIn?: { state: string; onRedirect: (url: URL) => void },
  ) {
    this.store = store;
    this.serverUrl = serverUrl;
    this.redirect = redirect;
    this.signIn = signIn;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'drop',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    // During a run the SDK asks for a state only to start an authorization that redirectToAuthorization drops.
    return this.signIn?.state ?? randomBytes(24).toString('base64url');
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.store.read(this.serverUrl).client as OAuthClientInformationMixed | undefined;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.store.update(this.serverUrl, (record) => ({ ...record, client: { ...client } }));
  }

  tokens(): OAuthTokens | undefined {
    const tokens = this.store.read(this.serverUrl).tokens as OAuthTokens | undefined;
    this.usedRefresh = tokens?.refresh_token;
    return tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.update(this.serverUrl, (record) => ({ ...record, tokens: { ...tokens } }));
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // During a run there is nobody to sign in: the SDK then fails with UnauthorizedError, reported as `oauth`.
    this.signIn?.onRedirect(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    if (this.signIn) this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new DropError('E_RUNNER', 'no code verifier for this sign-in');
    return this.verifier;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier' || scope === 'discovery') {
      if (scope === 'verifier') this.verifier = undefined;
      return;
    }
    this.store.update(this.serverUrl, (record) => {
      // Two runs refreshing at once: the loser must not erase the tokens the winner just saved.
      if (scope === 'tokens' && record.tokens?.refresh_token !== this.usedRefresh) return record;
      return { serverUrl: record.serverUrl, ...(scope === 'tokens' && record.client ? { client: record.client } : {}) };
    });
  }
}

/**
 * For runs and sharing: a provider for a server drop already signed in to, so the SDK sends and refreshes its tokens;
 * none otherwise, so that a server needing OAuth fails plainly (`oauth`) without registering anything.
 */
export function runtimeOAuth(
  store: OAuthStore,
  redirectUrl: string,
): (serverUrl: string) => OAuthClientProvider | undefined {
  return (serverUrl) => (store.hasTokens(serverUrl) ? new DropOAuthProvider(store, serverUrl, redirectUrl) : undefined);
}

interface PendingSignIn {
  serverUrl: string;
  transport: StreamableHTTPClientTransport;
  expiresAt: number;
}

/**
 * Sign-ins in progress, keyed by their single-use `state`. `start` registers drop if needed and returns the URL to open
 * in the browser; `complete` takes the code the browser brings back to the local API, at most once, within 10 minutes.
 */
export class OAuthSignIns {
  private readonly pending = new Map<string, PendingSignIn>();
  private readonly store: OAuthStore;
  private readonly redirectUrl: () => string;
  private readonly now: () => number;

  constructor(options: { store: OAuthStore; redirectUrl: () => string; now?: () => number }) {
    this.store = options.store;
    this.redirectUrl = options.redirectUrl;
    this.now = options.now ?? Date.now;
  }

  async start(
    serverUrl: string,
  ): Promise<{ connected: true } | { connected: false; authorizationUrl: string; state: string }> {
    this.sweep();
    const state = randomBytes(24).toString('base64url');
    let authorizationUrl: URL | undefined;
    const provider = new DropOAuthProvider(this.store, serverUrl, this.redirectUrl(), {
      state,
      onRedirect: (url) => {
        authorizationUrl = url;
      },
    });
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider });
    const client = new Client({ name: 'drop-sign-in', version: '1.0.0' });
    try {
      await client.connect(transport);
      await client.close();
      return { connected: true };
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || !authorizationUrl) {
        throw new McpConnectError(
          'unreachable',
          `the MCP server ${new URL(serverUrl).host} did not start a sign-in: ${error instanceof Error ? error.message : 'failed'}`,
        );
      }
    }
    if (authorizationUrl.protocol !== 'https:' && !isLoopback(authorizationUrl)) {
      throw new McpConnectError('unreachable', `refusing a sign-in page that is not https: ${authorizationUrl.origin}`);
    }
    this.pending.set(state, { serverUrl, transport, expiresAt: this.now() + SIGN_IN_TTL_MS });
    return { connected: false, authorizationUrl: authorizationUrl.toString(), state };
  }

  /** Exchanges the code for tokens; returns the server's host. Unknown, expired or reused states are refused. */
  async complete(state: string, code: string): Promise<string> {
    this.sweep();
    const entry = this.pending.get(state);
    this.pending.delete(state);
    if (!entry) throw new DropError('E_RUNNER', 'E_OAUTH_STATE: no sign-in in progress for this state');
    try {
      await entry.transport.finishAuth(code);
    } finally {
      await entry.transport.close();
    }
    return new URL(entry.serverUrl).host;
  }

  private sweep(): void {
    const now = this.now();
    for (const [state, entry] of this.pending)
      if (entry.expiresAt <= now) {
        this.pending.delete(state);
        // An abandoned sign-in: closing its transport can only fail if it is already closed.
        entry.transport.close().catch(() => undefined);
      }
  }
}

function isLoopback(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}
