// drop on macOS, Windows and Linux (T2.4, D26, T3.7, T3.8): a menu bar or notification area icon, the node daemon
// running in the background, and the panel the daemon serves on 127.0.0.1, shown in a small window near the icon. The
// app holds no logic of its own: everything the panel does goes through the node's local API, protected by its token.
// What differs per system stays in this file behind `cfg(target_os = ...)`: the icon, how the panel opens (Linux icons
// emit no click, v2.tauri.app/learn/system-tray), the bundled program names, and single instance on Windows and Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, ChildStdout, Command, Stdio};
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(target_os = "macos")]
use tauri::window::{Effect, EffectState, EffectsBuilder};
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use tauri::{
    AppHandle, Manager, PhysicalPosition, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

const DEFAULT_RELAY: &str = "ws://127.0.0.1:7780/v1";

fn bootstrap_relay(configured: Option<String>) -> String {
    configured.unwrap_or_else(|| DEFAULT_RELAY.to_string())
}
const PANEL_WIDTH: f64 = 380.0;
const PANEL_HEIGHT: f64 = 620.0;
#[cfg(target_os = "macos")]
const PANEL_RADIUS: f64 = 12.0;
const TRAY: &str = "drop";
/// The app looks for an update at launch, then this often (D70).
const UPDATE_CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

struct Daemon {
    child: Mutex<Option<Child>>,
    ready: AtomicBool,
    verified_port: Mutex<Option<u16>>,
    retry: AtomicBool,
    stopping: AtomicBool,
    splash_url: Mutex<Option<Url>>,
    pending_links: Mutex<Vec<Url>>,
}

/// An update found by the last check, offered in the menu until the user installs it (T2.4, D70).
struct PendingUpdate(Mutex<Option<Update>>);

fn instance_marker() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{nanos}", std::process::id())
}

/// The user's home: `HOME` on macOS and Linux, `USERPROFILE` on Windows, which is what Node's `os.homedir()` returns
/// there too, so the app and a `drop` run in a terminal share one `.drop` folder (packages/node/src/home.ts).
fn user_home() -> PathBuf {
    let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    PathBuf::from(std::env::var(variable).unwrap_or_default())
}

fn drop_home() -> PathBuf {
    if let Ok(home) = std::env::var("DROP_HOME") {
        return PathBuf::from(home);
    }
    user_home().join(".drop")
}

/// The bundled Node runtime: Windows only runs it as an .exe (scripts/build-desktop.ts names it so). drop-iroh sits
/// next to it, where the node looks for it (packages/node/src/iroh.ts, irohBinary()).
const NODE_PROGRAM: &str = if cfg!(windows) { "node.exe" } else { "node" };

/// `node drop.mjs <args>` from the app's own resources, with DROP_HOME set.
fn drop_command(app: &AppHandle, args: &[&str]) -> Command {
    let resources = app.path().resource_dir().expect("resource dir");
    let mut command = Command::new(resources.join(NODE_PROGRAM));
    command
        .arg(resources.join("drop.mjs"))
        .args(args)
        .env("DROP_HOME", drop_home());
    // Node is a console program: without this flag Windows opens a console window for each run of the daemon.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// First launch: a private identity named after the Mac's user, on an explicitly configured or loopback relay. Joining a
/// team comes with an invite link (T4.23): on « Rejoindre », a node that joined nobody yet moves to the invite's relay,
/// checked by the node, so a link opened before or after this first launch lands on the same team.
fn ensure_identity(app: &AppHandle) -> Result<(), &'static str> {
    if drop_home().join("identity.json").exists() {
        return Ok(());
    }
    let full_name = Command::new("id")
        .arg("-F")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Moi".to_string());
    let first_name = full_name
        .split_whitespace()
        .next()
        .unwrap_or("Moi")
        .to_string();
    let relay = bootstrap_relay(std::env::var("DROP_RELAY_URL").ok());
    let status = drop_command(
        app,
        &[
            "init",
            "--profile",
            "private",
            "--name",
            &first_name,
            "--kind",
            "human",
            "--relay",
            &relay,
        ],
    )
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status()
    .map_err(|_| "E_INIT")?;
    if !status.success() || !drop_home().join("identity.json").exists() {
        return Err("E_INIT");
    }
    Ok(())
}

