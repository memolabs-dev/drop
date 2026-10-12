// @vitest-environment happy-dom
/**
 * Component tests of the React menu bar panel (T4.24): the real components, rendered in happy-dom, talking to a fake
 * local Node through a stubbed fetch. They replace the string checks of the former HTML panel.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PanelApp from '../src/panel/PanelApp.tsx';
import {
  CODES,
  KNOWN_ASSISTANT_HOSTS,
  answerFile,
  connectionStatus,
  costLine,
  countdown,
  explain,
  failureText,
  linkWarnings,
  outboundSentence,
  reviewForm,
  safeSignInLink,
} from '../src/panel/logic.ts';
import type { ApprovalItem, ReviewItem } from '../src/panel/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- a fake local Node ----

interface Call {
  method: string;
  path: string;
  body: string | undefined;
}
type Reply = { status?: number; body: unknown };
type Handler = (call: Call) => Reply | undefined;

let calls: Call[] = [];
let routes: Record<string, Handler | Reply> = {};
let sse: { onmessage: (() => void) | null } | null = null;

function opened(stream: { onmessage: (() => void) | null }): void {
  sse = stream;
}

function route(key: string, reply: Handler | Reply): void {
  routes[key] = reply;
}

function installNode(): void {
  calls = [];
  routes = {
    'GET /ui/admin/status': { body: { displayName: 'Camille', relayConnected: true } },
    'GET /ui/pending': { body: { pending: [] } },
    'GET /ui/outbound': { body: { drops: [] } },
    'GET /ui/team': { body: { team: null, members: [] } },
    'GET /ui/admin/tools': { body: { agents: [], shared: {}, payer: 'requester', links: [], gateways: [] } },
    'GET /ui/facts': { body: { facts: [], peers: [] } },
    'GET /ui/admin/internet': { body: { settings: { mode: 'off' }, state: 'off' } },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        path,
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      const entry = routes[call.method + ' ' + path];
      const reply = (typeof entry === 'function' ? entry(call) : entry) ?? { body: { ok: true } };
      const status = reply.status ?? 200;
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(reply.body) });
    }),
  );
  vi.stubGlobal(
    'EventSource',
    class {
      onmessage: (() => void) | null = null;
      constructor() {
        opened(this);
      }
      close(): void {
        sse = null;
      }
    },
  );
}

function posted(path: string): Call[] {
  return calls.filter((call) => call.method === 'POST' && call.path === path);
}

// ---- rendering helpers ----

let root: Root | undefined;
let host: HTMLElement | undefined;

/** Runs a synchronous change inside act, then lets React flush. */
async function step(change: () => void): Promise<void> {
  await act(async () => {
    change();
    await Promise.resolve();
  });
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (check()) return;
    await settle(10);
  }
  throw new Error('timed out waiting for ' + label);
}

async function mount(query = ''): Promise<HTMLElement> {
  window.history.replaceState(null, '', '/app?token=test-token' + query);
  host = document.createElement('div');
  host.id = 'root';
  document.body.append(host);
  const created = createRoot(host);
  root = created;
  await step(() => {
    created.render(<PanelApp />);
  });
  await settle(20);
  return host;
}

/** Visible text, with the narrow no-break spaces of French number formatting read as spaces. */
function text(): string {
  return plain(host?.textContent ?? '');
}

function plain(value: string | null): string {
  return (value ?? '').replace(/[\u00a0\u202f]/g, ' ');
}

function button(name: string | RegExp): HTMLButtonElement {
  const all = [...document.querySelectorAll<HTMLButtonElement>('button')];
  const found = all.find((item) => {
    const label = item.getAttribute('aria-label') ?? item.textContent;
    return typeof name === 'string' ? label.trim() === name || item.textContent.trim() === name : name.test(label);
  });
  if (!found) throw new Error('no button ' + String(name) + ' among: ' + all.map((b) => b.textContent).join(' | '));
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await step(() => {
    element.click();
  });
  await settle(10);
}

/** Radix tabs activate on mouse down, as a real pointer does. */
async function openTab(name: string): Promise<void> {
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((item) =>
    item.textContent.startsWith(name),
  );
  if (!tab) throw new Error('no tab ' + name);
  await step(() => {
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });
  await settle(20);
}

async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await step(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  installNode();
});

