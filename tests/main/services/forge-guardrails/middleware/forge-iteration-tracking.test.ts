import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage
} from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  readIterationFromMessage,
  tagForgeMessage
} from '../../../../../src/main/services/forge-guardrails';
import { createForgeIterationTrackingMiddleware } from '../../../../../src/main/services/forge-guardrails/middleware/forge-iteration-tracking';
import { createForgeTieredCompactionEdits } from '../../../../../src/main/services/forge-guardrails/middleware/forge-tiered-compaction';

function getBeforeModelHook() {
  const middleware = createForgeIterationTrackingMiddleware();
  if (typeof middleware.beforeModel !== 'function') {
    throw new Error('Expected iteration tracking middleware to expose beforeModel.');
  }
  return middleware.beforeModel;
}

async function applyTieredCompaction(messages: BaseMessage[]): Promise<void> {
  const edits = createForgeTieredCompactionEdits({
    budgetTokens: 1000,
    keepRecent: 1,
    phaseThresholds: [0.6, 0.75, 0.9]
  });
  for (const edit of edits) {
    await edit.apply({
      messages,
      countTokens: async () => 980
    });
  }
}

describe('ForgeIterationTrackingMiddleware', () => {
  it('marks the previous AI message with the next iteration index', () => {
    const beforeModel = getBeforeModelHook();
    const firstAi = new AIMessage({ id: 'ai-1', content: 'first' });
    const messages = [
      new HumanMessage({ id: 'user', content: 'start' }),
      firstAi
    ];

    beforeModel({ messages } as never, {} as never);

    expect(readIterationFromMessage(firstAi)).toBe(0);

    const secondAi = new AIMessage({ id: 'ai-2', content: 'second' });
    messages.push(new HumanMessage({ id: 'user-2', content: 'next' }), secondAi);

    beforeModel({ messages } as never, {} as never);

    expect(readIterationFromMessage(firstAi)).toBe(0);
    expect(readIterationFromMessage(secondAi)).toBe(1);
  });

  it('keeps tiered compaction anchored to recent tracked iterations', async () => {
    const beforeModel = getBeforeModelHook();
    const oldAi = new AIMessage({ id: 'old-ai', content: 'old' });
    const recentAi = new AIMessage({ id: 'recent-ai', content: 'ready' });
    const messages: BaseMessage[] = [
      new HumanMessage({ id: 'user', content: 'start' }),
      oldAi
    ];

    beforeModel({ messages } as never, {} as never);

    messages.push(
      tagForgeMessage(
        new HumanMessage({
          id: 'old-nudge',
          content: 'retry'
        }),
        'forge:retry_nudge'
      ),
      new ToolMessage({
        id: 'old-tool',
        tool_call_id: 'call-old',
        name: 'read_file',
        content: 'x'.repeat(260),
        status: 'success'
      }),
      recentAi
    );

    beforeModel({ messages } as never, {} as never);
    await applyTieredCompaction(messages);

    expect(messages.map((message) => message.id)).toEqual(['user', 'recent-ai']);
  });
});
