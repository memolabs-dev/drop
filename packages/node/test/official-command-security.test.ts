import { describe, expect, it } from 'vitest';
import { runOfficial } from '../src/official-command.ts';

describe('official CLI command execution boundary (security #114)', () => {
  it('rejects relative or PATH-resolved executable names before process launch', async () => {
    await expect(runOfficial(['codex', 'mcp', 'list'], 'linux')).rejects.toThrow('E_CLI_BINARY_PATH');
    await expect(runOfficial(['./codex', 'mcp', 'list'], 'darwin')).rejects.toThrow('E_CLI_BINARY_PATH');
    await expect(runOfficial(['codex.cmd', 'mcp', 'list'], 'win32')).rejects.toThrow('E_CLI_BINARY_PATH');
    await expect(runOfficial(['C:codex.cmd', 'mcp', 'list'], 'win32')).rejects.toThrow('E_CLI_BINARY_PATH');
    await expect(runOfficial(['\\\\server\\share\\codex.cmd'], 'win32')).rejects.toThrow('E_CLI_BINARY_PATH');
    await expect(runOfficial(['\\codex.cmd'], 'win32')).rejects.toThrow('E_CLI_BINARY_PATH');
  });
});
