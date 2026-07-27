import { ToolMessage } from '@langchain/core/messages';
import { MiddlewareError } from 'langchain';
import { describe, expect, it } from 'vitest';
import {
  readForgeMessageTag,
  RocToolResolutionError
} from '../../../../../src/main/services/forge-guardrails';
import { createToolResolutionMiddleware } from '../../../../../src/main/services/forge-guardrails/middleware/tool-resolution';

async function runWrapToolCall(handler: () => Promise<ToolMessage> | ToolMessage) {
  const middleware = createToolResolutionMiddleware();
  if (typeof middleware.wrapToolCall !== 'function') {
    throw new Error('Expected tool resolution middleware to expose wrapToolCall.');
  }
  return middleware.wrapToolCall(
    {
      toolCall: {
        name: 'read_background_task',
        args: { taskId: 'missing' },
        id: 'call-read-missing'
      }
    } as never,
    handler as never
  );
}

describe('ForgeToolResolutionMiddleware', () => {
  it('turns RocToolResolutionError into a soft ToolMessage for model correction', async () => {
    const result = await runWrapToolCall(async () => {
      throw new RocToolResolutionError('Background task does not exist.');
    });

    expect(result).toBeInstanceOf(ToolMessage);
    const message = result as ToolMessage;
    expect(message.tool_call_id).toBe('call-read-missing');
    expect(message.name).toBe('read_background_task');
    expect(message.content).toContain('[ToolResolutionError] Background task does not exist.');
    expect(message.status).toBe('success');
    expect(readForgeMessageTag(message)).toBe('forge:tool_resolution');
  });

  it('recognizes a resolution error wrapped by an inner effect middleware', async () => {
    const result = await runWrapToolCall(async () => {
      throw MiddlewareError.wrap(
        new RocToolResolutionError('Background task does not exist.'),
        'RocToolEffectIdempotencyMiddleware'
      );
    });

    expect(result).toBeInstanceOf(ToolMessage);
    const message = result as ToolMessage;
    expect(message.content).toContain('[ToolResolutionError] Background task does not exist.');
    expect(message.status).toBe('success');
    expect(readForgeMessageTag(message)).toBe('forge:tool_resolution');
  });

  it('passes through normal tool messages', async () => {
    const toolMessage = new ToolMessage({
      tool_call_id: 'call-ok',
      name: 'read_background_task',
      content: 'ok',
      status: 'success'
    });

    await expect(runWrapToolCall(() => toolMessage)).resolves.toBe(toolMessage);
  });

  it('rethrows non-resolution errors', async () => {
    await expect(
      runWrapToolCall(async () => {
        throw new Error('database unavailable');
      })
    ).rejects.toThrow('database unavailable');
  });
});
