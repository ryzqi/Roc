import { describe, expect, it, vi } from 'vitest';

import { executeIpcRequest } from '../../src/main/ipc/ipc-common';

describe('IPC runtime contract boundary', () => {
  it('parses renderer arguments before invoking a handler', async () => {
    const handler = vi.fn(() => ({
      ok: true as const,
      data: { opened: true as const, page: 'settings' }
    }));

    await expect(
      executeIpcRequest('roc:app:open-main-page', {}, [42], handler)
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' }
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects main-process-only authorization fields before invoking a handler', async () => {
    const handler = vi.fn(() => {
      throw new Error('handler_should_not_run');
    });

    await expect(
      executeIpcRequest('roc:chat:start-run', {}, [{
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        },
        input: 'hello',
        mode: 'chat',
        shellAllowedCommands: ['Remove-Item secret.txt']
      }], handler)
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' }
    });
    await expect(
      executeIpcRequest('roc:shell:execute', {}, [{
        allowedCommands: ['dir'],
        command: 'dir',
        signal: {},
        source: 'terminal'
      }], handler)
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' }
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('parses successful handler data before returning it to renderer', async () => {
    const handler = vi.fn(() => ({
      ok: true as const,
      data: { opened: true, page: 42 }
    }));

    await expect(
      executeIpcRequest('roc:app:open-main-page', {}, ['settings'], handler)
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' }
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('returns a valid request result after both boundary checks', async () => {
    const handler = vi.fn(() => ({
      ok: true as const,
      data: { opened: true as const, page: 'settings' }
    }));

    await expect(
      executeIpcRequest('roc:app:open-main-page', {}, ['settings'], handler)
    ).resolves.toEqual({
      ok: true,
      data: { opened: true, page: 'settings' }
    });
  });

  it('does not parse error results as success payloads', async () => {
    const result = {
      ok: false as const,
      error: {
        code: 'open_failed',
        message: 'Open failed.',
        category: 'internal' as const,
        retryable: false
      }
    };

    await expect(
      executeIpcRequest('roc:app:open-main-page', {}, ['settings'], () => result)
    ).resolves.toEqual(result);
  });

  it('rejects malformed error results at the controlled boundary', async () => {
    const malformedResult = {
      ok: false as const,
      error: {
        code: 'open_failed'
      }
    };

    await expect(
      executeIpcRequest(
        'roc:app:open-main-page',
        {},
        ['settings'],
        () => malformedResult as never
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' }
    });
  });
});
