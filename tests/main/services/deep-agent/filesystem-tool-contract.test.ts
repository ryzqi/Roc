import { describe, expect, it } from 'vitest';
import {
  ROC_DELETE_FILE_WORKSPACE_ERROR,
  ROC_FILE_TOOL_ALLOWED_ROUTE_PREFIXES,
  ROC_FILE_TOOL_MISSING_PATH_ERROR,
  ROC_FILE_TOOL_PATH_FIELDS,
  ROC_FILE_TOOL_PROMPT_LINES,
  ROC_FILE_TOOL_ROUTE_ERROR,
  ROC_FILE_TOOL_TRAVERSAL_ERROR,
  ROC_FILE_TOOL_WINDOWS_PATH_ERROR,
  createRocFilesystemPermissions,
  getRocFileToolPathField,
  isRocFileToolName,
  normalizeRocFileToolPath,
  toWorkspaceRelativePath,
  validateRocFileToolPath
} from '../../../../src/main/services/deep-agent/filesystem-tool-contract';

describe('Roc DeepAgents file-tool contract', () => {
  it('defines the only agent-visible file routes', () => {
    expect(ROC_FILE_TOOL_ALLOWED_ROUTE_PREFIXES).toEqual(['/workspace', '/skills', '/memory']);
    expect(ROC_FILE_TOOL_ROUTE_ERROR).toBe('Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。');
    expect(ROC_FILE_TOOL_WINDOWS_PATH_ERROR).toBe('Roc 文件工具使用虚拟路径；请改用 /workspace/...。');
    expect(ROC_FILE_TOOL_TRAVERSAL_ERROR).toBe('Roc 文件工具路径不能包含 .. 路径段。');
    expect(ROC_FILE_TOOL_MISSING_PATH_ERROR).toBe('Roc 文件工具调用缺少 path/file_path 字符串参数。');
    expect(ROC_DELETE_FILE_WORKSPACE_ERROR).toBe('delete_file 只允许删除 /workspace/ 路径下的文件或空目录。');
  });

  it('maps every Roc file-like tool to its path argument', () => {
    expect(ROC_FILE_TOOL_PATH_FIELDS).toEqual({
      ls: 'path',
      read_file: 'file_path',
      write_file: 'file_path',
      edit_file: 'file_path',
      glob: 'path',
      grep: 'path',
      delete_file: 'file_path'
    });
    expect(isRocFileToolName('read_file')).toBe(true);
    expect(isRocFileToolName('execute')).toBe(false);
    expect(getRocFileToolPathField('delete_file')).toBe('file_path');
    expect(getRocFileToolPathField('web_read')).toBeNull();
  });

  it.each([
    '/workspace',
    '/workspace/create_docx.py',
    '/memory/global/MEMORY.md',
    '/memory/global/AGENTS.md',
    '/memory/workspaces/current/AGENTS.md',
    '/skills/python/SKILL.md'
  ])('accepts Roc virtual path %s', (path) => {
    expect(validateRocFileToolPath(path)).toEqual({ ok: true });
    expect(normalizeRocFileToolPath(path)).toEqual({ ok: true, path });
  });

  it.each([
    ['/home/user/workarea/create_docx.py', ROC_FILE_TOOL_ROUTE_ERROR],
    ['/tmp/create_docx.py', ROC_FILE_TOOL_ROUTE_ERROR],
    ['/frontend/index.html', ROC_FILE_TOOL_ROUTE_ERROR],
    ['F:\\Code\\Roc\\create_docx.py', ROC_FILE_TOOL_WINDOWS_PATH_ERROR],
    ['\\\\server\\share\\file.txt', ROC_FILE_TOOL_WINDOWS_PATH_ERROR],
    ['relative/file.txt', ROC_FILE_TOOL_ROUTE_ERROR],
    ['/agents/AGENTS.md', ROC_FILE_TOOL_ROUTE_ERROR],
    ['/workspace/../secret.txt', ROC_FILE_TOOL_TRAVERSAL_ERROR]
  ])('rejects invalid file-tool path %s', (path, error) => {
    expect(validateRocFileToolPath(path)).toEqual({ ok: false, error });
    expect(normalizeRocFileToolPath(path)).toEqual({ ok: false, error });
  });

  it('uses an explicit final deny because DeepAgents permissions default to allow', () => {
    expect(createRocFilesystemPermissions()).toEqual([
      { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
      { operations: ['write'], paths: ['/workspace/**', '/memory/**'], mode: 'allow' },
      { operations: ['write'], paths: ['/skills/**'], mode: 'deny' },
      { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
    ]);
  });

  it('converts delete_file /workspace paths to existing files.delete relative paths', () => {
    expect(toWorkspaceRelativePath('/workspace/src/remove-me.ts')).toEqual({
      ok: true,
      relativePath: 'src/remove-me.ts'
    });
    expect(toWorkspaceRelativePath('/workspace')).toEqual({
      ok: false,
      error: ROC_DELETE_FILE_WORKSPACE_ERROR
    });
    expect(toWorkspaceRelativePath('/memory/global/MEMORY.md')).toEqual({
      ok: false,
      error: ROC_DELETE_FILE_WORKSPACE_ERROR
    });
  });

  it('keeps prompt guidance aligned with the runtime contract', () => {
    expect(ROC_FILE_TOOL_PROMPT_LINES).toEqual([
      'DeepAgents file tools accept only Roc virtual routes: /workspace/, /memory/, and /skills/.',
      'Agent memory files live under /memory/.../AGENTS.md, matching DeepAgents memory-source semantics.',
      'write_file only creates new files. To change an existing file, read it first, then use edit_file with an exact replacement.',
      'Do not pass Windows absolute paths or Linux paths to read_file, write_file, edit_file, ls, glob, grep, or delete_file.'
    ]);
  });
});