afterEach(async () => {
  await step(() => {
    root?.unmount();
  });
  host?.remove();
  root = undefined;
  host = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

// ---- fixtures, all fictitious ----

const DROP = '0199c5a0-0000-7000-8000-000000000001';
const REVIEW = '0199c5a0-0000-7000-8000-000000000002';

function approval(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    kind: 'approval',
    dropId: DROP,
    card: {
      capabilityId: 'production.error_summary',
      title: 'Résumer les erreurs de production',
      receives: ['le nombre d’erreurs par service'],
      neverReceives: ['les lignes de log brutes'],
      sensitivity: 'high',
      executorName: 'VPS',
      cost: { kind: 'capped', maxUsd: 0.5 },
      paidBy: 'owner',
    },
    inputPreview: 'Quelles erreurs hier soir ?',
    purpose: 'Préparer le point d’incident.',
    requestedBy: { displayName: 'Julie Moreau', agent: 'claude_code' },
    expiresAt: Date.now() + 9 * 60_000,
    ...overrides,
  };
}

const review: ReviewItem = {
  kind: 'review',
  dropId: REVIEW,
  title: 'État des tickets',
  output: { ouverts: 12, responsable: 'Karim Benali' },
  expiresAt: Date.now() + 60_000,
};

// ---- spec scenarios (owner-app, node) ----

describe('menu bar panel and its admin routes (T2.4)', () => {
  it('inserts what peers wrote as text only', async () => {
    route('GET /ui/pending', {
      body: {
        pending: [
          approval({
            card: { ...approval().card, title: 'Résumer <b>prod</b>', receives: ['<img src=x onerror=alert(1)>'] },
            inputPreview: '<script>alert(1)</script>',
            purpose: '"><img src=x onerror=alert(2)>',
            requestedBy: { displayName: 'Guillaume <i>', agent: 'claude_code' },
          }),
        ],
      },
    });
    route('GET /ui/outbound', {
      body: {
        drops: [{ dropId: 'x', title: '<u>titre</u>', ownerName: '<em>Karim</em>', state: 'denied', createdAt: 1 }],
      },
    });
    const view = await mount();
    await until(() => text().includes('Résumer <b>prod</b>'), 'card');
    expect(text()).toContain('« <script>alert(1)</script> »');
    expect(text()).toContain('Guillaume <i>');
    expect(text()).toContain('<em>Karim</em>');
    expect(view.querySelector('main b:not([class]), main script, main img, main i, main em, main u')).toBeNull();
    // No React escape hatch anywhere in the panel sources.
    const dir = join(import.meta.dirname, '..', 'src', 'panel');
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source, file).not.toContain('dangerouslySetInnerHTML');
      expect(source, file).not.toContain('innerHTML');
      expect(source, file).not.toContain('insertAdjacentHTML');
    }
  });

  it('offers to sign in when a shared server needs OAuth, and links only an https sign-in page (T2.17)', async () => {
    expect(safeSignInLink('javascript:alert(1)')).toBe('');
    expect(safeSignInLink('http://notion.example/authorize')).toBe('');
    expect(safeSignInLink('https://notion.example/authorize')).toBe('https://notion.example/authorize');
    route('GET /ui/admin/tools', {
      body: {
        agents: [
          {
            agent: 'claude_code',
            label: 'Claude Code',
            installed: true,
            dropInstalled: true,
            servers: [{ name: 'notion', kind: 'http', where: 'global', shareable: true }],
          },
        ],
        shared: {},
        payer: 'owner',
        links: [],
      },
    });
    route('POST /ui/admin/share', {
      status: 400,
      body: { error: 'E_ADMIN', message: 'Connexion requise.', code: 'E_SHARE_OAUTH' },
    });
    route('POST /ui/admin/connect', { body: { authorizationUrl: 'https://notion.example/authorize?x=1' } });
    await mount();
    await openTab('Mes outils');
    await until(() => text().includes('notion'), 'tools');
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle?.getAttribute('aria-label')).toBe('Partager notion');
    if (toggle) await click(toggle);
    await until(() => text().includes('Se connecter à notion'), 'sign-in offer');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('E_SHARE_OAUTH');
    await click(button('Se connecter à notion'));
    expect(JSON.parse(posted('/ui/admin/connect')[0]?.body ?? '{}')).toEqual({
      agent: 'claude_code',
      server: 'notion',
    });
    await until(() => document.querySelector('a[target="_blank"]') !== null, 'sign-in link');
    const link = document.querySelector<HTMLAnchorElement>('a[target="_blank"]');
    expect(link?.getAttribute('href')).toBe('https://notion.example/authorize?x=1');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('names the domain a linked assistant returns to, and warns when it is neither Claude nor ChatGPT', async () => {
    expect(KNOWN_ASSISTANT_HOSTS).toEqual(['claude.ai', 'chatgpt.com', 'chat.openai.com']);
    const request = {
      session: 's'.repeat(24),
      gateway: 'gw',
      client: 'Claude',
      clientId: 'c'.repeat(24),
      redirect: 'claude.ai',
    };
    expect(linkWarnings(request, ['gw'])).toEqual({ complete: true, warnings: [] });
    expect(linkWarnings({ ...request, redirect: 'evil.example' }, ['gw']).warnings.join(' ')).toContain(
      'qui n’est ni Claude ni ChatGPT',
    );
    expect(linkWarnings({ ...request, clientId: '' }, ['gw']).complete).toBe(false);
    route('GET /ui/admin/tools', { body: { agents: [], shared: {}, links: [], gateways: ['gw'] } });
    await mount(
      '&link=' + 's'.repeat(24) + '&gateway=gw&client=Faux&clientId=' + 'c'.repeat(24) + '&redirect=evil.example',
    );
    await until(() => text().includes('Autoriser Faux (evil.example)'), 'link card');
    expect(window.location.search).toBe('?token=test-token');
    expect(text()).toContain('evil.example, qui n’est ni Claude ni ChatGPT');
    await click(button('Autoriser'));
    expect(JSON.parse(posted('/ui/admin/link')[0]?.body ?? '{}')).toEqual({
      gateway: 'gw',
      session: 's'.repeat(24),
      client: 'Faux',
      clientId: 'c'.repeat(24),
      redirect: 'evil.example',
    });
  });

  it('reports a failed invite, unlink or link copy instead of leaving its promise unhandled', async () => {
    route('GET /ui/team', {
      body: {
        team: { name: 'Atlas' },
        members: [{ nodeId: 'a', displayName: 'Camille', self: true, online: true, agents: [], capabilities: [] }],
      },
    });
    route('POST /ui/invite', { status: 500, body: { error: 'internal' } });
    await mount();
    await openTab('Équipe');
    await until(() => text().includes('Atlas · 1 membres, 1 en ligne'), 'team');
    await click(button('Inviter quelqu’un dans l’équipe'));
    await until(() => document.querySelector('[role="alert"]') !== null, 'invite failure');
    // The Node's opaque 500 body reads as the calm default, never as the bare word « internal ».
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Action impossible. Réessaie dans un instant.',
    );
    expect(text()).not.toMatch(/\binternal\b/);
    route('POST /ui/invite', {
      body: { code: 'code-fictif', link: 'https://drop.memolabs.dev/join#code-fictif', validHours: 24 },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    await click(button('Inviter quelqu’un dans l’équipe'));
    await until(() => text().includes('https://drop.memolabs.dev/join#code-fictif'), 'invite link');
    await click(button('Copier le lien'));
    await until(() => text().includes('Copie impossible'), 'copy failure');
    expect(
      [...document.querySelectorAll('[role="alert"]')].some((n) => n.textContent.includes('Copie impossible')),
    ).toBe(true);
  });
});

describe('menu bar panel and its admin routes (T4.14)', () => {
  it('previews an invitation without pairing and pairs only after Rejoindre', async () => {
    route('POST /ui/pair/preview', {
      body: { displayName: 'Julie <b>', team: 'Atlas', relayHost: 'relais.example:8443', relay: 'adopt' },
    });
    await mount('&pair=code-fictif');
    await until(() => text().includes('Julie <b> t’invite dans l’équipe Atlas'), 'invite card');
    // The code left the address at once, and nothing paired yet.
    expect(window.location.search).toBe('?token=test-token');
    expect(posted('/ui/pair/preview')[0]?.body).toBe('code=code-fictif');
    expect(posted('/ui/pair')).toHaveLength(0);
    expect(document.activeElement?.textContent).toBe('Refuser');
    // A link from anyone can open the card: before « Rejoindre », it names the relay the app would move to (T4.23).
    expect(text()).toContain(
      'En rejoignant, ton app passera par le relais relais.example:8443, celui de la personne qui t’invite. Si tu ne connais pas ce relais, refuse.',
    );
    await click(button('Rejoindre'));
    expect(posted('/ui/pair').map((call) => call.body)).toEqual(['code=code-fictif']);
    await until(() => text().includes('Invitation acceptée'), 'joined');
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Équipe');
  });

  it('names the relay only when Rejoindre would move to it, and shows each refusal with the message of its stable code', async () => {
    const alerts = (): string[] =>
      [...document.querySelectorAll('[role="alert"]')].map((node) => plain(node.textContent));
    async function reopen(query: string): Promise<void> {
      await step(() => {
        root?.unmount();
      });
      host?.remove();
      calls = [];
      await mount(query);
    }
    // A node that joined nobody yet would adopt the invite's relay: the card names it, as text, before « Rejoindre ».
    route('POST /ui/pair/preview', {
      body: { displayName: 'Julie', team: 'Atlas', relayHost: '<b>relais.example</b>', relay: 'adopt' },
    });
    await mount('&pair=code-fictif');
    await until(() => text().includes('Julie t’invite dans l’équipe Atlas'), 'adopting card');
    expect(text()).toContain('ton app passera par le relais <b>relais.example</b>, celui de la personne qui t’invite.');
    expect(host?.querySelector('b')).toBeNull();
    expect(posted('/ui/pair')).toHaveLength(0);
    // A node that already joined someone keeps its relay: the card says nothing about one.
    route('POST /ui/pair/preview', {
      body: { displayName: 'Julie', team: 'Atlas', relayHost: 'relais.example:8443', relay: 'kept' },
    });
    route('POST /ui/pair', {
      status: 400,
      body: {
        error: 'E_INVITE_USED',
        code: 'E_INVITE_USED',
        message: 'Cette invitation a déjà servi. Demande un nouveau lien.',
      },
    });
    await reopen('&pair=code-fictif');
    await until(() => text().includes('Julie t’invite dans l’équipe Atlas'), 'invite card');
    expect(text()).not.toContain('passera par le relais');
    expect(text()).not.toContain('relais.example');
    // « Rejoindre » refused: the reason of its code, not one sentence for every refusal.
    await click(button('Rejoindre'));
    await until(() => alerts().some((line) => line.includes('Cette invitation a déjà servi.')), 'used refusal');
    expect(alerts().join(' ')).toContain('Cette invitation a déjà servi. Demande un nouveau lien. (E_INVITE_USED)');
    expect(text()).not.toContain('n’est plus valable');
    expect(text()).not.toContain('Julie t’invite');
    // The preview refused: same rule, and a code this panel does not know yet still shows the Node's message.
    for (const [code, message] of [
      ['E_INVITE_RELAY', 'Le relais de cette invitation n’est pas autorisé sur cet ordinateur.'],
      ['E_FUTURE_JOIN', 'Un message que seul le Node connaît.'],
    ] as const) {
      route('POST /ui/pair/preview', { status: 400, body: { error: code, code, message } });
      await reopen('&pair=code-fictif');
      await until(() => alerts().some((line) => line.includes(message)), code + ' refusal');
      expect(alerts().join(' ')).toContain(message + ' (' + code + ')');
      expect(text()).not.toContain('n’est plus valable');
      expect(text()).not.toContain('Rejoindre');
      expect(posted('/ui/pair')).toHaveLength(0);
    }
  });

  it('renders expiry, high sensitivity, a default Pas maintenant and per-field redaction', async () => {
    route('GET /ui/pending', { body: { pending: [approval(), review] } });
    await mount();
    await until(() => text().includes('Expire dans 0'), 'card');
    expect(text()).toContain('Sensibilité haute : tu reliras le résultat avant envoi.');
    expect(text()).toContain('Coût max : 0,50 $, à ta charge.');
    // The keyboard default is « Pas maintenant », never « Autoriser »: Entrée sends not_now.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Reporter : Résumer les erreurs de production');
    const order = [
      'Julie Moreau a besoin d’aide',
      'via Claude Code',
      'Résumer les erreurs',
      '« Quelles',
      'Pourquoi : ',
      'Julie Moreau recevra :',
      'Julie Moreau ne recevra jamais :',
      'Coût max',
      'Sensibilité haute',
      'Expire dans',
      'Pas maintenant',
      'Refuser',
      'Autoriser une fois',
    ];
    const card = plain(document.querySelector('article')?.textContent ?? '');
    const positions = order.map((part) => card.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(card).not.toContain('production.error_summary');
    if (document.activeElement instanceof HTMLElement) await click(document.activeElement);
    expect(posted('/ui/decide')[0]?.body).toBe('dropId=' + DROP + '&decision=not_now');
    // Review: one box per top-level field, each checked one is sent as a removal.
    const box = document.querySelector<HTMLButtonElement>('[aria-label="Retirer responsable avant l’envoi"]');
    expect(document.querySelector('[aria-label="Retirer ouverts avant l’envoi"]')).not.toBeNull();
    if (box) await click(box);
    await click(button('Envoyer : État des tickets'));
    expect(posted('/ui/review')[0]?.body).toBe('dropId=' + REVIEW + '&decision=send&redact=responsable');
    expect(reviewForm(REVIEW, 'discard', ['x']).toString()).toBe('dropId=' + REVIEW + '&decision=discard');
  });
});

// ---- one-link join follow-ups (T4.31): the https link to send, then « Connecter mes agents » after « Rejoindre » ----

describe('menu bar panel (T4.31)', () => {
  const atlas = {
    body: {
      team: { name: 'Atlas' },
      members: [{ nodeId: 'a', displayName: 'Camille', self: true, online: true, agents: [], capabilities: [] }],
    },
  };

  it('gives the https join link to send, never drop://pair', async () => {
    const link = 'https://drop.memolabs.dev/join#ZXlKcGJuWnBkR1VpT2lKbWFXTjBhV1lpZlEtZmljdGlm';
    route('GET /ui/team', atlas);
    route('POST /ui/invite', { body: { code: 'ZXlKcGJuWnBkR1VpT2lKbWFXTjBhV1lpZlEtZmljdGlm', link, validHours: 24 } });
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => {
          copied.push(value);
          return Promise.resolve();
        },
      },
    });
    await mount();
    await openTab('Équipe');
    await until(() => text().includes('Atlas · 1 membres, 1 en ligne'), 'team');
    await click(button('Inviter quelqu’un dans l’équipe'));
    await until(() => text().includes(link), 'https link');
    expect(posted('/ui/invite')).toHaveLength(1);
    expect(document.querySelector('code')?.textContent).toBe(link);
    // What the link does, so the inviter knows it works for someone who has no drop yet.
    expect(text()).toContain('valable 24 h, une seule fois, pour une seule personne');
    expect(text()).toContain('installer drop');
    expect(text()).not.toContain('drop://');
    await click(button('Copier le lien'));
    expect(copied).toEqual([link]);
  });

  it('offers Connecter mes agents after Rejoindre, then analyses this computer on one click', async () => {
    route('POST /ui/pair/preview', {
      body: { displayName: 'Julie', team: 'Atlas', relayHost: '<b>relais.example:8443</b>', relay: 'adopt' },
    });
    route('POST /ui/pair', { body: { nodeId: 'julie', relay: 'adopt', next: 'connect_agents' } });
    route('GET /ui/team', atlas);
    route('GET /ui/admin/onboarding', {
      body: {
        agents: [
          {
            agent: 'cursor',
            label: 'Cursor',
            state: 'ready',
            fingerprint: 'a'.repeat(64),
            detail: 'Ajout du connecteur',
          },
        ],
      },
    });
    route('GET /ui/admin/projects', { body: { projects: [] } });
    route('POST /ui/admin/onboarding', {
      body: { results: [{ agent: 'cursor', state: 'connected', detail: 'Configuration modifiée' }] },
    });
    await mount('&pair=code-fictif');
    await until(() => text().includes('Julie t’invite dans l’équipe Atlas'), 'invite card');
    await click(button('Rejoindre'));
    await until(() => text().includes('Prochaine étape'), 'next step');
    // The relay this node just moved to is named, as text; nothing is analysed or connected before the click.
    expect(text()).toContain('Ton app passe maintenant par le relais <b>relais.example:8443</b>');
    expect(host?.querySelector('b')).toBeNull();
    expect(calls.some((call) => call.path === '/ui/admin/onboarding')).toBe(false);
    await click(button('Connecter mes agents'));
    await until(() => text().includes('Résultat de l’analyse'), 'analysis');
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Mes outils');
    expect(calls.filter((call) => call.method === 'GET' && call.path === '/ui/admin/onboarding')).toHaveLength(1);
    expect(text()).not.toContain('Prochaine étape');
    // Connecting stays the second, explicit action.
    expect(posted('/ui/admin/onboarding')).toHaveLength(0);
    await click(button('2. Connecter les agents sélectionnés'));
    expect(JSON.parse(posted('/ui/admin/onboarding')[0]?.body ?? '{}')).toEqual({
      selections: [{ agent: 'cursor', fingerprint: 'a'.repeat(64), action: 'connect' }],
    });

    // « Plus tard »: the offer goes away, nothing is analysed; a node that kept its relay names none.
    await step(() => {
      root?.unmount();
    });
    host?.remove();
    calls = [];
    route('POST /ui/pair', { body: { nodeId: 'julie', relay: 'same', next: 'connect_agents' } });
    await mount('&pair=code-fictif');
    await until(() => text().includes('Julie t’invite dans l’équipe Atlas'), 'second card');
    await click(button('Rejoindre'));
    await until(() => text().includes('Prochaine étape'), 'second next step');
    expect(text()).not.toContain('passe maintenant par le relais');
    await click(button('Plus tard'));
    expect(text()).not.toContain('Prochaine étape');
    await settle(30);
    expect(calls.some((call) => call.path === '/ui/admin/onboarding')).toBe(false);
  });
});

