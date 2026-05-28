import { describe, expect, it, vi } from 'vitest';
import { handleExternalWindowOpen } from '../../src/main/external-link-policy';

describe('external link policy', () => {
  it('opens only allowlisted web URLs through the OS shell', () => {
    const shell = {
      openExternal: vi.fn()
    };
    const logService = {
      append: vi.fn()
    };

    const result = handleExternalWindowOpen('https://example.com/docs', { shell, logService });

    expect(result).toEqual({ action: 'deny' });
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/docs');
    expect(logService.append).not.toHaveBeenCalled();
  });

  it('blocks arbitrary schemes instead of forwarding them to shell.openExternal', () => {
    const shell = {
      openExternal: vi.fn()
    };
    const logService = {
      append: vi.fn()
    };

    const result = handleExternalWindowOpen('roc-preview://workspace/pdf/secret.pdf', { shell, logService });

    expect(result).toEqual({ action: 'deny' });
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(logService.append).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        message: 'Blocked external link with unsupported scheme.'
      })
    );
  });
});
