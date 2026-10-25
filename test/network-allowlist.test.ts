import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('T4.27 documented network defaults', () => {
  it('keeps documented network defaults tied to the actual code', () => {
    const doc = source('docs/network-allowlist.md');
    const invite = source('packages/protocol/src/invite.ts');
    const desktop = source('apps/desktop/src-tauri/src/main.rs');
    const gateway = source('packages/gateway/src/cli.ts');
    const funding = source('packages/node/src/funding.ts');
    expect(invite).toContain("DEFAULT_JOIN_PAGE = 'https://drop.memolabs.dev/join'");
    expect(doc).toContain('`drop.memolabs.dev`');
    expect(desktop).toContain('DEFAULT_RELAY: &str = "ws://127.0.0.1:7780/v1"');
    expect(doc).toContain('WebSocket / 7780');
    expect(gateway).toContain("'wss://drop.memolabs.dev/v1'");
    expect(doc).toContain('wss://drop.memolabs.dev/v1');
    expect(funding).toContain("'https://openrouter.ai/api/v1'");
    expect(doc).toContain('`openrouter.ai`');
  });
});
