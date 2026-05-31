import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { createRTKMiddleware } from '../../src/rtk-integration/middleware';

function createAvailableManager() {
  return {
    getRTKBinaryPath: () => 'F:\\Code\\Roc\\resources\\rtk-binaries\\win32-x64\\rtk.exe',
    isRTKAvailable: () => true
  };
}

function createUnavailableManager() {
  return {
    getRTKBinaryPath: () => null,
    isRTKAvailable: () => false
  };
}

describe('createRTKMiddleware', () => {
  it('rewrites execute tool commands before invoking the handler', async () => {
    const rewrite = vi.fn().mockResolvedValue({
      rewritten: 'rtk git status',
      rtkArgs: ['git', 'status'],
      exitCode: 3
    });
    const middleware = createRTKMiddleware(createAvailableManager() as never, {
      createRewriter: () => ({ rewrite })
    });
    const handler = vi.fn().mockResolvedValue(new ToolMessage({
      content: 'ok',
      tool_call_id: 'call-execute'
    }));

    await middleware.wrapToolCall?.(
      {
        toolCall: {
          id: 'call-execute',
          name: 'execute',
          args: { command: 'git status' }
        }
      } as never,
      handler
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({
          args: { command: 'rtk git status' }
        })
      })
    );
  });

  it('passes through non-shell tools unchanged', async () => {
    const middleware = createRTKMiddleware(createAvailableManager() as never, {
      createRewriter: () => ({
        rewrite: vi.fn()
      })
    });
    const request = {
      toolCall: {
        id: 'call-read',
        name: 'read_file',
        args: { path: 'notes.md' }
      }
    };
    const handler = vi.fn().mockResolvedValue(new ToolMessage({
      content: 'file',
      tool_call_id: 'call-read'
    }));

    await middleware.wrapToolCall?.(request as never, handler);

    expect(handler).toHaveBeenCalledWith(request);
  });

  it('passes through shell tools when RTK is unavailable', async () => {
    const request = {
      toolCall: {
        id: 'call-execute',
        name: 'execute',
        args: { command: 'git status' }
      }
    };
    const middleware = createRTKMiddleware(createUnavailableManager() as never);
    const handler = vi.fn().mockResolvedValue(new ToolMessage({
      content: 'ok',
      tool_call_id: 'call-execute'
    }));

    await middleware.wrapToolCall?.(request as never, handler);

    expect(handler).toHaveBeenCalledWith(request);
  });

  it('blocks commands denied by RTK', async () => {
    const middleware = createRTKMiddleware(createAvailableManager() as never, {
      createRewriter: () => ({
        rewrite: vi.fn().mockResolvedValue({
          rewritten: null,
          rtkArgs: null,
          exitCode: 2
        })
      })
    });

    const result = await middleware.wrapToolCall?.(
      {
        toolCall: {
          id: 'call-execute',
          name: 'execute',
          args: { command: 'rm -rf .' }
        }
      } as never,
      vi.fn()
    );

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).content).toContain('RTK denied command');
  });
});
