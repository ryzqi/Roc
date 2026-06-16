import { describe, expect, it, vi } from 'vitest';
import { CommandRewriter, isWindowsRtkDeniedSubcommand, parseRtkArgs } from '../../src/rtk-integration/rewriter';

describe('CommandRewriter', () => {
  it('returns rewritten RTK command and parsed RTK args', async () => {
    const runRewrite = vi.fn().mockResolvedValue({
      stdout: 'rtk git status\n',
      exitCode: 3
    });
    const rewriter = new CommandRewriter('rtk.exe', { runRewrite });

    const result = await rewriter.rewrite('git status');

    expect(runRewrite).toHaveBeenCalledWith('rtk.exe', ['rewrite', 'git status'], 2000);
    expect(result).toEqual({
      rewritten: 'rtk git status',
      rtkArgs: ['git', 'status'],
      exitCode: 3
    });
  });

  it('returns null when RTK has no equivalent command', async () => {
    const rewriter = new CommandRewriter('rtk.exe', {
      runRewrite: vi.fn().mockResolvedValue({
        stdout: '',
        exitCode: 1
      })
    });

    await expect(rewriter.rewrite('htop')).resolves.toEqual({
      rewritten: null,
      rtkArgs: null,
      exitCode: 1
    });
  });

  it('falls back silently when RTK rewrite fails', async () => {
    const rewriter = new CommandRewriter('rtk.exe', {
      runRewrite: vi.fn().mockRejectedValue(new Error('timeout'))
    });

    await expect(rewriter.rewrite('git status')).resolves.toEqual({
      rewritten: null,
      rtkArgs: null,
      exitCode: 1
    });
  });

  it('parses quoted RTK commands and ignores non-RTK commands', () => {
    expect(parseRtkArgs('rtk read "notes file.md"')).toEqual(['read', 'notes file.md']);
    expect(parseRtkArgs("rtk read 'notes file.md'")).toEqual(['read', 'notes file.md']);
    expect(parseRtkArgs('git status')).toBeNull();
    expect(parseRtkArgs('')).toBeNull();
  });

  it('preserves deny exit code from RTK', async () => {
    const rewriter = new CommandRewriter('rtk.exe', {
      runRewrite: vi.fn().mockResolvedValue({
        stdout: '',
        exitCode: 2
      })
    });

    await expect(rewriter.rewrite('rm -rf .')).resolves.toEqual({
      rewritten: null,
      rtkArgs: null,
      exitCode: 2
    });
  });

  it('identifies Windows shell aliases that must not be routed to RTK', () => {
    expect(isWindowsRtkDeniedSubcommand(['ls'])).toBe(true);
    expect(isWindowsRtkDeniedSubcommand(['ls', '.'])).toBe(true);
    expect(isWindowsRtkDeniedSubcommand(['git', 'status'])).toBe(false);
  });
});
