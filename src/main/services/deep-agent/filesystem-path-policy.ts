import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

const FILESYSTEM_TOOL_PATH_FIELDS = {
  ls: 'path',
  read_file: 'file_path',
  write_file: 'file_path',
  edit_file: 'file_path',
  glob: 'path',
  grep: 'path'
} as const;

const ROUTE_ERROR = 'Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。';
const WINDOWS_PATH_ERROR = 'Roc 文件工具使用虚拟路径；请改用 /workspace/...。';
const TRAVERSAL_ERROR = 'Roc 文件工具路径不能包含 .. 路径段。';
const ALLOWED_ROUTE_PREFIXES = ['/workspace', '/skills', '/memory'] as const;

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

export function createRocFilesystemPathPolicyMiddleware() {
  return createMiddleware({
    name: 'RocFilesystemPathPolicyMiddleware',
    wrapToolCall: async (request, handler) => {
      const validation = validateFilesystemToolCall(request);
      if (validation.ok) {
        return await handler(request);
      }
      return new ToolMessage({
        tool_call_id: request.toolCall.id ?? 'unknown-tool-call',
        name: request.toolCall.name,
        content: validation.error,
        status: 'error'
      });
    }
  });
}

export function validateRocFileToolPath(path: string): PathValidationResult {
  if (containsTraversal(path)) {
    return { ok: false, error: TRAVERSAL_ERROR };
  }
  if (isWindowsAbsolutePath(path) || isUncPath(path)) {
    return { ok: false, error: WINDOWS_PATH_ERROR };
  }
  if (isAllowedRoutePath(path)) {
    return { ok: true };
  }
  return { ok: false, error: ROUTE_ERROR };
}

function validateFilesystemToolCall(request: ToolCallRequest): PathValidationResult {
  const pathField = FILESYSTEM_TOOL_PATH_FIELDS[request.toolCall.name as keyof typeof FILESYSTEM_TOOL_PATH_FIELDS];
  if (pathField === undefined) {
    return { ok: true };
  }
  if (!isRecord(request.toolCall.args)) {
    return { ok: true };
  }
  const path = request.toolCall.args[pathField];
  if (typeof path !== 'string') {
    return { ok: true };
  }
  return validateRocFileToolPath(path);
}

function isAllowedRoutePath(path: string): boolean {
  return ALLOWED_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function containsTraversal(path: string): boolean {
  return path.split('/').some((segment) => segment === '..');
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

function isUncPath(path: string): boolean {
  return path.startsWith('\\\\');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
