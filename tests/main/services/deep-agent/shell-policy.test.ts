import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';

import {
  createRocShellPolicyMiddleware,
  evaluateShellPolicy,
  parseShellAllowedCommands,
  ROC_SHELL_TOOL_DESCRIPTION_LINES
} from '../../../../src/main/services/deep-agent/shell-policy';

describe('shell policy', () => {
  it('exports the canonical shell tool guidance used by the tool and workspace prompt', () => {
    expect(ROC_SHELL_TOOL_DESCRIPTION_LINES).toEqual([
      '在当前 Roc Windows 工作区执行 PowerShell 命令。',
      '默认 cwd 是用户选择的真实 Windows 工作区。',
      '禁止在 command 或 cwd 中使用 /workspace 或 /workspace/...；/workspace 只属于 DeepAgents 文件工具。',
      '禁止使用 /home/user、/tmp 等 Linux 本地路径。',
      '引用工作区文件时用相对路径，或用真实 Windows 路径，例如 F:\\Code\\Roc\\script.ps1。',
      '适合运行测试、构建、脚本和本地命令。'
    ]);
  });

  it.each([
    'python /workspace/scripts/probe.py',
    'python .\\main.py --input=/workspace/project/main.py',
    'Get-Content -Path:/workspace/project/main.py'
  ])('denies DeepAgents virtual workspace paths with one message: %s', (command) => {
    expect(evaluateShellPolicy({ command, cwd: 'F:\\Code\\Roc', defaultCwd: 'F:\\Code\\Roc' })).toEqual({
      verdict: 'deny',
      reason: 'virtual_workspace_path',
      message:
        'run_shell_command 使用真实 Windows cwd，不接受 DeepAgents 文件工具路由 /workspace/...。请改用默认 cwd 下的相对路径，或真实 Windows 路径。默认 cwd: F:\\Code\\Roc'
    });
  });

  it.each(['python /home/user/project/main.py', 'Get-Content /tmp/output.txt'])(
    'denies Linux local paths with one message: %s',
    (command) => {
      expect(evaluateShellPolicy({ command, cwd: 'F:\\Code\\Roc', defaultCwd: 'F:\\Code\\Roc' })).toEqual({
        verdict: 'deny',
        reason: 'linux_local_path',
        message:
          'run_shell_command 在 Windows 本地执行，不接受 Linux 本地路径。请改用默认 cwd 下的相对路径，或真实 Windows 路径。默认 cwd: F:\\Code\\Roc'
      });
    }
  );

  it('allows relative and real Windows paths, including a Windows workspace segment', () => {
    expect(
      evaluateShellPolicy({
        command: 'python C:/workspace/scripts/probe.py',
        cwd: 'F:\\Code\\Roc',
        defaultCwd: 'F:\\Code\\Roc'
      })
    ).toEqual({ verdict: 'allow' });
  });

  it('applies the same path rules to cwd', () => {
    expect(
      evaluateShellPolicy({ command: 'git status', cwd: '/tmp/project', defaultCwd: 'F:\\Code\\Roc' })
    ).toMatchObject({ verdict: 'deny', reason: 'linux_local_path' });
  });

  it('uses normalized exact matching for durable command authorization', () => {
    expect(
      evaluateShellPolicy({
        command: ' GIT   STATUS ',
        cwd: 'F:\\Code\\Roc',
        defaultCwd: 'F:\\Code\\Roc',
        allowedCommands: ['git status']
      })
    ).toEqual({ verdict: 'allow' });
    expect(
      evaluateShellPolicy({
        command: 'git status --short',
        cwd: 'F:\\Code\\Roc',
        defaultCwd: 'F:\\Code\\Roc',
        allowedCommands: ['git status']
      })
    ).toMatchObject({ verdict: 'deny', reason: 'shell_run_not_authorized' });
    expect(
      evaluateShellPolicy({
        command: 'git status',
        cwd: 'F:\\Code\\Roc',
        defaultCwd: 'F:\\Code\\Roc',
        allowedCommands: []
      })
    ).toMatchObject({ verdict: 'deny', reason: 'background_shell_command_not_pre_authorized' });
  });

  it('parses allowed commands once and enforces their source contract', () => {
    expect(
      parseShellAllowedCommands({
        commands: [' git status ', 'git status', 'pnpm test'],
        mode: 'task',
        taskSource: 'background_schedule'
      })
    ).toEqual(['git status', 'pnpm test']);
    expect(
      parseShellAllowedCommands({ commands: undefined, mode: 'task', taskSource: 'background_schedule' })
    ).toEqual([]);
    expect(() =>
      parseShellAllowedCommands({ commands: ['git status'], mode: 'chat', taskSource: null })
    ).toThrow('agent_shell_preauthorization_source_invalid');
    expect(() =>
      parseShellAllowedCommands({ commands: ['  '], mode: 'task', taskSource: 'workbench' })
    ).toThrow('agent_shell_preauthorization_command_empty');
  });

  it('denies a shell tool call before the middleware handler', async () => {
    const middleware = createRocShellPolicyMiddleware({ workspacePath: 'F:\\Code\\Roc' });
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-shell',
      name: 'run_shell_command',
      content: 'handler reached'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-shell',
          name: 'run_shell_command',
          args: { command: 'python /workspace/scripts/probe.py' }
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'error',
      content:
        'run_shell_command 使用真实 Windows cwd，不接受 DeepAgents 文件工具路由 /workspace/...。请改用默认 cwd 下的相对路径，或真实 Windows 路径。默认 cwd: F:\\Code\\Roc'
    });
  });
});