describe('menu bar panel (T4.3)', () => {
  it('offers to answer by hand, keeps the ledger visible and reviews the answer before sending', async () => {
    route('GET /ui/pending', { body: { pending: [approval({ executorName: 'Inès' })] } });
    route('POST /ui/answer', {
      status: 400,
      body: { ok: false, code: 'E_SECRET_DETECTED', message: 'Secret détecté.' },
    });
    await mount();
    await until(() => text().includes('Répondre moi-même'), 'card');
    await click(button('Répondre moi-même : Résumer les erreurs de production'));
    await until(() => document.querySelector('textarea') !== null, 'composer');
    expect(text()).toContain('Julie Moreau recevra :');
    expect(text()).toContain('Julie Moreau ne recevra jamais :');
    expect(text()).toContain('Ta réponse part chez Inès, qui gère cet outil, puis vers Julie Moreau.');
    const area = document.querySelector('textarea');
    if (!area) throw new Error('textarea');
    expect(area.maxLength).toBe(8000);
    expect(document.querySelector('input[type="file"]')?.getAttribute('accept')).toBe(
      '.txt,.md,.csv,.json,.log,text/plain,text/markdown,text/csv,application/json',
    );
    await settle(60);
    expect(document.activeElement).toBe(area);
    await type(area, 'Deux erreurs de paiement.');
    // A live refresh keeps the draft.
    await step(() => {
      sse?.onmessage?.();
    });
    await settle(20);
    expect(document.querySelector('textarea')?.value).toBe('Deux erreurs de paiement.');
    expect(posted('/ui/answer')).toHaveLength(0);
    await click(button('Relire la réponse'));
    expect(text()).toContain('Inès recevra exactement, pour Julie Moreau :');
    expect(text()).toContain('Deux erreurs de paiement.');
    expect(posted('/ui/answer')).toHaveLength(0);
    await settle(60);
    expect(document.activeElement?.textContent).toBe('Envoyer');
    await click(button('Envoyer ta réponse : Résumer les erreurs de production'));
    expect(JSON.parse(posted('/ui/answer')[0]?.body ?? '{}')).toEqual({
      dropId: DROP,
      text: 'Deux erreurs de paiement.',
    });
    // A refusal is shown with its code, and the draft comes back for editing.
    await until(() => document.querySelector('[role="alert"]') !== null, 'refusal');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Secret détecté. (E_SECRET_DETECTED)');
    expect(document.querySelector('textarea')?.value).toBe('Deux erreurs de paiement.');
    // A file that is not UTF-8, or too large, never leaves.
    expect(answerFile('a.txt', 10, 'caf�')).toEqual({ error: expect.stringContaining('UTF-8') as string });
    expect(answerFile('a.txt', 200 * 1024, 'x')).toEqual({ error: explain('E_TOO_LARGE') });
    expect(answerFile('notes.md', 4, 'ok\n')).toEqual({
      name: 'notes.md',
      mediaType: 'text/markdown',
      content: 'ok\n',
      size: 4,
    });
    expect(CODES.E_SECRET_DETECTED).toBeDefined();
    expect(CODES.E_TOO_LARGE).toBeDefined();
  });
});

