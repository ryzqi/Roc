import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  ROC_FILE_TOOL_ROUTE_ERROR,
  ROC_FILE_TOOL_WINDOWS_PATH_ERROR
} from '../../../../../src/main/services/deep-agent/filesystem-tool-contract';
import { createFilesystemToolErrorMiddleware } from '../../../../../src/main/services/forge-guardrails/middleware/filesystem-tool-errors';

async function runWrapToolCall(input: {
  toolName: string;
  content: string | Array<{ type: string; text?: string }>;
  status?: 'success' | 'error';
}) {
  const middleware = createFilesystemToolErrorMiddleware();
  if (typeof middleware.wrapToolCall !== 'function') {
    throw new Error('Expected filesystem tool error middleware to expose wrapToolCall.');
  }
  return await middleware.wrapToolCall(
    {
      toolCall: {
        name: input.toolName,
        args: { file_path: 'G:\\杂\\test\\quicksort_example.py' },
        id: `call-${input.toolName}`
      }
    } as never,
    (async () =>
      new ToolMessage({
        tool_call_id: `call-${input.toolName}`,
        name: input.toolName,
        content: input.content,
        status: input.status ?? 'success'
      })) as never
  );
}

describe('ForgeFilesystemToolErrorMiddleware', () => {
  it('marks invalid write_file route output as a hard tool error', async () => {
    const result = await runWrapToolCall({
      toolName: 'write_file',
      content: ROC_FILE_TOOL_ROUTE_ERROR
    });

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).status).toBe('error');
    expect(String((result as ToolMessage).content)).toContain('Roc 文件工具只允许访问');
  });

  it('marks invalid read_file route output as a hard tool error', async () => {
    const result = await runWrapToolCall({
      toolName: 'read_file',
      content: [
        {
          type: 'text',
          text: `Error: ${ROC_FILE_TOOL_ROUTE_ERROR}`
        }
      ]
    });

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).status).toBe('error');
  });

  it('does not mark successful read_file content as an error when it contains route error text', async () => {
    const result = await runWrapToolCall({
      toolName: 'read_file',
      content: [
        {
          type: 'text',
          text: `34: const UNKNOWN_ROUTE_ERROR = '${ROC_FILE_TOOL_ROUTE_ERROR}';`
        }
      ]
    });

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).status).toBe('success');
  });

  it('does not mark read_file file-not-found as hard because new-file creation may check absence first', async () => {
    const result = await runWrapToolCall({
      toolName: 'read_file',
      content: [
        {
          type: 'text',
          text: "Error: File '/quicksort_example.py' not found"
        }
      ]
    });

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).status).toBe('success');
  });

  it('passes successful write_file through unchanged', async () => {
    const result = await runWrapToolCall({
      toolName: 'write_file',
      content: "Successfully wrote to '/workspace/quicksort_example.py'"
    });

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).status).toBe('success');
  });

  it('marks DeepAgents write_file symlink rejections as hard tool errors', async () => {
    const result = await runWrapToolCall({
      toolName: 'write_file',
      content: 'Cannot write to /workspace/link.txt because it is a symlink. Symlinks are not allowed.'
    });

    expect(result).toBeInstanceOf(ToolMessage);
    expect(result).toMatchObject({
      tool_call_id: 'call-write_file',
      name: 'write_file',
      status: 'error',
      content: 'Cannot write to /workspace/link.txt because it is a symlink. Symlinks are not allowed.'
    });
  });

  it('ignores non-filesystem tools', async () => {
    const result = await runWrapToolCall({
      toolName: 'web_read',
      content: ROC_FILE_TOOL_ROUTE_ERROR
    });

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).status).toBe('success');
  });

  it('marks Windows virtual-route violations as hard file-tool errors', async () => {
    const result = await runWrapToolCall({
      toolName: 'read_file',
      content: [
        {
          type: 'text',
          text: `Error: ${ROC_FILE_TOOL_WINDOWS_PATH_ERROR}`
        }
      ]
    });

    expect(result).toBeInstanceOf(ToolMessage);
    expect(result).toMatchObject({
      tool_call_id: 'call-read_file',
      name: 'read_file',
      status: 'error'
    });
  });
});
