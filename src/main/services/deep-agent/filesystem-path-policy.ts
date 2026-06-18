import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { win32 } from 'node:path';

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
const WORKSPACE_ROUTE = '/workspace';

type RocFilesystemPathPolicyOptions = {
  workspacePath?: string | null;
};

type PathValidationResult =
  | { ok: true }
  | { ok: false; error: string };

type PathNormalizationResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

type ToolCallNormalizationResult<TRequest extends ToolCallRequest> =
  | { ok: true; path: string; request: TRequest }
  | { ok: false; error: string };

type ToolCallRequest = {
  toolCall: {
    args?: unknown;
    id?: string;
    name: string;
  };
};

export function createRocFilesystemPathPolicyMiddleware(options: RocFilesystemPathPolicyOptions = {}) {
  return createMiddleware({
    name: 'RocFilesystemPathPolicyMiddleware',
    wrapToolCall: async (request, handler) => {
      const validation = normalizeFilesystemToolCall(request, options.workspacePath);
      if (validation.ok) {
        return await handler(validation.request);
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
  const normalized = normalizeRocFileToolPath(path, null);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }
  return { ok: true };
}

export function normalizeRocFileToolPath(path: string, workspacePath: string | null): PathNormalizationResult {
  if (containsTraversal(path)) {
    return { ok: false, error: TRAVERSAL_ERROR };
  }
  if (isAllowedRoutePath(path)) {
    return { ok: true, path };
  }
  if (isWindowsAbsolutePath(path) || isUncPath(path)) {
    if (workspacePath === null) {
      return { ok: false, error: WINDOWS_PATH_ERROR };
    }
    const virtualPath = tryConvertWorkspacePath(path, workspacePath);
    if (virtualPath === null) {
      return { ok: false, error: WINDOWS_PATH_ERROR };
    }
    return { ok: true, path: virtualPath };
  }
  return { ok: false, error: ROUTE_ERROR };
}

function normalizeFilesystemToolCall<TRequest extends ToolCallRequest>(
  request: TRequest,
  workspacePath: string | null | undefined
): ToolCallNormalizationResult<TRequest> {
  const pathField = FILESYSTEM_TOOL_PATH_FIELDS[request.toolCall.name as keyof typeof FILESYSTEM_TOOL_PATH_FIELDS];
  if (pathField === undefined) {
    return { ok: true, path: '', request };
  }
  if (!isRecord(request.toolCall.args)) {
    return { ok: true, path: '', request };
  }
  const path = request.toolCall.args[pathField];
  if (typeof path !== 'string') {
    return { ok: true, path: '', request };
  }
  const normalized = normalizeRocFileToolPath(path, workspacePath === undefined ? null : workspacePath);
  if (!normalized.ok) {
    return normalized;
  }
  if (normalized.path === path) {
    return { ok: true, path, request };
  }
  return {
    ok: true,
    path: normalized.path,
    request: replaceToolCallPath(request, pathField, normalized.path)
  };
}

function replaceToolCallPath<TRequest extends ToolCallRequest>(request: TRequest, pathField: string, path: string): TRequest {
  if (!isRecord(request.toolCall.args)) {
    return request;
  }
  return {
    ...request,
    toolCall: {
      ...request.toolCall,
      args: {
        ...request.toolCall.args,
        [pathField]: path
      }
    }
  } as TRequest;
}

function isAllowedRoutePath(path: string): boolean {
  return ALLOWED_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function containsTraversal(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment === '..');
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

function isUncPath(path: string): boolean {
  return path.startsWith('\\\\');
}

function tryConvertWorkspacePath(path: string, workspacePath: string): string | null {
  const resolvedWorkspacePath = win32.resolve(workspacePath);
  const resolvedPath = win32.resolve(path);
  const relativePath = win32.relative(resolvedWorkspacePath, resolvedPath);
  if (relativePath.length === 0) {
    return `${WORKSPACE_ROUTE}/`;
  }
  if (relativePath.startsWith('..') || win32.isAbsolute(relativePath)) {
    return null;
  }
  return `${WORKSPACE_ROUTE}/${relativePath.replaceAll('\\', '/')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
