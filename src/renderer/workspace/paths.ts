/**
 * Workspace-relative path rules (R10).
 *
 * Every `files.*` and `git.*` request carries a **relative** path — the backend
 * resolves it against the bound workspace and owns the real boundary. What the
 * renderer must still do is refuse to *send* paths that try to escape, because
 * rejecting them locally gives an immediate, specific error instead of a round
 * trip that may fail with something vaguer. The plan's R10 wording ("path must be
 * prefixed by `workspacePath`") predates knowing the contract is relative; the
 * enforceable half of it is this module.
 *
 * `''` is valid and means the workspace root — `files.listTree` uses it to list
 * the top level.
 *
 * NOTE: the app ships macOS-only (`package.json` `os: ["darwin"]`), so a literal
 * backslash is a legal filename character rather than a separator. It is still
 * rejected as a *separator-like* escape (`..\\`) below, because treating it as
 * one can only ever produce a false negative in our favour.
 */

export type PathRejection =
  | 'absolute'
  | 'escapes_workspace'
  | 'nul_byte'
  | 'empty_segment'
  | 'too_long';

export type PathCheck = { ok: true } | { ok: false; reason: PathRejection };

const MAX_RELATIVE_PATH_LENGTH = 1024;

/** Segments that try to move above the workspace root. */
function hasTraversalSegment(path: string): boolean {
  return path.split(/[/\\]/u).some((segment) => segment === '..');
}

function isAbsoluteLike(path: string): boolean {
  if (path.startsWith('/')) {
    return true;
  }
  if (path.startsWith('~')) {
    return true;
  }
  // Windows drive letters, and UNC-style prefixes, for defensive completeness.
  if (/^[a-zA-Z]:/u.test(path)) {
    return true;
  }
  return path.startsWith('\\\\');
}

export function checkRelativePath(path: string): PathCheck {
  if (path.includes('\0')) {
    return { ok: false, reason: 'nul_byte' };
  }
  if (path.length > MAX_RELATIVE_PATH_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }
  if (path.length === 0) {
    return { ok: true };
  }
  if (isAbsoluteLike(path)) {
    return { ok: false, reason: 'absolute' };
  }
  if (hasTraversalSegment(path)) {
    return { ok: false, reason: 'escapes_workspace' };
  }
  // Doubled separators or a trailing separator would name something other than
  // the intended entry. (A leading `/` is already rejected as absolute above.)
  if (path.endsWith('/') || path.includes('//')) {
    return { ok: false, reason: 'empty_segment' };
  }
  return { ok: true };
}

export function isSafeRelativePath(path: string): boolean {
  return checkRelativePath(path).ok;
}

export function pathRejectionMessage(reason: PathRejection): string {
  if (reason === 'absolute') {
    return '文件路径必须是工作目录内的相对路径。';
  }
  if (reason === 'escapes_workspace') {
    return '文件路径不能越出工作目录。';
  }
  if (reason === 'nul_byte') {
    return '文件路径包含非法字符。';
  }
  if (reason === 'too_long') {
    return '文件路径过长。';
  }
  if (reason === 'empty_segment') {
    return '文件路径不能以分隔符结尾，也不能出现连续分隔符。';
  }
  return '文件路径格式不正确。';
}

/** Joins a workspace-relative directory with a child name. */
export function joinRelative(parent: string, name: string): string {
  if (parent.length === 0) {
    return name;
  }
  if (name.length === 0) {
    return parent;
  }
  return `${parent}/${name}`;
}

/** The containing directory, or `''` for a top-level entry. */
export function parentRelative(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '' : path.slice(0, index);
}

export function fileName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

/** Lowercased extension without the dot, or `''`. Dotfiles have no extension. */
export function extensionOf(path: string): string {
  const name = fileName(path);
  const index = name.lastIndexOf('.');
  if (index <= 0) {
    return '';
  }
  return name.slice(index + 1).toLowerCase();
}

/**
 * How a file should be previewed.
 *
 * `pdf` is separate from `text`/`image` because it does not come back through
 * `files.preview`: the backend hands out a custom-protocol URL from
 * `files.previewPdf` and the renderer must use that directly (no Blob URL — R9).
 */
export type PreviewKind = 'pdf' | 'image' | 'markdown' | 'latex' | 'code' | 'text' | 'binary';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'sh', 'bash', 'zsh', 'fish', 'yml', 'yaml', 'toml', 'ini', 'cfg',
  'sql', 'html', 'htm', 'css', 'scss', 'less', 'xml', 'r', 'jl', 'm', 'mm', 'pl', 'lua', 'php', 'vue',
  'svelte', 'dockerfile', 'gitignore', 'env'
]);
const TEXT_EXTENSIONS = new Set(['txt', 'log', 'csv', 'tsv', 'bib', 'ris', 'mdx', 'rst']);

export function previewKindFor(relativePath: string): PreviewKind {
  const extension = extensionOf(relativePath);
  if (extension === 'pdf') {
    return 'pdf';
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }
  if (extension === 'md' || extension === 'markdown') {
    return 'markdown';
  }
  if (extension === 'tex' || extension === 'ltx' || extension === 'sty' || extension === 'cls') {
    return 'latex';
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return 'code';
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return 'text';
  }
  // No extension: many text files (README, Makefile) have none. Let the backend
  // decide via `files.preview.kind`; only unknown *binary* content falls through.
  return extension.length === 0 ? 'text' : 'binary';
}

/** True when a preview may be edited and saved back through `files.writeText`. */
export function isEditablePreviewKind(kind: PreviewKind): boolean {
  return kind === 'markdown' || kind === 'latex' || kind === 'code' || kind === 'text';
}

/**
 * Sorts tree entries the way a file browser does: directories first, then names
 * case-insensitively, with dotfiles after their visible siblings.
 */
export function compareTreeEntries(
  left: { name: string; type: 'file' | 'directory' },
  right: { name: string; type: 'file' | 'directory' }
): number {
  if (left.type !== right.type) {
    return left.type === 'directory' ? -1 : 1;
  }
  const leftHidden = left.name.startsWith('.');
  const rightHidden = right.name.startsWith('.');
  if (leftHidden !== rightHidden) {
    return leftHidden ? 1 : -1;
  }
  return left.name.localeCompare(right.name, 'zh-CN', { sensitivity: 'base' });
}