/// Appends `{ at, code, detail }` to ~/.drop/app.log: the app's own errors, with a stable code (AGENTS.md).
fn log_error(code: &str, detail: &str) {
    let at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let line = serde_json::json!({ "at": at, "code": code, "detail": detail });
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(drop_home().join("app.log")) {
        let _ = writeln!(file, "{line}");
    }
}

fn start_daemon(app: &AppHandle, marker: &str, port: u16) -> Result<(), &'static str> {
    if panel_url(port, &[]).is_none() {
        return Err("E_TOKEN");
    }
    if TcpStream::connect(("127.0.0.1", port)).is_ok() {
        return Err("E_PORT");
    }
    let log = fs::File::create(drop_home().join("daemon.log")).map_err(|_| "E_LOG")?;
    let mut command = drop_command(app, &["serve"]);
    // The daemon hands notifications to the app as JSON lines on stdout (T4.14), so they carry the app's icon.
    command.stdout(Stdio::piped()).env("DROP_NOTIFY", "shell");
    // The stdin pipe stays held by the Child kept in the app state: when the app dies, even killed, the system closes
    // it and the daemon stops itself (T4.18).
    command
        .stdin(Stdio::piped())
        .env("DROP_EXIT_WITH_PARENT", "stdin");
    command.stderr(log).env("DROP_SHELL_INSTANCE", marker);
    let mut child = command.spawn().map_err(|_| "E_SPAWN")?;
    if let Some(stdout) = child.stdout.take() {
        relay_notifications(app.clone(), stdout);
    }
    *app.state::<Daemon>().child.lock().map_err(|_| "E_STATE")? = Some(child);
    Ok(())
}

fn api_port() -> Result<u16, &'static str> {
    let text = fs::read_to_string(drop_home().join("config.json")).map_err(|_| "E_CONFIG")?;
    let config: serde_json::Value = serde_json::from_str(&text).map_err(|_| "E_CONFIG")?;
    let port = config
        .get("apiPort")
        .and_then(serde_json::Value::as_u64)
        .ok_or("E_CONFIG")?;
    u16::try_from(port)
        .ok()
        .filter(|port| *port > 0)
        .ok_or("E_CONFIG")
}

fn panel_url(port: u16, extra: &[(&str, String)]) -> Option<Url> {
    let token = fs::read_to_string(drop_home().join("local-token")).ok()?;
    let token = token.trim();
    if token.is_empty() {
        return None;
    }
    let mut url = Url::parse(&format!("http://127.0.0.1:{port}/app")).ok()?;
    url.query_pairs_mut().append_pair("token", token);
    for (key, value) in extra {
        url.query_pairs_mut().append_pair(key, value);
    }
    Some(url)
}

/// Same private bearer token, but a full-size local management surface.
/// The workspace is not granted Tauri IPC capabilities.
fn workspace_url(port: u16) -> Option<Url> {
    let mut url = panel_url(port, &[])?;
    url.set_path("/workspace");
    Some(url)
}