describe('menu bar panel (T4.4)', () => {
  it('lists what I publish with add, edit and retire, and greys out an expired fact', async () => {
    const day = 86_400_000;
    const now = Date.now();
    route('GET /ui/facts', {
      body: {
        facts: [
          {
            factId: '0199c5a0-0000-7000-8000-0000000000f1',
            topic: 'Gel des déploiements',
            statement: 'Pas le <b>vendredi</b>.',
            keywords: ['déploiement'],
            source: { label: 'Charte' },
            validTo: now + 60 * day,
            publishedAt: now - 30 * day,
            status: 'active',
            live: true,
            served: 7,
            audience: { kind: 'team' },
          },
          {
            factId: '0199c5a0-0000-7000-8000-0000000000f2',
            topic: 'Astreinte',
            statement: 'Karim.',
            keywords: [],
            source: { label: 'Planning' },
            validTo: now - day,
            publishedAt: now - 10 * day,
            status: 'active',
            live: false,
            served: 3,
            audience: { kind: 'team' },
          },
        ],
        peers: [{ nodeId: 'n1', displayName: 'Julie' }],
      },
    });
    await mount();
    await openTab('Mes outils');
    await until(() => text().includes('Ce que je publie'), 'facts');
    expect(text()).toContain('Pas le <b>vendredi</b>.');
    expect(text()).toContain('servi 7 fois');
    const expired = document.querySelector('[aria-label="Astreinte (Expiré)"]');
    expect(expired?.getAttribute('data-faded')).toBe('true');
    await click(button('Retirer : Gel des déploiements'));
    expect(posted('/ui/facts/0199c5a0-0000-7000-8000-0000000000f1/retire')).toHaveLength(1);
    await click(button('Modifier : Gel des déploiements'));
    await until(() => document.querySelector('[role="group"][aria-label="Modifier le fait"]') !== null, 'edit form');
    // Editing keeps the fact's own duration (90 days) instead of resetting it.
    expect(document.querySelector('select')?.value).toBe('90');
    await click(button('Enregistrer'));
    const edit = posted('/ui/facts/0199c5a0-0000-7000-8000-0000000000f1')[0];
    expect(JSON.parse(edit?.body ?? '{}')).toMatchObject({
      topic: 'Gel des déploiements',
      validDays: 90,
      audience: { kind: 'team' },
    });
    await until(() => text().includes('Publier un fait'), 'list again');
    await click(button('Publier un fait'));
    expect(text()).toContain('Tous mes pairs appairés');
    expect(text()).toContain('Des personnes choisies');
    await click(button('Publier'));
    expect(posted('/ui/facts')).toHaveLength(0);
    // An unreadable fact store does not take the rest of « Mes outils » down.
    route('GET /ui/facts', { status: 500, body: { error: 'internal' } });
    await openTab('Demandes');
    await openTab('Mes outils');
    await until(() => text().includes('Impossible de lire tes faits publiés.'), 'facts error');
    expect(text()).toContain('Connecter mes agents');
  });
});

