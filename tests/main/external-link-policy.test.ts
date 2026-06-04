import { describe, expect, it, vi } from 'vitest';
import { handleExternalWindowOpen } from '../../src/main/external-link-policy';

describe('external link policy', () => {
  it('opens only allowlisted web URLs through the OS shell', () => {
    const shell = {
      openExternal: vi.fn()
    };
    const logService = {
      warn: vi.fn()
    };

    const result = handleExternalWindowOpen('https://example.com/docs', { shell, logService });

    expect(result).toEqual({ action: 'deny' });
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/docs');
    expect(logService.warn).not.toHaveBeenCalled();
  });

  it('blocks arbitrary schemes instead of forwarding them to shell.openExternal', () => {
    const shell = {
      openExternal: vi.fn()
    };
    const logService = {
      warn: vi.fn()
    };

    const result = handleExternalWindowOpen('roc-preview://workspace/pdf/secret.pdf', { shell, logService });

    expect(result).toEqual({ action: 'deny' });
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(logService.warn).toHaveBeenCalledWith('Blocked external link with unsupported scheme.', {
      service: 'external-link-policy',
      component: 'handleExternalWindowOpen',
      metadata: {
        scheme: 'roc-preview:'
      }
    });
  });
});
