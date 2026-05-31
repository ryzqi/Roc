import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { CommandRewriter, RTKBinaryManager, createRTKMiddleware } from '../../src/rtk-integration';

describe('RTK integration', () => {
  it('uses the bundled RTK binary to rewrite supported commands', async () => {
    const manager = new RTKBinaryManager();
    const binaryPath = manager.getRTKBinaryPath();
    if (binaryPath === null || !manager.isRTKAvailable()) {
      throw new Error('Expected bundled RTK binary to be available for current platform.');
    }

    const result = await new CommandRewriter(binaryPath).rewrite('git status');

    expect(result.rewritten).toBe('rtk git status');
    expect(result.rtkArgs).toEqual(['git', 'status']);
    expect([0, 3]).toContain(result.exitCode);
  });

  it('initializes middleware and passes through when no rewrite exists', async () => {
    const middleware = createRTKMiddleware(new RTKBinaryManager());
    const handler = async () =>
      new ToolMessage({
        content: 'ok',
        tool_call_id: 'call-execute'
      });

    const result = await middleware.wrapToolCall?.(
      {
        toolCall: {
          id: 'call-execute',
          name: 'execute',
          args: { command: 'htop' }
        }
      } as never,
      handler
    );

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).content).toBe('ok');
  });
});
