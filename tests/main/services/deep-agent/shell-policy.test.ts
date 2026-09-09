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
      '在当前 Roc macOS 工作区执行 zsh 命令。',
      '默认 cwd 是用户选择的真实本机工作区。',
      '禁止在 command 或 cwd 中使用 /workspace 或 /workspace/...；/workspace 只属于 DeepAgents 文件工具。',
      '禁止用 shell 做文件操作(cat/echo/mkdir/ls/rm/cp/mv/重定向)；文件读写用专用文件工具。',
      '引用工作区文件时用相对路径，或用当前系统的真实绝对路径。',
      '适合运行测试、构建、编译、脚本执行和进程类命令。'
    ]);
  });

  it.each([
    'python /workspace/scripts/probe.py',
    'python ./main.py --input=/workspace/project/main.py',
    'node script.js --path:/workspace/project/main.py'
  ])('denies DeepAgents virtual workspace paths with one message: %s', (command) => {
    expect(evaluateShellPolicy({ command, cwd: '/Users/test/Projects/Roc', defaultCwd: '/Users/test/Projects/Roc' })).toEqual({
      verdict: 'deny',
      reason: 'virtual_workspace_path',
      message:
        'run_shell_command 使用真实本机 cwd，不接受 DeepAgents 文件工具路由 /workspace/...。请改用默认 cwd 下的相对路径，或真实本机路径。默认 cwd: /Users/test/Projects/Roc'
    });
  });

  it('allows real macOS paths containing a workspace directory', () => {
    expect(
      evaluateShellPolicy({
        command: 'python /Users/test/workspace/scripts/probe.py',
        cwd: '/Users/test/Projects/Roc',
        defaultCwd: '/Users/test/Projects/Roc'
      })
    ).toEqual({ verdict: 'allow' });
  });

  it('applies the same path rules to cwd', () => {
    expect(
      evaluateShellPolicy({ command: 'git status', cwd: '/workspace/project', defaultCwd: '/Users/test/Roc' })
    ).toMatchObject({ verdict: 'deny', reason: 'virtual_workspace_path' });
  });

  it('uses normalized exact matching for durable command authorization', () => {
    expect(
      evaluateShellPolicy({
        command: ' git status ',
        cwd: '/Users/test/Projects/Roc',
        defaultCwd: '/Users/test/Projects/Roc',
        allowedCommands: ['git status']
      })
    ).toEqual({ verdict: 'allow' });
    expect(
      evaluateShellPolicy({
        command: 'git status --short',
        cwd: '/Users/test/Projects/Roc',
        defaultCwd: '/Users/test/Projects/Roc',
        allowedCommands: ['git status']
      })
    ).toMatchObject({ verdict: 'deny', reason: 'shell_run_not_authorized' });
    expect(
      evaluateShellPolicy({
        command: 'git status',
        cwd: '/Users/test/Projects/Roc',
        defaultCwd: '/Users/test/Projects/Roc',
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
    const middleware = createRocShellPolicyMiddleware({ workspacePath: '/Users/test/Projects/Roc' });
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
        'run_shell_command 使用真实本机 cwd，不接受 DeepAgents 文件工具路由 /workspace/...。请改用默认 cwd 下的相对路径，或真实本机路径。默认 cwd: /Users/test/Projects/Roc'
    });
  });

  it('accepts temporary macOS paths while retaining file and authorization guards', () => {
    expect(evaluateShellPolicy({ command: 'node /tmp/project/script.js', cwd: '/tmp/project' })).toEqual({ verdict: 'allow' });
    expect(evaluateShellPolicy({ command: 'node /workspace/script.js' })).toMatchObject({ reason: 'virtual_workspace_path' });
    expect(evaluateShellPolicy({ command: 'rm /tmp/file.txt' })).toMatchObject({ reason: 'shell_file_operation_forbidden' });
    expect(evaluateShellPolicy({ command: 'node /tmp/script.js', allowedCommands: [] })).toMatchObject({ reason: 'background_shell_command_not_pre_authorized' });
  });

  it.each(['node Build.js', 'node "a  b.js"'])(
    'preserves case and quoted whitespace during authorization: %s', (command) => {
      expect(evaluateShellPolicy({ command, allowedCommands: ['node build.js', 'node "a b.js"'] })).toMatchObject({
        verdict: 'deny', reason: 'shell_run_not_authorized'
      });
    }
  );

  it('does not interpret lowercase environment names as uppercase variables', () => {
    expect(evaluateShellPolicy({ command: 'printenv Path', allowedCommands: ['printenv PATH'] })).toMatchObject({ verdict: 'deny' });
  });

  describe('file operation command blocking', () => {
    it.each([
      'cat file.txt',
      'echo "test" > output.txt',
      'printf "test" > \\output.txt',
      'ls .',
      'touch test.txt',
      'rm old.txt',
      'mkdir newdir',
      'cp old.json new.json',
      'mv file.json target.json',
    ])('denies file operation commands: %s', (command) => {
      expect(evaluateShellPolicy({ command, defaultCwd: '/Users/test/Projects/Roc' })).toMatchObject({
        verdict: 'deny',
        reason: 'shell_file_operation_forbidden'
      });
    });

    it.each([
      'pnpm test',
      'git status',
      'git status && git diff',
      'python script.py',
      'node index.js',
      'cargo build',
      'dotnet run',
      'pnpm test --filter="version>1.0"',
      'cargo test -- --test-threads>1'
    ])('allows execution commands: %s', (command) => {
      expect(evaluateShellPolicy({ command, defaultCwd: '/Users/test/Projects/Roc' })).toEqual({
        verdict: 'allow'
      });
    });
  });
});
