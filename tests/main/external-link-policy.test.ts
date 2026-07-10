import { describe, expect, it, vi } from 'vitest';
import { handleExternalNavigation } from '../../src/main/external-link-policy';

describe('external link policy', () => {
  it.each(['https://example.com/docs', 'http://example.com/docs'])(
    'opens an allowlisted web URL through the OS shell: %s',
    (url) => {
      const shell = {
        openExternal: vi.fn()
      };
      const logService = {
        warn: vi.fn()
      };

      const result = handleExternalNavigation(url, { shell, logService });

      expect(result).toEqual({ action: 'deny' });
      expect(shell.openExternal).toHaveBeenCalledWith(url);
      expect(logService.warn).not.toHaveBeenCalled();
    }
  );

  it.each([
    'file:///C:/secret.txt?token=sensitive',
    'javascript:alert(1)',
    'data:text/html,owned',
    'roc-preview://workspace/pdf/secret.pdf'
  ])('blocks an unsupported top-level URL without logging its query or path: %s', (url) => {
    const shell = {
      openExternal: vi.fn()
    };
    const logService = {
      warn: vi.fn()
    };

    const result = handleExternalNavigation(url, { shell, logService });

    expect(result).toEqual({ action: 'deny' });
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(logService.warn).toHaveBeenCalledWith('Blocked top-level navigation with unsupported scheme.', {
      service: 'external-link-policy',
      component: 'handleExternalNavigation',
      metadata: {
        scheme: new URL(url).protocol
      }
    });
    expect(JSON.stringify(logService.warn.mock.calls)).not.toContain('sensitive');
    expect(JSON.stringify(logService.warn.mock.calls)).not.toContain('/secret');
  });

  it('blocks an invalid top-level URL without logging the raw value', () => {
    const shell = {
      openExternal: vi.fn()
    };
    const logService = {
      warn: vi.fn()
    };

    const url = 'not a valid URL?token=sensitive';
    const result = handleExternalNavigation(url, { shell, logService });

    expect(result).toEqual({ action: 'deny' });
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(logService.warn).toHaveBeenCalledWith('Blocked invalid top-level navigation.', {
      service: 'external-link-policy',
      component: 'handleExternalNavigation'
    });
    expect(JSON.stringify(logService.warn.mock.calls)).not.toContain(url);
  });
});
