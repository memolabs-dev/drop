import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite, encodeInvite, generateIdentity } from '../packages/protocol/src/index.ts';
import { buildSite, collectSite, joinCsp, startSite } from '../scripts/site.ts';

interface Stub {
  textContent: string;
  hidden: boolean;
  href: string;
  value: string;
  className: string;
  selected: boolean;
  listeners: Record<string, () => void>;
  select(): void;
  addEventListener(type: string, listener: () => void): void;
}

function stub(): Stub {
  return {
    textContent: '',
    hidden: false,
    href: '#contenu',
    value: '',
    className: '',
    selected: false,
    listeners: {},
    select() {
      this.selected = true;
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  };
}

/** Runs the page's inline script against a minimal DOM: what it shows, where it points, what it tried to keep. */
function runJoinScript(script: string, hash: string, userAgent: string, stored = new Map<string, string>()) {
  const elements = new Map<string, Stub>();
  const byId = (id: string): Stub => {
    const found = elements.get(id) ?? stub();
    elements.set(id, found);
    return found;
  };
  const order: string[] = ['mac', 'windows', 'linux'];
  const parent = {
    get firstChild() {
      return order[0];
    },
    insertBefore(item: { os: string }) {
      order.splice(order.indexOf(item.os), 1);
      order.unshift(item.os);
    },
  };
  const items = order.map((os) => ({
    os,
    link: stub(),
    parentNode: parent,
    getAttribute: () => os,
    querySelector() {
      return this.link;
    },
  }));
  const replaced: string[] = [];
  runInNewContext(script, {
    document: { getElementById: byId, querySelectorAll: () => items },
    location: { hash, pathname: '/join' },
    history: { replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url) },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    navigator: { userAgent },
    atob,
    TextDecoder,
    Uint8Array,
    Intl,
    Date,
    JSON,
    String,
  });
  return { byId, order, items, replaced, stored };
}

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36';

