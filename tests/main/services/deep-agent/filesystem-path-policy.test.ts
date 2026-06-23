import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { createRocFilesystemPathPolicyMiddleware, normalizeRocFileToolPath, validateRocFileToolPath } from '../../../../src/main/services/deep-agent/filesystem-path-policy';
import {
  ROC_FILE_TOOL_MISSING_PATH_ERROR,
  ROC_FILE_TOOL_WINDOWS_PATH_ERROR
} from '../../../../src/main/services/deep-agent/filesystem-tool-contract';

describe('validateRocFileToolPath', () => {
  it.each([
    '/workspace/create_docx.py',
    '/memory/global/MEMORY.md',
    '/memory/global/AGENTS.md',
    '/memory/workspaces/current/AGENTS.md',
    '/skills/python/SKILL.md'
  ])('accepts Roc route path %s', (path) => {
    expect(validateRocFileToolPath(path)).toEqual({ ok: true });
  });

  it.each([
    ['/home/user/workarea/create_docx.py', 'Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。'],
    ['/tmp/create_docx.py', 'Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。'],
    ['F:\\Code\\Roc\\create_docx.py', 'Roc 文件工具使用虚拟路径；请改用 /workspace/...。'],
    ['\\\\server\\share\\file.txt', 'Roc 文件工具使用虚拟路径；请改用 /workspace/...。'],
    ['relative/file.txt', 'Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。'],
    ['/agents/AGENTS.md', 'Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。'],
    ['/workspace/../secret.txt', 'Roc 文件工具路径不能包含 .. 路径段。']
  ])('rejects invalid path %s', (path, error) => {
    expect(validateRocFileToolPath(path)).toEqual({ ok: false, error });
  });
});

describe('normalizeRocFileToolPath', () => {
  it('rejects selected workspace Windows paths instead of rewriting them', () => {
    expect(normalizeRocFileToolPath('F:\\Code\\Roc\\scripts\\probe.ts')).toEqual({
      ok: false,
      error: ROC_FILE_TOOL_WINDOWS_PATH_ERROR
    });
  });

  it('rejects Windows paths outside the selected workspace', () => {
    expect(normalizeRocFileToolPath('F:\\Other\\probe.ts')).toEqual({
      ok: false,
      error: ROC_FILE_TOOL_WINDOWS_PATH_ERROR
    });
  });
});

describe('createRocFilesystemPathPolicyMiddleware', () => {
  it('returns an error ToolMessage before invalid write_file reaches the handler', async () => {
    const middleware = createRocFilesystemPathPolicyMiddleware();
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-1',
      name: 'write_file',
      content: 'handler reached'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-1',
          name: 'write_file',
          args: {
            file_path: '/home/user/workarea/create_docx.py',
            content: 'print(1)'
          }
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(ToolMessage);
    expect(result).toMatchObject({
      tool_call_id: 'call-1',
      name: 'write_file',
      status: 'error',
      content: 'Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。'
    });
  });

  it('returns an error ToolMessage when a file tool omits its path field', async () => {
    const middleware = createRocFilesystemPathPolicyMiddleware();
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-missing',
      name: 'read_file',
      content: 'handler reached'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-missing',
          name: 'read_file',
          args: {}
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      tool_call_id: 'call-missing',
      name: 'read_file',
      status: 'error',
      content: ROC_FILE_TOOL_MISSING_PATH_ERROR
    });
  });

  it('returns an error ToolMessage when a file tool path field is not a string', async () => {
    const middleware = createRocFilesystemPathPolicyMiddleware();
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-non-string',
      name: 'ls',
      content: 'handler reached'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-non-string',
          name: 'ls',
          args: { path: 42 }
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      tool_call_id: 'call-non-string',
      name: 'ls',
      status: 'error',
      content: ROC_FILE_TOOL_MISSING_PATH_ERROR
    });
  });

  it('applies the same virtual path policy to delete_file', async () => {
    const middleware = createRocFilesystemPathPolicyMiddleware();
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-delete',
      name: 'delete_file',
      content: 'handler reached'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-delete',
          name: 'delete_file',
          args: {
            file_path: 'src/remove-me.ts'
          }
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      tool_call_id: 'call-delete',
      name: 'delete_file',
      status: 'error',
      content: 'Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。'
    });
  });

  it('passes valid ls paths through to the handler', async () => {
    const middleware = createRocFilesystemPathPolicyMiddleware();
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-2',
      name: 'ls',
      content: 'ok'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-2',
          name: 'ls',
          args: {
            path: '/workspace/scripts'
          }
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toBeInstanceOf(ToolMessage);
    expect(result).toMatchObject({
      tool_call_id: 'call-2',
      name: 'ls',
      content: 'ok'
    });
  });

  it('ignores non-filesystem tools', async () => {
    const middleware = createRocFilesystemPathPolicyMiddleware();
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-3',
      name: 'web_read',
      content: 'ok'
    }));

    await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-3',
          name: 'web_read',
          args: {
            url: 'https://example.com'
          }
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
