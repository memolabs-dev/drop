import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The `code` of a Node.js system error (ENOENT, EEXIST…), or undefined for anything else. */
export function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

/**
 * Makes a rename, a creation or an unlink in `path` durable on macOS and Linux. Windows cannot flush a directory: it
 * refuses FlushFileBuffers on a directory handle (EPERM), so only this call is skipped there. Since T3.1e the replay
 * store admits a request without any directory change (an append to an existing journal, flushed through its own
 * handle); only the one-time creation of its journals goes through here.
 */
export function syncDirectory(path: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return;
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces `path` with `content`, owner-only, through a flushed temporary file renamed over it and a flush of its
 * folder. A failed write removes its temporary file, so repeated failures leave nothing behind.
 */
export function writeDurablePrivate(path: string, content: string): void {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    syncDirectory(join(path, '..'));
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if (errorCode(cleanupError) !== 'ENOENT') {
        throw new AggregateError([error, cleanupError], 'E_REPLAY_STATE temp cleanup failed', {
          cause: cleanupError,
        });
      }
    }
    throw error;
  }
}
