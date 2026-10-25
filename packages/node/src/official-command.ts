import { execFile } from 'node:child_process';
import { isAbsolute as posixAbsolute } from 'node:path';
import { promisify } from 'node:util';

/**
 * Runs a client's official command (Claude Code, Codex) on macOS, Linux and Windows (T4.22). On Windows an npm install
 * gives a `.cmd` shim, which Node refuses to start without a shell since its April 2024 security release
 * (nodejs.org/api/child_process.html, "Spawning .bat and .cmd files on Windows"). It then goes through `cmd.exe` as
 * Node's own `shell` option does, but only when every argument is safe inside double quotes; otherwise the command is
 * refused (E_CLI_SHIM_UNSAFE) and the owner gets it to run by hand.
 */
const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 60_000;

/** Inside double quotes, cmd.exe still expands `%` (and `!` with delayed expansion), and `"` would end the quotes. */
const UNSAFE_FOR_CMD = /["%!^]|\\$/;

function safeForCmd(arg: string): boolean {
  if (arg === '' || UNSAFE_FOR_CMD.test(arg)) return false;
  // No control character either: a line break would end the command.
  for (let index = 0; index < arg.length; index += 1) if (arg.charCodeAt(index) < 0x20) return false;
  return true;
}

/** The `cmd.exe` invocation of a `.cmd` or `.bat` shim, every argument quoted; throws when one cannot be. */
export function windowsShimCommand(argv: readonly string[]): { file: string; args: string[] } {
  if (argv.length === 0 || !argv.every(safeForCmd)) throw new Error('E_CLI_SHIM_UNSAFE');
  const line = argv.map((arg) => `"${arg}"`).join(' ');
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`] };
}

export function isWindowsShim(file: string): boolean {
  return /\.(cmd|bat)$/i.test(file);
}

/** Bounded: an official command waiting for an update or a login must not hold the daemon, nor block it meanwhile. */
export async function runOfficial(argv: string[], platform: NodeJS.Platform = process.platform): Promise<void> {
  const [file = '', ...args] = argv;
  // Refuse an executable resolved relative to cwd/PATH at the command sink.
  // Onboarding resolves official binaries to absolute file paths first.
  // Windows root-relative paths (\\foo) depend on the current drive, and UNC paths
  // can execute programs from remote shares. Require a drive-qualified local path.
  const absolute = platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(file) : posixAbsolute(file);
  if (!absolute) throw new Error('E_CLI_BINARY_PATH');
  const shim = platform === 'win32' && isWindowsShim(file);
  // A fixed cmd.exe, never the ComSpec variable: the shell that runs a shim does not come from the environment.
  const command = shim ? windowsShimCommand(argv) : { file, args };
  const running = execFileAsync(command.file, command.args, {
    // Through cmd.exe, killing cmd.exe alone would leave the node process it started: the whole tree goes below.
    timeout: shim ? 0 : TIMEOUT_MS,
    killSignal: 'SIGKILL',
    windowsHide: true,
    // The arguments above are already quoted for cmd.exe; Node must not quote them again.
    windowsVerbatimArguments: shim,
  });
  const pid = running.child.pid;
  const timer =
    shim && pid !== undefined
      ? setTimeout(() => {
          execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => undefined);
        }, TIMEOUT_MS)
      : undefined;
  // Its output is not read, and a question it asks gets end of input at once, as with stdio ignored.
  running.child.stdin?.end();
  try {
    await running;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