describe('menu bar panel (T4.5)', () => {
  it('analyses thirteen clients, separates global and project configurations, and shows manual steps', async () => {
    route('GET /ui/admin/onboarding', {
      body: {
        agents: [
          {
            agent: 'cursor',
            label: 'Cursor',
            state: 'ready',
            fingerprint: 'a'.repeat(64),
            detail: 'Ajout du connecteur',
          },
          {
            agent: 'zed',
            label: 'Zed',
            state: 'error',
            fingerprint: 'b'.repeat(64),
            detail: 'E_CONFIG_LOCKED',
            manual: { steps: 'Colle cette entrée.', snippet: '"drop": {}' },
          },
          { agent: 'codex', label: 'Codex', state: 'absent', fingerprint: 'c'.repeat(64) },
        ],
        manual: { command: '/usr/bin/node', args: ['drop-mcp.mjs'], env: { DROP_AGENT: 'other' } },
      },
    });
    route('GET /ui/admin/projects', {
      body: { projects: [{ dir: '/Users/camille/site', sources: ['claude_code', 'added'], clients: [] }] },
    });
    route('POST /ui/admin/onboarding', {
      body: { results: [{ agent: 'cursor', state: 'connected', detail: 'Configuration modifiée' }] },
    });
    await mount();
    await openTab('Mes outils');
    await until(() => text().includes('Analyse locale des treize clients MCP compatibles'), 'steps');
    expect(text()).not.toContain('quatre agents');
    await click(button('1. Analyser cet ordinateur'));
    await until(() => text().includes('Configurations par projet'), 'analysis');
    expect(calls.some((call) => call.path === '/ui/admin/projects')).toBe(true);
    expect(text()).not.toContain('Codex');
    expect(text()).toContain('Secours : à faire toi-même');
    expect(document.querySelector('details code')?.textContent).toBe('"drop": {}');
    expect(text()).toContain('Configuration manuelle');
    expect(text()).toContain('connu de Claude Code · ajouté ici');
    await click(button('Retirer le dossier /Users/camille/site'));
    expect(JSON.parse(posted('/ui/admin/projects/remove')[0]?.body ?? '{}')).toEqual({ dir: '/Users/camille/site' });
    const dir = document.querySelector<HTMLInputElement>('[aria-label="Chemin complet du dossier de projet"]');
    if (dir) await type(dir, '/Users/camille/api');
    await click(button('Ajouter ce dossier'));
    expect(JSON.parse(posted('/ui/admin/projects')[0]?.body ?? '{}')).toEqual({ dir: '/Users/camille/api' });
    await click(button('2. Connecter les agents sélectionnés'));
    expect(JSON.parse(posted('/ui/admin/onboarding')[0]?.body ?? '{}')).toEqual({
      selections: [{ agent: 'cursor', fingerprint: 'a'.repeat(64), action: 'connect' }],
    });
    // Restart and team state are reported apart, without claiming the whole path is done.
    await until(() => text().includes('à vérifier après relance'), 'result');
    expect(text()).toContain('Cursor : Configuration modifiée');
  });
});

