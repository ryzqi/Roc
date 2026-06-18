import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { containsLinuxLocalPath, containsVirtualWorkspacePath } from './shell-path-guard';

const RUN_SHELL_COMMAND_TOOL_NAME = 'run_shell_command';
const SELECTED_WORKSPACE_ROOT = 'selected workspace root';

type RocShellPathPolicyOptions = {
  workspacePath?: string | null;
};

type PathValidationResult =
  | { ok: true }
  | { ok: false; error: string };

type ToolCallRequest = {
  toolCall: {
    args?: unknown;
    id?: string;
    name: string;
  };
};

export function createRocShellPathPolicyMiddleware(options: RocShellPathPolicyOptions = {}) {
  return createMiddleware({
    name: 'RocShellPathPolicyMiddleware',
    wrapToolCall: async (request, handler) => {
      const validation = validateRocShellToolCall(
        request,
        options.workspacePath === undefined ? null : options.workspacePath
      );
      if (validation.ok) {
        return await handler(request);
      }
      return new ToolMessage({
        tool_call_id: request.toolCall.id === undefined ? 'unknown-tool-call' : request.toolCall.id,
        name: request.toolCall.name,
        content: validation.error,
        status: 'error'
      });
    }
  });
}

function validateRocShellToolCall(request: ToolCallRequest, workspacePath: string | null): PathValidationResult {
  if (request.toolCall.name !== RUN_SHELL_COMMAND_TOOL_NAME) {
    return { ok: true };
  }
  if (!isRecord(request.toolCall.args)) {
    return { ok: true };
  }

  const command = request.toolCall.args.command;
  if (typeof command === 'string') {
    const validation = validateRocWindowsShellValue(command, workspacePath);
    if (!validation.ok) {
      return validation;
    }
  }

  const cwd = request.toolCall.args.cwd;
  if (typeof cwd === 'string') {
    const validation = validateRocWindowsShellValue(cwd, workspacePath);
    if (!validation.ok) {
      return validation;
    }
  }

  return { ok: true };
}

function validateRocWindowsShellValue(value: string, workspacePath: string | null): PathValidationResult {
  if (containsVirtualWorkspacePath(value)) {
    return {
      ok: false,
      error: buildShellPathError(
        'run_shell_command 使用真实 Windows cwd，不接受 DeepAgents 文件工具路由 /workspace/...。',
        workspacePath
      )
    };
  }
  if (containsLinuxLocalPath(value)) {
    return {
      ok: false,
      error: buildShellPathError(
        'run_shell_command 在 Windows 本地执行，不接受 Linux 本地路径。',
        workspacePath
      )
    };
  }
  return { ok: true };
}

function buildShellPathError(reason: string, workspacePath: string | null): string {
  const defaultCwd = workspacePath === null ? SELECTED_WORKSPACE_ROOT : workspacePath;
  return `${reason}请改用默认 cwd 下的相对路径，或真实 Windows 路径。默认 cwd: ${defaultCwd}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
