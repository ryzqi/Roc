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

  it('rewrites string tool arguments', async () => {
    const middleware = createRTKMiddleware(createAvailableManager() as never, {
      createRewriter: () => ({
        rewrite: vi.fn().mockResolvedValue({
          rewritten: 'rtk ls',
          rtkArgs: ['ls'],
          exitCode: 0
        })
      })
    });
    const handler = vi.fn().mockResolvedValue(new ToolMessage({
      content: 'ok',
      tool_call_id: 'call-shell'
    }));

    await middleware.wrapToolCall?.(
      {
        toolCall: {
          id: 'call-shell',
          name: 'shell',
          args: 'ls'
        }
      } as never,
      handler
    );

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      toolCall: expect.objectContaining({
        args: 'rtk ls'
      })
    }));
  });

  it('rewrites cmd and input tool arguments', async () => {
    const createRewriter = () => ({
      rewrite: vi.fn().mockResolvedValue({
        rewritten: 'rtk git diff',
        rtkArgs: ['git', 'diff'],
        exitCode: 0
      })
    });

    for (const key of ['cmd', 'input'] as const) {
      const middleware = createRTKMiddleware(createAvailableManager() as never, { createRewriter });
      const handler = vi.fn().mockResolvedValue(new ToolMessage({
        content: 'ok',
        tool_call_id: `call-${key}`
      }));

      await middleware.wrapToolCall?.(
        {
          toolCall: {
            id: `call-${key}`,
            name: 'terminal',
            args: { [key]: 'git diff' }
          }
        } as never,
        handler
      );

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        toolCall: expect.objectContaining({
          args: { [key]: 'rtk git diff' }
        })
      }));
    }
  });

  it('falls back when command extraction or rewritten execution fails', async () => {
    const middleware = createRTKMiddleware(createAvailableManager() as never, {
      createRewriter: () => ({
        rewrite: vi.fn().mockResolvedValue({
          rewritten: 'rtk git status',
          rtkArgs: ['git', 'status'],
          exitCode: 0
        })
      })
    });
    const missingCommandRequest = {
      toolCall: {
        id: 'call-empty',
        name: 'execute',
        args: { path: 'notes.md' }
      }
    };
    const handler = vi.fn()
      .mockResolvedValueOnce(new ToolMessage({ content: 'missing command', tool_call_id: 'call-empty' }))
      .mockRejectedValueOnce(new Error('rewritten failed'))
      .mockResolvedValueOnce(new ToolMessage({ content: 'fallback', tool_call_id: 'call-execute' }));

    const missingCommand = await middleware.wrapToolCall?.(missingCommandRequest as never, handler);
    const fallback = await middleware.wrapToolCall?.(
      {
        toolCall: {
          id: 'call-execute',
          name: 'execute',
          args: { command: 'git status' }
        }
      } as never,
      handler
    );

    expect((missingCommand as ToolMessage).content).toBe('missing command');
    expect((fallback as ToolMessage).content).toBe('fallback');
  });

  it('throws rewrite and handler errors when fallback is disabled', async () => {
    const rewriteFailure = createRTKMiddleware(createAvailableManager() as never, {
      fallbackOnError: false,
      createRewriter: () => ({
        rewrite: vi.fn().mockRejectedValue(new Error('rewrite failed'))
      })
    });

    await expect(rewriteFailure.wrapToolCall?.(
      {
        toolCall: {
          id: 'call-execute',
          name: 'execute',
          args: { command: 'git status' }
        }
      } as never,
      vi.fn()
    )).rejects.toThrow('rewrite failed');

    const handlerFailure = createRTKMiddleware(createAvailableManager() as never, {
      fallbackOnError: false,
      createRewriter: () => ({
        rewrite: vi.fn().mockResolvedValue({
          rewritten: 'rtk git status',
          rtkArgs: ['git', 'status'],
          exitCode: 0
        })
      })
    });

    await expect(handlerFailure.wrapToolCall?.(
      {
        toolCall: {
          id: 'call-execute',
          name: 'execute',
          args: null
        }
      } as never,
      vi.fn().mockRejectedValue(new Error('handler failed'))
    )).rejects.toThrow('handler failed');
  });
});
