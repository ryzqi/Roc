import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { createRocShellPathPolicyMiddleware } from '../../../../src/main/services/deep-agent/shell-path-policy';

describe('createRocShellPathPolicyMiddleware', () => {
  it('returns an error ToolMessage before run_shell_command reaches the handler when command uses /workspace', async () => {
    const middleware = createRocShellPathPolicyMiddleware({
      workspacePath: 'F:\\Code\\Roc'
    });
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-1',
      name: 'run_shell_command',
      content: 'handler reached'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-1',
          name: 'run_shell_command',
          args: {
            command: 'python /workspace/scripts/probe.py'
          }
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(ToolMessage);
    expect(result).toMatchObject({
      tool_call_id: 'call-1',
      name: 'run_shell_command',
      status: 'error',
      content: 'run_shell_command 使用真实 Windows cwd，不接受 DeepAgents 文件工具路由 /workspace/...。请改用默认 cwd 下的相对路径，或真实 Windows 路径。默认 cwd: F:\\Code\\Roc'
    });
  });

  it.each([
    'python .\\main.py --input:/workspace/gold_price_scheduler/main.py',
    'Get-Content -Path:/workspace/gold_price_scheduler/main.py'
  ])('returns an error ToolMessage when command uses colon-delimited /workspace path: %s', async (command) => {
    const middleware = createRocShellPathPolicyMiddleware({
      workspacePath: 'G:\\杂\\test搜索调研方案'
    });
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-colon',
      name: 'run_shell_command',
      content: 'handler reached'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-colon',
          name: 'run_shell_command',
          args: { command }
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      tool_call_id: 'call-colon',
      name: 'run_shell_command',
      status: 'error',
      content: 'run_shell_command 使用真实 Windows cwd，不接受 DeepAgents 文件工具路由 /workspace/...。请改用默认 cwd 下的相对路径，或真实 Windows 路径。默认 cwd: G:\\杂\\test搜索调研方案'
    });
  });

  it('does not reject a real Windows path containing a workspace segment', async () => {
    const middleware = createRocShellPathPolicyMiddleware({
      workspacePath: 'F:\\Code\\Roc'
    });
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-windows',
      name: 'run_shell_command',
      content: 'ok'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-windows',
          name: 'run_shell_command',
          args: {
            command: 'python C:/workspace/scripts/probe.py'
          }
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      tool_call_id: 'call-windows',
      name: 'run_shell_command',
      content: 'ok'
    });
  });

  it('returns an error ToolMessage before run_shell_command reaches the handler when cwd uses /workspace', async () => {
    const middleware = createRocShellPathPolicyMiddleware();
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-2',
      name: 'run_shell_command',
      content: 'handler reached'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-2',
          name: 'run_shell_command',
          args: {
            command: 'python .\\scripts\\probe.py',
            cwd: '/workspace/scripts'
          }
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      tool_call_id: 'call-2',
      name: 'run_shell_command',
      status: 'error',
      content: 'run_shell_command 使用真实 Windows cwd，不接受 DeepAgents 文件工具路由 /workspace/...。请改用默认 cwd 下的相对路径，或真实 Windows 路径。默认 cwd: selected workspace root'
    });
  });

  it('passes Windows shell commands through to the handler', async () => {
    const middleware = createRocShellPathPolicyMiddleware({
      workspacePath: 'F:\\Code\\Roc'
    });
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-3',
      name: 'run_shell_command',
      content: 'ok'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-3',
          name: 'run_shell_command',
          args: {
            command: 'python .\\scripts\\probe.py',
            cwd: 'F:\\Code\\Roc'
          }
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      tool_call_id: 'call-3',
      name: 'run_shell_command',
      content: 'ok'
    });
  });

  it('ignores DeepAgents filesystem tools', async () => {
    const middleware = createRocShellPathPolicyMiddleware();
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-4',
      name: 'read_file',
      content: 'ok'
    }));

    await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-4',
          name: 'read_file',
          args: {
            file_path: '/workspace/package.json'
          }
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
