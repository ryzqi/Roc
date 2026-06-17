import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { CommandRewriter, RTKBinaryManager, createRTKMiddleware } from '../../src/rtk-integration';

const execFileAsync = promisify(execFile);

describe('RTK integration', () => {
  it('bundles the expected RTK Windows release', async () => {
    const manager = new RTKBinaryManager();
    const binaryPath = manager.getRTKBinaryPath();
    if (binaryPath === null || !manager.isRTKAvailable()) {
      throw new Error('Expected bundled RTK binary to be available for current platform.');
    }

    const { stdout } = await execFileAsync(binaryPath, ['--version'], { windowsHide: true });

    expect(stdout.trim()).toBe('rtk 0.42.4');
  });

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
          name: 'run_shell_command',
          args: { command: 'htop' }
        }
      } as never,
      handler
    );

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).content).toBe('ok');
  });
});
