import type { FilesystemPermission } from 'deepagents';

export const ROC_FILE_TOOL_ROUTE_ERROR = 'Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。';
export const ROC_FILE_TOOL_WINDOWS_PATH_ERROR = 'Roc 文件工具使用虚拟路径；请改用 /workspace/...。';
export const ROC_FILE_TOOL_TRAVERSAL_ERROR = 'Roc 文件工具路径不能包含 .. 路径段。';
export const ROC_FILE_TOOL_MISSING_PATH_ERROR = 'Roc 文件工具调用缺少 path/file_path 字符串参数。';
export const ROC_DELETE_FILE_WORKSPACE_ERROR = 'delete_file 只允许删除 /workspace/ 路径下的文件或空目录。';

export const ROC_FILE_TOOL_ALLOWED_ROUTE_PREFIXES = ['/workspace', '/skills', '/memory'] as const;

export const ROC_FILE_TOOL_PATH_FIELDS = {
  ls: 'path',
  read_file: 'file_path',
  write_file: 'file_path',
  edit_file: 'file_path',
  glob: 'path',
  grep: 'path',
  delete_file: 'file_path'
} as const;

export const ROC_FILE_TOOL_PROMPT_LINES = [
  'DeepAgents file tools accept only Roc virtual routes: /workspace/, /memory/, and /skills/.',
  'Agent memory files live under /memory/.../AGENTS.md, matching DeepAgents memory-source semantics.',
  'write_file creates new files or fully replaces existing files. Use edit_file for targeted changes to existing files.',
  'Do not pass Windows absolute paths or Linux paths to read_file, write_file, edit_file, ls, glob, grep, or delete_file.'
] as const;

export type RocFileToolName = keyof typeof ROC_FILE_TOOL_PATH_FIELDS;
export type RocFileToolPathField = (typeof ROC_FILE_TOOL_PATH_FIELDS)[RocFileToolName];

export type PathValidationResult =
  | { ok: true }
  | { ok: false; error: string };

export type PathNormalizationResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

export type WorkspaceRelativePathResult =
  | { ok: true; relativePath: string }
  | { ok: false; error: string };

const ROC_FILE_TOOL_NAME_SET = new Set<string>(Object.keys(ROC_FILE_TOOL_PATH_FIELDS));

export function createRocFilesystemPermissions(): FilesystemPermission[] {
  return [
    { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
    { operations: ['write'], paths: ['/workspace/**', '/memory/**'], mode: 'allow' },
    { operations: ['write'], paths: ['/skills/**'], mode: 'deny' },
    { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
  ];
}

export function createRocReadOnlyFilesystemPermissions(): FilesystemPermission[] {
  return [
    { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
    { operations: ['write'], paths: ['/**'], mode: 'deny' }
  ];
}

export function isRocFileToolName(name: string): name is RocFileToolName {
  return ROC_FILE_TOOL_NAME_SET.has(name);
}

export function getRocFileToolPathField(name: string): RocFileToolPathField | null {
  if (!isRocFileToolName(name)) {
    return null;
  }
  return ROC_FILE_TOOL_PATH_FIELDS[name];
}

export function validateRocFileToolPath(path: string): PathValidationResult {
  const normalized = normalizeRocFileToolPath(path);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }
  return { ok: true };
}

export function normalizeRocFileToolPath(path: string): PathNormalizationResult {
  if (containsTraversal(path)) {
    return { ok: false, error: ROC_FILE_TOOL_TRAVERSAL_ERROR };
  }
  if (isWindowsAbsolutePath(path) || isUncPath(path)) {
    return { ok: false, error: ROC_FILE_TOOL_WINDOWS_PATH_ERROR };
  }
  if (isAllowedRoutePath(path)) {
    return { ok: true, path };
  }
  return { ok: false, error: ROC_FILE_TOOL_ROUTE_ERROR };
}

export function toWorkspaceRelativePath(filePath: string): WorkspaceRelativePathResult {
  const validation = validateRocFileToolPath(filePath);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }
  if (!filePath.startsWith('/workspace/')) {
    return { ok: false, error: ROC_DELETE_FILE_WORKSPACE_ERROR };
  }
  const relativePath = filePath.slice('/workspace/'.length);
  if (relativePath.length === 0) {
    return { ok: false, error: ROC_DELETE_FILE_WORKSPACE_ERROR };
  }
  return { ok: true, relativePath };
}

function isAllowedRoutePath(path: string): boolean {
  return ROC_FILE_TOOL_ALLOWED_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
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