describe('menu bar panel (T4.22)', () => {
  it('connects every client without a copy step and explains the fallback only when a write is impossible', async () => {
    for (const code of [
      'E_CONFIG_LOCKED',
      'E_CONFIG_UNDOCUMENTED',
      'E_CLI_SHIM_UNSAFE',
      'E_CONFIG_INVALID_OR_UNREADABLE',
    ])
      expect(explain(code)).toMatch(new RegExp('^[A-ZÉ].+ \\(' + code + '\\)$'));
    const sources = readdirSync(join(import.meta.dirname, '..', 'src', 'panel'))
      .map((file) => readFileSync(join(import.meta.dirname, '..', 'src', 'panel', file), 'utf8'))
      .join('\n');
    expect(sources).not.toContain('E_MANUAL_ONLY');
    expect(sources).not.toContain('drop n’écrit pas dans ce client');
    expect(sources).not.toContain("state === 'manual'");
    route('GET /ui/admin/onboarding', {
      body: {
        agents: [{ agent: 'cursor', label: 'Cursor', state: 'ready', fingerprint: 'a'.repeat(64), detail: 'Ajout' }],
      },
    });
    await mount();
    await openTab('Mes outils');
    await until(() => text().includes('1. Analyser cet ordinateur'), 'button');
    await click(button('1. Analyser cet ordinateur'));
    await until(() => text().includes('Cursor'), 'analysis');
    // No fallback for a client drop can write: neither steps nor snippet.
    expect(text()).not.toContain('Secours : à faire toi-même');
    expect(text()).not.toContain('à copier');
  });
});

