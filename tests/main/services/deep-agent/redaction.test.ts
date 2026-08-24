import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { redactUnknown } from '../../../../src/main/services/deep-agent/redaction';
import { toolCallAssistantBlockSchema } from '../../../../src/shared/schemas/task-event';

const jsonSchema = z.json();
const jsonRecordSchema = z.record(z.string(), z.json());

function parseToolCallBlock(output: unknown): unknown {
  return toolCallAssistantBlockSchema.parse({
    kind: 'tool_call',
    blockId: 'block_redaction',
    callId: 'call_redaction',
    name: 'write_todos',
    phase: 'end',
    output
  });
}

describe('redactUnknown', () => {
  it('drops object properties whose value has no JSON representation', () => {
    const redacted = redactUnknown({
      keep: 'value',
      missing: undefined,
      handler: () => 'noop',
      tag: Symbol('tag')
    });

    expect(redacted).toEqual({ keep: 'value' });
    expect(jsonRecordSchema.safeParse(redacted).success).toBe(true);
  });

  it('maps array holes and non-finite numbers to null and bigint to string', () => {
    const redacted = redactUnknown({
      list: [1, undefined, () => 'noop'],
      notANumber: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      big: 9_007_199_254_740_993n
    });

    expect(redacted).toEqual({
      list: [1, null, null],
      notANumber: null,
      infinite: null,
      big: '9007199254740993'
    });
    expect(jsonRecordSchema.safeParse(redacted).success).toBe(true);
  });

  it('still redacts secrets in nested strings', () => {
    const redacted = redactUnknown({
      headers: { Authorization: 'Bearer nvapi-secret-token' },
      lines: ['api_key=nvapi-secret-token']
    });

    expect(JSON.stringify(redacted)).not.toContain('secret-token');
    expect(jsonRecordSchema.safeParse(redacted).success).toBe(true);
  });

  it('produces a JSON-safe value for a LangChain ToolMessage', () => {
    const redacted = redactUnknown(new ToolMessage({ content: 'done', tool_call_id: 'call_1' }));

    expect(jsonSchema.safeParse(redacted).success).toBe(true);
    expect(jsonRecordSchema.safeParse(redacted).success).toBe(true);
    expect(redacted).not.toHaveProperty('status');
    expect(redacted).toMatchObject({ content: 'done', tool_call_id: 'call_1' });
    expect(() => parseToolCallBlock(redacted)).not.toThrow();
  });

  it('produces a JSON-safe value for a LangGraph Command carrying messages', () => {
    const command = new Command({
      update: { todos: [{ content: 'ship fix', status: 'pending' }], messages: [new AIMessage({ content: 'ok' })] }
    });
    const redacted = redactUnknown(command);

    expect(jsonSchema.safeParse(redacted).success).toBe(true);
    expect(jsonRecordSchema.safeParse(redacted).success).toBe(true);
    expect(redacted).not.toHaveProperty('graph');
    expect(redacted).not.toHaveProperty('resume');
    expect(() => parseToolCallBlock(redacted)).not.toThrow();
  });

  it('keeps returning undefined for a value with no JSON representation', () => {
    expect(redactUnknown(undefined)).toBeUndefined();
    expect(redactUnknown(() => 'noop')).toBeUndefined();
  });
});