describe('join page (T4.23)', () => {
  let preview: Awaited<ReturnType<typeof startSite>>;
  let assets: Map<string, Buffer>;
  let html: string;
  let script: string;

  beforeAll(async () => {
    assets = await collectSite({ installs: 'beta', contact: '' });
    html = assets.get('/join.html')?.toString('utf8') ?? '';
    script = /<script>([\s\S]*?)<\/script[^>]*>/i.exec(html)?.[1] ?? '';
    preview = await startSite(assets, 0);
  });

  afterAll(async () => {
    await preview.stop();
  });

  it('serves /join under a policy that pins its one script and allows no connection, other pages keep none', async () => {
    const hash = createHash('sha256').update(script, 'utf8').digest('base64');
    for (const path of ['/join', '/join/', '/join.html', '/join/index.html']) {
      const response = await fetch(`${preview.url}${path}`);
      expect(response.status, path).toBe(200);
      const policy = response.headers.get('content-security-policy') ?? '';
      expect(policy, path).toContain(`script-src 'sha256-${hash}'`);
      expect(policy, path).toContain("connect-src 'none'");
      expect(policy, path).toContain("default-src 'none'");
      expect(policy, path).toContain("form-action 'none'");
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
    expect(html).toContain(`content="default-src 'none'; script-src 'sha256-${hash}'`);
    expect(html).not.toContain('{{');
    expect((await fetch(`${preview.url}/demarrer.html`)).headers.get('content-security-policy')).toContain(
      "script-src 'none'",
    );
    // No resource from elsewhere: styles, icon and links to the site are on this origin.
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const target = match[1] ?? '';
      expect(
        target.startsWith('/') ||
          target.startsWith('#') ||
          target === 'https://github.com/memolabs-dev/drop/releases/latest',
        target,
      ).toBe(true);
    }
    expect(html).not.toMatch(/<(?:link|script|img)\b[^>]*(?:src|href)="https?:/);
  });

  it('pins a join page only when it holds exactly one plain inline script, whatever the case of any other', () => {
    expect(joinCsp('<p></p><script>run()</script>')).toContain("script-src 'sha256-");
    for (const page of [
      '<script>run()</script><SCRIPT>steal()</SCRIPT>',
      '<script>run()</script><script type="module">steal()</script>',
      '<script>run()</script><script>steal()</script >',
      '<script>run()</script><Script src="/x.js"></Script>',
      '<script defer>run()</script>',
      '<script>run()</script><script>never closed',
      '<p>no script</p>',
    ]) {
      expect(() => joinCsp(page), page).toThrow('E_SITE_JOIN');
    }
  });

  it('never sends the invite anywhere and writes names as text only', () => {
    for (const forbidden of [
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'sendBeacon',
      'EventSource',
      'innerHTML',
      'outerHTML',
      'document.write',
      'eval(',
      'Function(',
      'import(',
      'new Image',
      '.src',
      'window.open',
      'location.href',
      'location.assign',
      'postMessage',
    ])
      expect(script, forbidden).not.toContain(forbidden);
  });

  it('shows who invites, offers the matching download, opens drop://join and drops the fragment', async () => {
    const guillaume = await generateIdentity('Guillaume');
    const code = encodeInvite(
      await createInvite(guillaume, 'wss://drop.memolabs.dev/v1', Date.now(), undefined, {
        teamId: 'atelier-team-0001',
        name: 'Atelier',
      }),
    );
    const page = runJoinScript(script, `#${code}`, WINDOWS);
    expect(page.byId('join-title').textContent).toBe('Guillaume t’invite dans l’équipe Atelier');
    expect(page.byId('join-open').href).toBe(`drop://join?invite=${code}`);
    expect(page.byId('join-code').value).toBe(code);
    expect(page.byId('join-status').hidden).toBe(false);
    expect(page.byId('join-status').textContent).toBe('');
    expect(page.byId('join-expires').textContent).toContain('valable jusqu’au');
    expect(page.order[0]).toBe('windows');
    expect(page.items.find((item) => item.os === 'windows')?.link.className).toBe('button');
    expect(page.items.find((item) => item.os === 'mac')?.link.className).toBe('button light');
    // Out of the address bar, kept for this tab only, and found again after a reload without the fragment.
    expect(page.replaced).toEqual(['/join']);
    expect(page.stored.get('drop-invite')).toBe(code);
    const reloaded = runJoinScript(script, '', MAC, page.stored);
    expect(reloaded.byId('join-open').href).toBe(`drop://join?invite=${code}`);
    expect(reloaded.order[0]).toBe('mac');
    // The skip link puts the page's own anchor in the address bar: a reload there keeps the invite it had.
    const anchored = runJoinScript(script, '#contenu', MAC, page.stored);
    expect(anchored.byId('join-open').href).toBe(`drop://join?invite=${code}`);
    expect(page.stored.get('drop-invite')).toBe(code);
  });

  it('explains an incomplete, unreadable or expired link instead of a join button', async () => {
    const guillaume = await generateIdentity('Guillaume');
    const expired = encodeInvite(
      await createInvite(guillaume, 'wss://drop.memolabs.dev/v1', Date.now() - 25 * 3_600_000),
    );
    const spoof = Buffer.from(
      JSON.stringify({ displayName: 'Guil\u202elaume<b>', expiresAt: Date.now() + 60_000, team: { name: 'A\u0000B' } }),
    ).toString('base64url');
    const cases: [string, string][] = [
      ['', 'incomplet'],
      ['#abc', 'incomplet'],
      [`#${'A'.repeat(60)}`, 'illisible'],
      [`#${expired}`, 'expiré'],
    ];
    for (const [hash, word] of cases) {
      const page = runJoinScript(script, hash, MAC);
      expect(page.byId('join-status').textContent, hash).toContain(word);
      expect(page.byId('join-steps').hidden, hash).toBe(true);
      expect(page.byId('join-open').href, hash).toBe('#contenu');
    }
    // Shown as text, without control or direction characters: the app checks the signature before anything is sent.
    expect(runJoinScript(script, `#${spoof}`, MAC).byId('join-title').textContent).toBe(
      'Guillaume<b> t’invite dans l’équipe AB',
    );
  });
});

// The public site is a static export behind nginx on the VPS (D77), which sends `script-src 'none'` everywhere: the
// join page needs its own header there, and its script hash changes with every edit of the page (T4.31).
describe('join page (T4.31)', () => {
  it('writes the join page policy next to the static export, outside the published files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drop-site-headers-'));
    const out = join(root, 'site');
    const preview = await startSite(await collectSite({ installs: 'beta', contact: '' }), 0);
    try {
      await buildSite(out, { installs: 'beta', contact: '' });
      expect(await readdir(root)).toEqual(['site', 'site-headers.json']);
      const headers = JSON.parse(await readFile(join(root, 'site-headers.json'), 'utf8')) as {
        default: string;
        paths: Record<string, string>;
      };
      expect(headers.default).toContain("script-src 'none'");
      expect(Object.keys(headers.paths).sort()).toEqual(['/join', '/join.html', '/join/', '/join/index.html']);
      for (const [path, policy] of Object.entries(headers.paths)) {
        // Exactly what `serve` sends, frame-ancestors included, which the page's meta copy cannot carry.
        const served = (await fetch(`${preview.url}${path}`)).headers.get('content-security-policy');
        expect(policy, path).toBe(served);
        expect(policy, path).toContain("frame-ancestors 'none'");
        expect(policy, path).toMatch(/script-src 'sha256-[A-Za-z0-9+/]+=*'/);
      }
      // Never published: no exported file holds it.
      const published = await readdir(out, { recursive: true });
      expect(published.some((name) => name.includes('headers'))).toBe(false);
    } finally {
      await preview.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