// ---- behaviour and accessibility (UX_UI section 6, T4.24) ----

describe('menu bar panel (T4.24)', () => {
  it('uses tabs with arrow keys, Home and End, and a badge counting what waits', async () => {
    route('GET /ui/pending', { body: { pending: [approval(), review] } });
    await mount();
    await until(() => text().includes('Demandes'), 'tabs');
    const list = document.querySelector('[role="tablist"]');
    expect(list?.getAttribute('aria-label')).toBe('Sections de drop');
    const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Demandes, 2 en attente', 'Équipe', 'Mes outils']);
    expect(document.querySelectorAll('[role="tabpanel"]').length).toBeGreaterThan(0);
    const first = tabs[0];
    if (!first) throw new Error('tab');
    await step(() => {
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await settle(20);
    expect(document.activeElement?.textContent).toBe('Équipe');
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Équipe');
    await step(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    await settle(20);
    expect(document.activeElement?.textContent).toBe('Mes outils');
    await step(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    await settle(20);
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Demandes');
  });

  it('announces each result, moves the focus to it, and shows the connection state in its own live region', async () => {
    route('GET /ui/pending', { body: { pending: [approval()] } });
    await mount();
    await until(() => text().includes('Camille · connecté'), 'status');
    const status = [...document.querySelectorAll('[role="status"][aria-live="polite"]')];
    expect(status.some((node) => node.textContent === 'Camille · connecté')).toBe(true);
    route('GET /ui/pending', { body: { pending: [] } });
    await click(button('Autoriser une fois : Résumer les erreurs de production'));
    expect(posted('/ui/decide')[0]?.body).toBe('dropId=' + DROP + '&decision=allow_once');
    await settle(80);
    expect(document.activeElement?.textContent).toContain('Demande autorisée une fois.');
    expect(status.some((node) => node.textContent === 'Demande autorisée une fois.')).toBe(true);
    await settle(200);
    expect(text()).toContain('Tout est à jour');
    expect(connectionStatus({ displayName: 'Julie', relayConnected: false })).toEqual({
      text: 'Julie · hors ligne',
      tone: 'wait',
    });
    expect(connectionStatus('down').text).toBe('Moteur local indisponible');
  });

  it('shows a load failure as an alert with Réessayer, and a refusal with its translated code', async () => {
    route('GET /ui/pending', { status: 500, body: { error: 'internal' } });
    await mount();
    await until(() => document.querySelector('[role="alert"]') !== null, 'alert');
    expect(text()).toContain('Impossible de charger cette section.');
    route('GET /ui/pending', { body: { pending: [] } });
    await click(button('Réessayer'));
    await until(() => text().includes('Tout est à jour'), 'retry');
    expect(failureText({ message: 'E_CONFIG_CHANGED' })).toBe(
      'La configuration a changé depuis l’analyse. Relance l’analyse. (E_CONFIG_CHANGED)',
    );
    expect(failureText({ message: 'Secret.', code: 'E_SECRET_DETECTED' })).toBe('Secret. (E_SECRET_DETECTED)');
    expect(failureText({})).toBe('Action impossible. Réessaie dans un instant.');
    expect(failureText({ message: 'internal' })).toBe('Action impossible. Réessaie dans un instant.');
  });

  it('describes only the outbound state that the Node actually exposes', async () => {
    const drop = { dropId: 'd', title: 'Budget', ownerName: 'Inès', createdAt: 1 };
    expect(outboundSentence({ ...drop, state: 'awaiting_approval' })).toBe(
      'Tu attends Inès. Cette personne doit encore donner son accord.',
    );
    expect(outboundSentence({ ...drop, state: 'delivered' })).toBe(
      'La réponse est arrivée. Retrouve-la dans ton assistant.',
    );
    expect(outboundSentence({ ...drop, state: 'running', error: { code: 'E_RUNNER', message: 'x' } })).toBe(
      'La demande n’a pas abouti. Aucun accès n’a été donné.',
    );
    route('GET /ui/outbound', { body: { drops: [{ ...drop, state: 'denied' }] } });
    await mount();
    await until(() => text().includes('Mes questions'), 'outbound');
    expect(document.querySelector('summary')?.getAttribute('aria-label')).toBe('Suivi de Budget avec Inès : refusée');
    expect(text()).toContain('Inès a refusé. Aucune réponse n’a été transmise.');
    expect(text()).not.toContain('%');
  });

  it('formats the cost and the countdown of the consent card', () => {
    const card = approval().card;
    expect(costLine({ ...card, cost: { kind: 'free' } }, 'Julie')).toBe('Coût : gratuit.');
    expect(plain(costLine({ ...card, paidBy: 'requester' }, 'Julie'))).toBe('Coût max : 0,50 $, payé par Julie.');
    expect(costLine({ ...card, cost: { kind: 'unmeasured' } }, 'Julie')).toBe('Coût : à ta charge, non mesuré.');
    const free = { ...card };
    delete free.cost;
    expect(costLine(free, 'Julie')).toBeNull();
    expect(countdown(125_000, 0)).toBe('02:05');
    expect(countdown(0, 5_000)).toBe('00:00');
  });

  it('honours reduced motion, reduced transparency, increased contrast and both themes in its stylesheet', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8');
    expect(css).toContain('color-scheme: light dark');
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.motion-arrive/);
    expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\)[\s\S]*backdrop-filter: none/);
    expect(css).toMatch(/@media \(prefers-contrast: more\)[\s\S]*html\.drop-panel \.panel-surface/);
    expect(css).toMatch(/html\.drop-panel :focus-visible \{\s*outline: 2px solid var\(--primary\)/);
  });
});
