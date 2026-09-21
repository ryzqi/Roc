import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

const RUN_SHELL_COMMAND_TOOL_NAME = 'run_shell_command';
const SELECTED_WORKSPACE_ROOT = 'selected workspace root';
const VIRTUAL_WORKSPACE_ROUTE = '/workspace';
const VIRTUAL_WORKSPACE_DELIMITERS = new Set([' ', '\t', '\r', '\n', '"', '\'', '`', '=', '(', '{', '[', ';', '&', '|', ',']);

export const ROC_SHELL_COMMAND_SCHEMA_DESCRIPTION =
  'macOS zsh command. Must not contain the virtual /workspace or /workspace/... routes.';
export const ROC_SHELL_CWD_SCHEMA_DESCRIPTION =
  'Optional real host cwd. Omit to use the selected Roc workspace root.';
export const ROC_SHELL_TOOL_DESCRIPTION_LINES = [
  '在当前 Roc macOS 工作区执行 zsh 命令。',
  '默认 cwd 是用户选择的真实本机工作区。',
  '禁止在 command 或 cwd 中使用 /workspace 或 /workspace/...；/workspace 只属于 DeepAgents 文件工具。',
  '禁止用 shell 做文件操作(cat/echo/mkdir/ls/rm/cp/mv/重定向)；文件读写用专用文件工具。',
  '引用工作区文件时用相对路径，或用当前系统的真实绝对路径。',
  '适合运行测试、构建、编译、脚本执行和进程类命令。'
] as const;
export const ROC_SHELL_TOOL_DESCRIPTION = ROC_SHELL_TOOL_DESCRIPTION_LINES.join('\n');

export type ShellPolicyReason =
  | 'virtual_workspace_path'
  | 'shell_file_operation_forbidden'
  | 'shell_run_not_authorized'
  | 'background_shell_command_not_pre_authorized';

export type ShellPolicyVerdict =
  | { verdict: 'allow' }
  | { verdict: 'deny'; reason: ShellPolicyReason; message: string };

export type ShellAllowedCommandConfig = {
  commands?: readonly string[];
  mode: 'chat' | 'plan' | 'task';
  taskSource: 'background_schedule' | 'workbench' | null;
};

type ShellPolicyInput = {
  command: string;
  cwd?: string | null;
  defaultCwd?: string | null;
  allowedCommands?: readonly string[];
};

type ShellPolicyMiddlewareOptions = {
  workspacePath?: string | null;
};

type ToolCallRequest = {
  toolCall: {
    args?: unknown;
    id?: string;
    name: string;
  };
};

export function evaluateShellPolicy(input: ShellPolicyInput): ShellPolicyVerdict {
  const defaultCwd = input.defaultCwd ?? SELECTED_WORKSPACE_ROOT;
  const commandPathVerdict = evaluateHostPath(input.command, defaultCwd);
  if (commandPathVerdict.verdict === 'deny') {
    return commandPathVerdict;
  }
  if (input.cwd !== undefined && input.cwd !== null) {
    const cwdPathVerdict = evaluateHostPath(input.cwd, defaultCwd);
    if (cwdPathVerdict.verdict === 'deny') {
      return cwdPathVerdict;
    }
  }
  const fileOpVerdict = evaluateFileOperationCommand(input.command);
  if (fileOpVerdict.verdict === 'deny') {
    return fileOpVerdict;
  }
  if (input.allowedCommands === undefined) {
    return { verdict: 'allow' };
  }
  const normalizedCommand = normalizeShellCommand(input.command);
  if (input.allowedCommands.some((allowed) => normalizeShellCommand(allowed) === normalizedCommand)) {
    return { verdict: 'allow' };
  }
  const noPreauthorization = input.allowedCommands.length === 0;
  return {
    verdict: 'deny',
    reason: noPreauthorization ? 'background_shell_command_not_pre_authorized' : 'shell_run_not_authorized',
    message: noPreauthorization
      ? 'Error: this background shell command is not durably pre-authorized.'
      : 'Error: this shell command is not durably pre-authorized.'
  };
}

