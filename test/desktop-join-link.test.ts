import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAY_URL } from '../packages/node/src/home.ts';

// The Rust shell is built and unit-tested by cargo (`join_and_pair_links_open_the_invite_confirmation`); this suite
// keeps the contract visible to the JavaScript gate, which also runs where no Rust toolchain is installed.
describe('desktop join link (T4.23)', () => {
  const rust = readFileSync(join(process.cwd(), 'apps/desktop/src-tauri/src/main.rs'), 'utf8');

  it('opens drop://join like drop://pair: the confirmation card, queued until the node answers', () => {
    expect(rust).toContain('matches!(url.host_str(), Some("join" | "pair" | "link"))');
    expect(rust).toContain('Some("join") => invite(param("invite"))');
    expect(rust).toContain('Some("pair") => invite(param("code"))');
    expect(rust).toContain('.map(|code| vec![("pair", code)])');
    // Only a base64url code reaches the panel, and only from a link of bounded length.
    expect(rust).toContain("b.is_ascii_alphanumeric() || b == b'-' || b == b'_'");
    expect(rust).toContain('const MAX_LINK_CHARS: usize = 4096;');
    expect(rust).toContain('if handled_link(&url) {\n                queue.push(url);');
    expect(rust).toContain('fn join_and_pair_links_open_the_invite_confirmation()');
    // The shell never reads the invite: the first launch keeps its loopback relay, the node moves on « Rejoindre ».
    expect(rust).toContain('configured.unwrap_or_else(|| DEFAULT_RELAY.to_string())');
  });
});

describe('default relay (T4.33)', () => {
  it('starts the app on the node default loopback relay, the only one an invite may move a node from', () => {
    const rust = readFileSync(join(process.cwd(), 'apps/desktop/src-tauri/src/main.rs'), 'utf8');
    expect(rust).toContain(`const DEFAULT_RELAY: &str = "${DEFAULT_RELAY_URL}";`);
  });
});

// Windows and Linux start a new process for each drop:// link (v2.tauri.app/plugin/deep-linking). PR #45 made the first
// instance receive them; an AppImage, which nothing installs, still had to register the scheme itself (T4.31).
describe('desktop single instance (T4.31)', () => {
  it('hands a drop:// link to the running app on Windows and Linux, and registers the scheme from an AppImage', () => {
    const tauri = join(process.cwd(), 'apps/desktop/src-tauri');
    const rust = readFileSync(join(tauri, 'src/main.rs'), 'utf8');
    const cargo = readFileSync(join(tauri, 'Cargo.toml'), 'utf8');
    const config = JSON.parse(readFileSync(join(tauri, 'tauri.conf.json'), 'utf8')) as {
      plugins: { 'deep-link': { desktop: { schemes: string[] } } };
    };
    // The plugin with its deep-link feature, on Windows and Linux only, for the one scheme the app declares.
    expect(cargo).toMatch(
      /\[target\.'cfg\(any\(windows, target_os = "linux"\)\)'\.dependencies\]\ntauri-plugin-single-instance = \{ version = "2", features = \["deep-link"\] \}/,
    );
    expect(config.plugins['deep-link'].desktop.schemes).toEqual(['drop']);
    // First plugin of the builder, before deep-link: the second process hands its arguments over and exits.
    const main = rust.slice(rust.indexOf('fn main()'));
    const single = main.indexOf('.plugin(tauri_plugin_single_instance::init(');
    expect(single).toBeGreaterThan(0);
    expect(single).toBeLessThan(main.indexOf('.plugin(tauri_plugin_deep_link::init())'));
    expect(main.slice(0, single)).not.toContain('.plugin(');
    // Links handed over, and the link that started the app, go through the same queue as on macOS.
    expect(main).toContain('.on_open_url(move |event| open_links(&links, event.urls()));');
    expect(main).toContain(
      'if let Ok(Some(urls)) = app.deep_link().get_current() {\n                open_links(&handle, urls);',
    );
    // An AppImage registers drop:// at each launch (its path may have moved); a failure is logged, the app goes on.
    expect(main).toContain('#[cfg(target_os = "linux")]\n            if app.env().appimage.is_some() {');
    expect(main).toContain('if let Err(error) = app.deep_link().register_all() {');
    expect(main).toContain('log_error("E_DEEP_LINK", &error.to_string());');
  });
});
