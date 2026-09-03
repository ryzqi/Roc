import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

const linuxLocalPathPattern = /(?:^|[\s"'`=({\[;&|,])\/(?:home\/user|tmp)(?=\/|$)/i;
const RUN_SHELL_COMMAND_TOOL_NAME = 'run_shell_command';
const SELECTED_WORKSPACE_ROOT = 'selected workspace root';
const VIRTUAL_WORKSPACE_ROUTE = '/workspace';
const VIRTUAL_WORKSPACE_DELIMITERS = new Set([' ', '\t', '\r', '\n', '"', '\'', '`', '=', '(', '{', '[', ';', '&', '|', ',']);

export const ROC_SHELL_COMMAND_SCHEMA_DESCRIPTION =
  'PowerShell command. Must not contain /workspace, /workspace/... or Linux local paths.';
export const ROC_SHELL_CWD_SCHEMA_DESCRIPTION =
  'Optional real Windows cwd. Omit to use the selected Roc workspace root.';
export const ROC_SHELL_TOOL_DESCRIPTION_LINES = [
  '在当前 Roc Windows 工作区执行 PowerShell 命令。',
  '默认 cwd 是用户选择的真实 Windows 工作区。',
  '禁止在 command 或 cwd 中使用 /workspace 或 /workspace/...；/workspace 只属于 DeepAgents 文件工具。',
  '禁止使用 /home/user、/tmp 等 Linux 本地路径。',
  '禁止用 shell 做文件操作(cat/type/Get-Content/echo/Out-File/Set-Content/New-Item/mkdir/ls/dir/rm/del/重定向)；文件读写用专用文件工具。',
  '引用工作区文件时用相对路径，或用真实 Windows 路径，例如 F:\\Code\\Roc\\script.ps1。',
  '适合运行测试、构建、编译、脚本执行和进程类命令。'
] as const;
export const ROC_SHELL_TOOL_DESCRIPTION = ROC_SHELL_TOOL_DESCRIPTION_LINES.join('\n');

export type ShellPolicyReason =
  | 'virtual_workspace_path'
  | 'linux_local_path'
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
  return command.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
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
        'run_shell_command 使用真实 Windows cwd，不接受 DeepAgents 文件工具路由 /workspace/...。',
        defaultCwd
      )
    };
  }
  if (linuxLocalPathPattern.test(value)) {
    return {
      verdict: 'deny',
      reason: 'linux_local_path',
      message: buildPathError('run_shell_command 在 Windows 本地执行，不接受 Linux 本地路径。', defaultCwd)
    };
  }
  return { verdict: 'allow' };
}

function buildPathError(reason: string, defaultCwd: string): string {
  return `${reason}请改用默认 cwd 下的相对路径，或真实 Windows 路径。默认 cwd: ${defaultCwd}`;
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
    return !isWindowsDrivePrefix(value, index);
  }
  return previous !== undefined && VIRTUAL_WORKSPACE_DELIMITERS.has(previous);
}

function isWindowsDrivePrefix(value: string, workspaceRouteIndex: number): boolean {
  const driveLetterIndex = workspaceRouteIndex - 2;
  if (driveLetterIndex < 0) {
    return false;
  }
  const driveLetter = value[driveLetterIndex];
  if (driveLetter === undefined || !/^[A-Za-z]$/.test(driveLetter)) {
    return false;
  }
  if (driveLetterIndex === 0) {
    return true;
  }
  const beforeDriveLetter = value[driveLetterIndex - 1];
  return beforeDriveLetter !== undefined && VIRTUAL_WORKSPACE_DELIMITERS.has(beforeDriveLetter);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function evaluateFileOperationCommand(command: string): ShellPolicyVerdict {
  const FILE_OPERATION_PATTERNS = [
    /\b(cat|type|Get-Content)\b/i,
    /\b(echo|Out-File|Set-Content|Add-Content)\b/i,
    /\s+[>&]+\s*[\w\.\-\/\\]/,
    /\b(New-Item|ni)\b/i,
    /\b(ls|dir|Get-ChildItem|gci)\b/i,
    /\b(rm|del|Remove-Item|ri)\b/i,
    /\b(mkdir|md)\b/i,
    /\b(copy|cp|Copy-Item)\b/i,
    /\b(move|mv|Move-Item)\b/i,
    /\b(ren|rename|Rename-Item)\b/i
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
