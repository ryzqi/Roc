import { HumanMessage, RemoveMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  readForgeMessageTag,
  tagForgeMessage
} from '../../../../../src/main/services/forge-guardrails';
import { createForgeCleanupMiddleware } from '../../../../../src/main/services/forge-guardrails/middleware/forge-cleanup';

function cleanupIds(messages: BaseMessage[]): string[] {
  const middleware = createForgeCleanupMiddleware();
  if (typeof middleware.afterAgent !== 'function') {
    throw new Error('Expected cleanup middleware to expose afterAgent.');
  }

  const update = middleware.afterAgent({ messages } as never, {} as never) as { messages?: RemoveMessage[] } | undefined;
  return (update?.messages ?? []).map((message) => message.id);
}

describe('ForgeCleanupMiddleware', () => {
  it('removes legacy retry nudges', () => {
    const nudge = tagForgeMessage(
      new HumanMessage({
        id: 'forge-retry-nudge-ai-bare',
        content: 'retry'
      }),
      'forge:retry_nudge'
    );

    expect(readForgeMessageTag(nudge)).toBe('forge:retry_nudge');
    expect(cleanupIds([nudge])).toEqual(['forge-retry-nudge-ai-bare']);
  });

  it('removes legacy unknown-tool nudges', () => {
    const nudge = tagForgeMessage(
      new ToolMessage({
        id: 'forge-unknown-tool-nudge-call-missing',
        tool_call_id: 'call-missing',
        name: 'missing_tool',
        content: 'unknown tool',
        status: 'error'
      }),
      'forge:unknown_tool_nudge'
    );

    expect(readForgeMessageTag(nudge)).toBe('forge:unknown_tool_nudge');
    expect(cleanupIds([nudge])).toEqual(['forge-unknown-tool-nudge-call-missing']);
  });
});
