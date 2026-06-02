import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
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
      content: 'Roc 当前只允许访问 /workspace/、/skills/、/agents/、/memory/ 路径。'
    });

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).status).toBe('error');
    expect(String((result as ToolMessage).content)).toContain('Roc 当前只允许访问');
  });

  it('marks invalid read_file route output as a hard tool error', async () => {
    const result = await runWrapToolCall({
      toolName: 'read_file',
      content: [
        {
          type: 'text',
          text: 'Error: Roc 当前只允许访问 /workspace/、/skills/、/agents/、/memory/ 路径。'
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
          text: "34: const UNKNOWN_ROUTE_ERROR = 'Roc 当前只允许访问 /workspace/、/skills/、/agents/、/memory/ 路径。';"
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

  it('ignores non-filesystem tools', async () => {
    const result = await runWrapToolCall({
      toolName: 'web_read',
      content: 'Roc 当前只允许访问 /workspace/、/skills/、/agents/、/memory/ 路径。'
    });

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).status).toBe('success');
  });
});