fn own_health(port: u16, marker: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let request = format!(
        "GET /_shell/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    if stream.take(4096).read_to_string(&mut response).is_err() {
        return false;
    }
    let Some((head, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    if !head.starts_with("HTTP/1.1 200 ") {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|json| {
            json.get("instance")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .as_deref()
        == Some(marker)
}

/// True once the daemon the app launched has exited (a poisoned lock or no child counts as not exited).
fn child_exited(app: &AppHandle) -> bool {
    app.state::<Daemon>()
        .child
        .lock()
        .ok()
        .and_then(|mut guard| {
            guard
                .as_mut()
                .and_then(|child| child.try_wait().ok().flatten())
        })
        .is_some()
}

fn wait_for_daemon(app: &AppHandle, port: u16, marker: &str) -> bool {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if child_exited(app) {
            return false;
        }
        if own_health(port, marker) {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }
    false
}

fn stop_daemon(app: &AppHandle) {
    if let Ok(mut guard) = app.state::<Daemon>().child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    app.state::<Daemon>().ready.store(false, Ordering::SeqCst);
    *app.state::<Daemon>()
        .verified_port
        .lock()
        .expect("verified port") = None;
}

fn show_splash(app: &AppHandle, code: &str) {
    app.state::<Daemon>().ready.store(false, Ordering::SeqCst);
    let Some(base) = app
        .state::<Daemon>()
        .splash_url
        .lock()
        .ok()
        .and_then(|url| url.clone())
    else {
        return;
    };
    let mut url = base;
    url.query_pairs_mut().clear().append_pair("state", code);
    if let Some(window) = app.get_webview_window("panel") {
        let _ = window.navigate(url);
    }
}

/// How many automatic restarts follow a run that failed, before the error splash waits for the user.
const MAX_RESTARTS: u8 = 2;
/// A run that stayed ready this long earns a fresh restart budget; a daemon that reaches ready then dies sooner, every
/// time, still runs out of restarts and shows E_RESTART instead of looping forever.
const MIN_HEALTHY_RUN: Duration = Duration::from_secs(5 * 60);

/// After a run that had reached ready and stayed so for `healthy_for`: `Some(restarts)` restarts the daemon with that
/// count, `None` gives up. A retry the user asked for never counts as a failure.
fn restart_after_run(user_retry: bool, restarts: u8, healthy_for: Duration) -> Option<u8> {
    if user_retry {
        return Some(0);
    }
    let restarts = if healthy_for >= MIN_HEALTHY_RUN {
        0
    } else {
        restarts
    };
    if restarts < MAX_RESTARTS {
        Some(restarts + 1)
    } else {
        None
    }
}

fn supervise(app: AppHandle) {
    let mut restarts = 0u8;
    while !app.state::<Daemon>().stopping.load(Ordering::SeqCst) {
        show_splash(&app, "starting");
        let marker = instance_marker();
        let result = ensure_identity(&app)
            .and_then(|_| api_port())
            .and_then(|port| {
                start_daemon(&app, &marker, port)?;
                if wait_for_daemon(&app, port, &marker) {
                    let url = panel_url(port, &[]).ok_or("E_TOKEN")?;
                    let window = app.get_webview_window("panel").ok_or("E_PANEL")?;
                    window.navigate(url).map_err(|_| "E_PANEL")?;
                    Ok(port)
                } else {
                    Err("E_START")
                }
            });
        match result {
            Ok(port) => {
                let ready_at = Instant::now();
                *app.state::<Daemon>()
                    .verified_port
                    .lock()
                    .expect("verified port") = Some(port);
                app.state::<Daemon>().ready.store(true, Ordering::SeqCst);
                let links = std::mem::take(
                    &mut *app
                        .state::<Daemon>()
                        .pending_links
                        .lock()
                        .expect("link queue"),
                );
                open_links(&app, links);
                let mut failed_checks = 0u8;
                // The swap clears the flag: keep its result, or the user's retry would count as a health failure.
                let mut user_retry = false;
                while app.state::<Daemon>().ready.load(Ordering::SeqCst)
                    && !app.state::<Daemon>().stopping.load(Ordering::SeqCst)
                {
                    thread::sleep(Duration::from_secs(3));
                    if app.state::<Daemon>().retry.swap(false, Ordering::SeqCst) {
                        user_retry = true;
                        break;
                    }
                    if child_exited(&app) || !own_health(port, &marker) {
                        failed_checks += 1;
                    } else {
                        failed_checks = 0;
                    }
                    if failed_checks >= 2 {
                        break;
                    }
                }
                stop_daemon(&app);
                // A retry asked while the daemon was stopping counts as the user's too.
                let user_retry =
                    user_retry || app.state::<Daemon>().retry.swap(false, Ordering::SeqCst);
                if let Some(next) = restart_after_run(user_retry, restarts, ready_at.elapsed()) {
                    if !user_retry {
                        eprintln!("drop shell E_HEALTH: retry {next}/{MAX_RESTARTS}");
                    }
                    restarts = next;
                    continue;
                }
                eprintln!("drop shell E_RESTART");
                show_splash(&app, "E_RESTART");
            }
            Err(code) => {
                eprintln!("drop shell {code}");
                stop_daemon(&app);
                if code == "E_START" && restarts < MAX_RESTARTS {
                    restarts += 1;
                    eprintln!("drop shell E_START: retry {restarts}/{MAX_RESTARTS}");
                    continue;
                }
                if code == "E_START" {
                    eprintln!("drop shell E_RESTART");
                }
                show_splash(&app, if code == "E_START" { "E_RESTART" } else { code });
            }
        }
        // A persistent failure remains visible until the user explicitly retries from the tray menu.
        while !app.state::<Daemon>().retry.swap(false, Ordering::SeqCst)
            && !app.state::<Daemon>().stopping.load(Ordering::SeqCst)
        {
            thread::sleep(Duration::from_millis(300));
        }
        restarts = 0;
    }
}

/// Where the panel goes for a click on the icon at `click`, in physical pixels: centred on the click, under it when the
/// icon sits at the top of the screen (the macOS menu bar), above it when there is room, as with the Windows taskbar at
/// the bottom. Never off the left or top edge.
fn panel_position(click: PhysicalPosition<f64>, scale: f64, prefer_above: bool) -> PhysicalPosition<f64> {
    let x = (click.x - PANEL_WIDTH * scale / 2.0).max(0.0);
    let gap = 8.0 * scale;
    let above = click.y - PANEL_HEIGHT * scale - gap;
    let y = if prefer_above && above >= 0.0 {
        above
    } else {
        click.y + gap
    };
    PhysicalPosition::new(x, y)
}

fn show_panel(app: &AppHandle, near: Option<PhysicalPosition<f64>>) {
    let Some(window) = app.get_webview_window("panel") else {
        return;
    };
    if let Some(position) = near {
        let scale = window.scale_factor().unwrap_or(1.0);
        let _ = window.set_position(panel_position(position, scale, cfg!(windows)));
    } else if !cfg!(target_os = "macos") {
        // Opened from the menu (always so on Linux): no click position, the middle of the screen.
        let _ = window.center();
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Opens a normal desktop window for settings. Never enlarges or pins the transient tray popover.
fn show_workspace(app: &AppHandle) {
    if !app.state::<Daemon>().ready.load(Ordering::SeqCst) {
        show_panel(app, None);
        return;
    }
    let Some(port) = *app.state::<Daemon>().verified_port.lock().expect("verified port") else {
        show_panel(app, None);
        return;
    };
    let Some(url) = workspace_url(port) else {
        show_panel(app, None);
        return;
    };
    if let Some(window) = app.get_webview_window("workspace") {
        let _ = window.navigate(url);
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    match WebviewWindowBuilder::new(app, "workspace", WebviewUrl::External(url))
        .title("drop · Mon espace")
        .inner_size(980.0, 720.0)
        .min_inner_size(720.0, 560.0)
        .resizable(true)
        .decorations(true)
        .build()
    {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(error) => log_error("E_WORKSPACE", &error.to_string()),
    }
}

/// Notifications handed over by the daemon (`DROP_NOTIFY=shell`, T4.14): one JSON object per line. Anything else
/// on stdout is ignored. Peer text arrives as JSON strings and stays plain notification text, cut at 200 characters.
fn relay_notifications(app: AppHandle, stdout: ChildStdout) {
    thread::spawn(move || {
        // Split on bytes: one malformed line must not stop the reader and close the daemon's stdout.
        for raw in BufReader::new(stdout).split(b'\n').map_while(Result::ok) {
            let line = String::from_utf8_lossy(&raw);
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let Some(notice) = value.get("dropNotify") else {
                continue;
            };
            let text = |key: &str| {
                notice
                    .get(key)
                    .and_then(serde_json::Value::as_str)
                    .map(|s| s.chars().take(200).collect::<String>())
            };
            if let (Some(title), Some(subtitle)) = (text("title"), text("subtitle")) {
                show_notification(&app, title, subtitle);
            }
        }
    });
}

/// Notifications waiting for a click at once; beyond this, new ones are shown without waiting.
#[cfg(target_os = "macos")]
static WAITING: AtomicUsize = AtomicUsize::new(0);
#[cfg(target_os = "macos")]
const MAX_WAITING: usize = 8;
#[cfg(target_os = "macos")]
static IDENTITY: std::sync::Once = std::sync::Once::new();

/// Shown under the app's identity, hence its icon; a click opens the panel where it last was.
#[cfg(target_os = "macos")]
fn show_notification(app: &AppHandle, title: String, body: String) {
    let app = app.clone();
    let identifier = app.config().identifier.clone();
    thread::spawn(move || {
        IDENTITY.call_once(|| {
            if let Err(error) = mac_notification_sys::set_application(&identifier) {
                eprintln!("E_NOTIFY cannot use the app identity: {error}");
            }
        });
        let wait = WAITING.fetch_add(1, Ordering::SeqCst) < MAX_WAITING;
        let mut options = mac_notification_sys::Notification::new();
        options.wait_for_click(wait);
        match mac_notification_sys::send_notification(&title, None, &body, Some(&options)) {
            Ok(mac_notification_sys::NotificationResponse::Click) => show_panel(&app, None),
            Ok(_) => {}
            Err(error) => eprintln!("E_NOTIFY {error}"),
        }
        WAITING.fetch_sub(1, Ordering::SeqCst);
    });
}

#[cfg(not(target_os = "macos"))]
fn show_notification(_app: &AppHandle, _title: String, _body: String) {}

fn toggle_panel(app: &AppHandle, near: PhysicalPosition<f64>) {
    if let Some(window) = app.get_webview_window("panel") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            return;
        }
    }
    show_panel(app, Some(near));
}

#[tauri::command]
fn retry_daemon(app: AppHandle) {
    app.state::<Daemon>().retry.store(true, Ordering::SeqCst);
}

/// The longest `drop://` link the app accepts: an invite with its admission ticket and iroh addresses fits well under.
const MAX_LINK_CHARS: usize = 4096;

/// Whether a `drop://` link is one the panel handles: `join` and `pair` (an invite), `link` (an assistant).
fn handled_link(url: &Url) -> bool {
    url.scheme() == "drop"
        && matches!(url.host_str(), Some("join" | "pair" | "link"))
        && url.as_str().len() <= MAX_LINK_CHARS
}

/// What the panel receives for a link, as query parameters of its own local URL. `drop://join?invite=…` (the join
/// page's button, T4.23) and `drop://pair?code=…` (T4.14) both open the confirmation card: the node checks the invite
/// and shows who invites before anything is sent. `drop://link?session=…&gateway=…&client=…&client_id=…&redirect=…`
/// asks to link an assistant such as Claude or ChatGPT (T2.13); the panel shows the domain the answers return to,
/// which the gateway checks against the session (D71). Anything else gives nothing.
fn panel_params(link: &Url) -> Vec<(&'static str, String)> {
    if !handled_link(link) {
        return vec![];
    }
    let param = |name: &str| {
        link.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    let invite = |value: Option<String>| {
        value
            .filter(|code| {
                !code.is_empty()
                    && code
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
            .map(|code| vec![("pair", code)])
            .unwrap_or_default()
    };
    match link.host_str() {
        Some("join") => invite(param("invite")),
        Some("pair") => invite(param("code")),
        Some("link") => match (param("session"), param("gateway")) {
            (Some(session), Some(gateway)) => vec![
                ("link", session),
                ("gateway", gateway),
                (
                    "client",
                    param("client").unwrap_or_else(|| "Un assistant".to_string()),
                ),
                ("clientId", param("client_id").unwrap_or_default()),
                ("redirect", param("redirect").unwrap_or_default()),
            ],
            _ => vec![],
        },
        _ => vec![],
    }
}

/// Opens each handled `drop://` link in the panel, where the user decides. Before the daemon is ready (first launch,
/// or a link that started the app), links wait in a short queue and open once it is.
fn open_links(app: &AppHandle, urls: Vec<Url>) {
    if !app.state::<Daemon>().ready.load(Ordering::SeqCst) {
        let daemon = app.state::<Daemon>();
        let mut queue = daemon.pending_links.lock().expect("link queue");
        for url in urls {
            if queue.len() >= 8 {
                break;
            }
            if handled_link(&url) {
                queue.push(url);
            }
        }
        show_panel(app, None);
        return;
    }
    let Some(port) = *app
        .state::<Daemon>()
        .verified_port
        .lock()
        .expect("verified port")
    else {
        return;
    };
    for link in urls {
        let extra = panel_params(&link);
        if extra.is_empty() {
            continue;
        }
        if let (Some(window), Some(url)) =
            (app.get_webview_window("panel"), panel_url(port, &extra))
        {
            let _ = window.navigate(url);
            show_panel(app, None);
        }
    }
}

/// The icon's menu; with an update pending it starts with "Mettre à jour vers x.y.z", greyed out while installing.
/// The same menu on the three systems; on Linux it is the only way in, since the icon emits no click.
fn set_tray_menu(app: &AppHandle, update: Option<&str>, installing: bool) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Ouvrir le panneau", true, None::<&str>)?;
    let workspace = MenuItem::with_id(app, "workspace", "Ouvrir mon espace", true, None::<&str>)?;
    let retry = MenuItem::with_id(app, "retry", "Réessayer le démarrage", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let menu = match update {
        Some(version) => {
            let label = if installing {
                format!("Mise à jour vers {version}…")
            } else {
                format!("Mettre à jour vers {version}")
            };
            let item = MenuItem::with_id(app, "update", label, !installing, None::<&str>)?;
            Menu::with_items(app, &[&item, &open, &workspace, &retry, &quit])?
        }
        None => Menu::with_items(app, &[&open, &workspace, &retry, &quit])?,
    };
    if let Some(tray) = app.tray_by_id(TRAY) {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

/// Checks the update endpoint; a newer version, signed for that version with drop's key, is offered in the menu.
/// Nothing is downloaded before the user clicks it.
fn check_for_update(app: &AppHandle) {
    let found = tauri::async_runtime::block_on(async {
        match app.updater() {
            Ok(updater) => updater.check().await,
            Err(error) => Err(error),
        }
    });
    match found {
        Ok(Some(update)) => {
            let version = update.version.clone();
            *app.state::<PendingUpdate>().0.lock().unwrap() = Some(update);
            if let Err(error) = set_tray_menu(app, Some(&version), false) {
                log_error("E_UPDATE_MENU", &error.to_string());
            }
        }
        Ok(None) => {}
        Err(error) => log_error("E_UPDATE_CHECK", &error.to_string()),
    }
}

/// Downloads the pending update, checks its signature, replaces the app, then restarts it with its daemon.
fn install_update(app: &AppHandle) {
    let Some(update) = app.state::<PendingUpdate>().0.lock().unwrap().take() else { return };
    let version = update.version.clone();
    let _ = set_tray_menu(app, Some(&version), true);
    let app = app.clone();
    thread::spawn(move || {
        match tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {})) {
            Ok(()) => {
                stop_daemon(&app);
                app.restart();
            }
            Err(error) => {
                log_error("E_UPDATE_INSTALL", &error.to_string());
                // Offered again by the next check.
                let _ = set_tray_menu(&app, None, false);
            }
        }
    });
}

/// The panel window. macOS: a popover under the menu bar icon, with the system's material. Windows: a borderless panel
/// above the taskbar icon. Linux: a normal small window in the middle of the screen, since the icon gives no position
/// and Wayland lets no app place its windows; its title bar also gives it a close button.
fn build_panel(app: &tauri::App) -> tauri::Result<tauri::WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, "panel", WebviewUrl::App("index.html".into()))
        .title("drop")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .resizable(false)
        .visible(false);
    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // A popover material with rounded corners, like the system menu bar extras.
        .transparent(true)
        .shadow(true)
        .effects(
            EffectsBuilder::new()
                .effect(Effect::Popover)
                .state(EffectState::Active)
                .radius(PANEL_RADIUS)
                .build(),
        );
    #[cfg(windows)]
    let builder = builder
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true);
    #[cfg(target_os = "linux")]
    let builder = builder.decorations(true).skip_taskbar(false);
    builder.build()
}

fn main() {
    let builder = tauri::Builder::default();
    // First plugin, as the docs require: a second launch (the Start menu, a login item racing the user, a drop:// link)
    // hands its arguments to the running app and exits, so there is never a second daemon or a second icon. With the
    // deep-link feature the plugin passes a link on to the deep-link handler below before this callback runs.
    #[cfg(any(windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        show_panel(app, None);
    }));
    let app = builder
        .invoke_handler(tauri::generate_handler![retry_daemon])
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(Daemon {
            child: Mutex::new(None),
            ready: AtomicBool::new(false),
            verified_port: Mutex::new(None),
            retry: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            splash_url: Mutex::new(None),
            pending_links: Mutex::new(Vec::new()),
        })
        .manage(PendingUpdate(Mutex::new(None)))
        .setup(|app| {
            // A menu bar app: no Dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(ActivationPolicy::Accessory);
            let handle = app.handle().clone();
            // Only a build made with the update key carries the updater config (scripts/build-desktop.ts --updates).
            let updates = app.config().plugins.0.contains_key("updater");
            if updates {
                handle.plugin(tauri_plugin_updater::Builder::new().build())?;
            }

            let window = build_panel(app)?;
            *handle
                .state::<Daemon>()
                .splash_url
                .lock()
                .expect("splash URL") = Some(window.url()?);
            let hide_on_blur = window.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::Focused(false) => {
                    let _ = hide_on_blur.hide();
                }
                // Alt+F4 on Windows, the title bar's close button on Linux: the panel hides and stays, or the icon
                // would have nothing left to open. Only « Quitter » ends the app.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = hide_on_blur.hide();
                }
                _ => {}
            });

            let ready = handle.clone();
            thread::spawn(move || supervise(ready));

            // macOS draws the black template drop in the menu bar's colours; the notification areas of Windows and
            // Linux show the colour icon, readable on a light or dark bar.
            #[cfg(target_os = "macos")]
            let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            #[cfg(not(target_os = "macos"))]
            let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
            TrayIconBuilder::with_id(TRAY)
                .icon(icon)
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("drop")
                // A left click opens the panel on macOS and Windows, the right click the menu. Linux ignores this:
                // any click opens the menu.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_panel(app, None),
                    "workspace" => show_workspace(app),
                    "retry" => {
                        app.state::<Daemon>().retry.store(true, Ordering::SeqCst);
                        show_panel(app, None);
                    }
                    "update" => install_update(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        toggle_panel(tray.app_handle(), position);
                    }
                })
                .build(app)?;
            // One menu builder for the first menu and the update menus.
            set_tray_menu(&handle, None, false)?;

            // The .deb, NSIS and MSI installers register drop:// (tauri-bundler); nothing installs an AppImage, so it
            // registers the scheme for this user at each launch, which also follows a moved file (v2.tauri.app/plugin/
            // deep-linking). Without it the join page's button does nothing; its code to paste still works (T4.31).
            #[cfg(target_os = "linux")]
            if app.env().appimage.is_some() {
                if let Err(error) = app.deep_link().register_all() {
                    log_error("E_DEEP_LINK", &error.to_string());
                }
            }
            let links = handle.clone();
            app.deep_link()
                .on_open_url(move |event| open_links(&links, event.urls()));
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                open_links(&handle, urls);
            }
            // Starts with the session, like a menu bar app should: a login item on macOS, the Run key of the current user
            // on Windows, an XDG autostart entry on Linux (the AppImage's own path when run from one). The user can turn
            // it off in the system settings. Only the release build registers itself: a debug build must not end up in
            // the developer's login items.
            if !cfg!(debug_assertions) {
                let _ = app.autolaunch().enable();
            }
            if updates {
                let checker = handle.clone();
                thread::spawn(move || loop {
                    check_for_update(&checker);
                    thread::sleep(UPDATE_CHECK_EVERY);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("drop failed to start");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle
                .state::<Daemon>()
                .stopping
                .store(true, Ordering::SeqCst);
            stop_daemon(handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn a_user_retry_restarts_without_spending_the_restart_budget() {
        // The user's "Réessayer" never counts as a health failure, even with the budget spent.
        let short = Duration::from_secs(10);
        assert_eq!(restart_after_run(true, MAX_RESTARTS, short), Some(0));
        assert_eq!(restart_after_run(true, 0, short), Some(0));
    }

    #[test]
    fn short_lived_ready_runs_exhaust_the_restart_budget() {
        // A daemon that reaches ready then dies within seconds, every cycle, gives up after MAX_RESTARTS.
        let short = MIN_HEALTHY_RUN - Duration::from_secs(1);
        let mut restarts = 0u8;
        let mut cycles = 0;
        while let Some(next) = restart_after_run(false, restarts, short) {
            restarts = next;
            cycles += 1;
            assert!(cycles <= MAX_RESTARTS, "the budget must run out");
        }
        assert_eq!(cycles, MAX_RESTARTS);
        assert_eq!(restarts, MAX_RESTARTS);
    }

    #[test]
    fn a_long_healthy_run_resets_the_restart_budget() {
        // With the budget spent, a run that stayed ready MIN_HEALTHY_RUN restarts as a first failure.
        assert_eq!(
            restart_after_run(false, MAX_RESTARTS, MIN_HEALTHY_RUN),
            Some(1)
        );
        assert_eq!(
            restart_after_run(
                false,
                MAX_RESTARTS,
                MIN_HEALTHY_RUN + Duration::from_secs(3600)
            ),
            Some(1)
        );
        assert_eq!(
            restart_after_run(false, MAX_RESTARTS, Duration::from_secs(1)),
            None
        );
    }

    #[test]
    fn the_panel_opens_under_a_top_icon_and_above_a_bottom_one() {
        // A macOS menu bar icon at the top: under it, centred.
        let top = panel_position(PhysicalPosition::new(1000.0, 24.0), 2.0, false);
        assert_eq!((top.x, top.y), (1000.0 - PANEL_WIDTH, 24.0 + 16.0));
        // A Windows taskbar icon at the bottom of a 1080 px screen: above it.
        let bottom = panel_position(PhysicalPosition::new(1800.0, 1060.0), 1.0, true);
        assert_eq!(bottom.y, 1060.0 - PANEL_HEIGHT - 8.0);
        // A taskbar at the top: no room above, so under it; never past the left edge.
        let high = panel_position(PhysicalPosition::new(20.0, 30.0), 1.0, true);
        assert_eq!((high.x, high.y), (0.0, 38.0));
    }

    #[test]
    fn bootstrap_uses_loopback_or_explicit_relay() {
        assert_eq!(bootstrap_relay(None), "ws://127.0.0.1:7780/v1");
        assert_eq!(
            bootstrap_relay(Some("wss://10.0.0.2/v1".to_string())),
            "wss://10.0.0.2/v1"
        );
    }

    #[test]
    fn join_and_pair_links_open_the_invite_confirmation() {
        let url = |text: &str| Url::parse(text).expect("test URL");
        let code = "eyJyZWxheVVybCI6IndzczovL2Ryb3AubWVtb2xhYnMuZGV2L3YxIn0";
        assert_eq!(
            panel_params(&url(&format!("drop://join?invite={code}"))),
            vec![("pair", code.to_string())]
        );
        assert_eq!(
            panel_params(&url(&format!("drop://pair?code={code}"))),
            vec![("pair", code.to_string())]
        );
        // Not a code, no code, an unknown host, another scheme or an oversized link: nothing opens.
        for refused in [
            "drop://join?invite=%3Cscript%3E".to_string(),
            "drop://join".to_string(),
            format!("drop://other?invite={code}"),
            format!("https://drop.memolabs.dev/join?invite={code}"),
            format!("drop://join?invite={}", "a".repeat(MAX_LINK_CHARS)),
        ] {
            assert!(panel_params(&url(&refused)).is_empty(), "{refused}");
        }
        assert!(handled_link(&url(&format!("drop://join?invite={code}"))));
        assert!(!handled_link(&url("drop://settings")));
    }

    #[test]
    fn health_probe_accepts_only_the_launched_instance() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener");
        let port = listener.local_addr().expect("test address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("request");
            let mut request = [0u8; 512];
            let size = stream.read(&mut request).expect("request body");
            assert!(String::from_utf8_lossy(&request[..size])
                .starts_with("GET /_shell/health HTTP/1.1"));
            let body = r#"{"instance":"other-process"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).expect("response");
        });
        assert!(!own_health(port, "our-process"));
        server.join().expect("server thread");
    }
}