export function parseShellAllowedCommands(input: ShellAllowedCommandConfig): string[] | undefined {
  if (input.commands === undefined) {
    return input.taskSource === 'background_schedule' ? [] : undefined;
  }
  if (input.mode !== 'task' || (input.taskSource !== 'background_schedule' && input.taskSource !== 'workbench')) {
    throw new Error('agent_shell_preauthorization_source_invalid');
  }
  const commands: string[] = [];
  const seen = new Set<string>();
  for (const command of input.commands) {
    const value = command.trim();
    if (value.length === 0) {
      throw new Error('agent_shell_preauthorization_command_empty');
    }
    if (!seen.has(value)) {
      seen.add(value);
      commands.push(value);
    }
  }
  return commands;
}

export function normalizeShellCommand(command: string): string {
  return command.trim();
}

export function createRocShellPolicyMiddleware(options: ShellPolicyMiddlewareOptions = {}) {
  return createMiddleware({
    name: 'RocShellPolicyMiddleware',
    wrapToolCall: async (request, handler) => {
      const verdict = evaluateShellToolCall(
        request,
        options.workspacePath === undefined ? null : options.workspacePath
      );
      if (verdict.verdict === 'allow') {
        return await handler(request);
      }
      return new ToolMessage({
        tool_call_id: request.toolCall.id === undefined ? 'unknown-tool-call' : request.toolCall.id,
        name: request.toolCall.name,
        content: verdict.message,
        status: 'error'
      });
    }
  });
}

function evaluateShellToolCall(request: ToolCallRequest, workspacePath: string | null): ShellPolicyVerdict {
  if (request.toolCall.name !== RUN_SHELL_COMMAND_TOOL_NAME || !isRecord(request.toolCall.args)) {
    return { verdict: 'allow' };
  }
  const command = request.toolCall.args.command;
  if (typeof command !== 'string') {
    return { verdict: 'allow' };
  }
  const cwd = request.toolCall.args.cwd;
  return evaluateShellPolicy({
    command,
    cwd: typeof cwd === 'string' ? cwd : null,
    defaultCwd: workspacePath
  });
}

function evaluateHostPath(value: string, defaultCwd: string): ShellPolicyVerdict {
  if (containsVirtualWorkspacePath(value)) {
    return {
      verdict: 'deny',
      reason: 'virtual_workspace_path',
      message: buildPathError(
        'run_shell_command 使用真实本机 cwd，不接受 DeepAgents 文件工具路由 /workspace/...。',
        defaultCwd
      )
    };
  }
  return { verdict: 'allow' };
}

function buildPathError(reason: string, defaultCwd: string): string {
  return `${reason}请改用默认 cwd 下的相对路径，或真实本机路径。默认 cwd: ${defaultCwd}`;
}

function containsVirtualWorkspacePath(value: string): boolean {
  const lowerValue = value.toLowerCase();
  let index = lowerValue.indexOf(VIRTUAL_WORKSPACE_ROUTE);
  while (index !== -1) {
    if (hasVirtualWorkspaceRouteBoundary(value, index)) {
      return true;
    }
    index = lowerValue.indexOf(VIRTUAL_WORKSPACE_ROUTE, index + VIRTUAL_WORKSPACE_ROUTE.length);
  }
  return false;
}

function hasVirtualWorkspaceRouteBoundary(value: string, index: number): boolean {
  const next = value[index + VIRTUAL_WORKSPACE_ROUTE.length];
  if (next !== undefined && next !== '/') {
    return false;
  }
  if (index === 0) {
    return true;
  }
  const previous = value[index - 1];
  if (previous === ':') {
    return true;
  }
  return previous !== undefined && VIRTUAL_WORKSPACE_DELIMITERS.has(previous);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function evaluateFileOperationCommand(command: string): ShellPolicyVerdict {
  const FILE_OPERATION_PATTERNS = [
    /\bcat\b/,
    /\becho\b/,
    /\s+(?:>{1,2}&?|&>)\s*[\w.\-\/]/,
    /\b(touch|ls|rm|mkdir|cp|mv)\b/
  ];

  if (FILE_OPERATION_PATTERNS.some(pattern => pattern.test(command))) {
    return {
      verdict: 'deny',
      reason: 'shell_file_operation_forbidden',
      message: 'run_shell_command 禁止文件操作。文件读写使用 read_file / write_file / edit_file / delete_file；目录列表使用 ls 工具。'
    };
  }

  return { verdict: 'allow' };
}
