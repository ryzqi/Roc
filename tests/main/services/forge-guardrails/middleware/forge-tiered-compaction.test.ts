import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  markIterationOnMessage,
  tagForgeMessage
} from '../../../../../src/main/services/forge-guardrails';
import { createForgeTieredCompactionEdits } from '../../../../../src/main/services/forge-guardrails/middleware/forge-tiered-compaction';

function headers(): BaseMessage[] {
  return [
    new SystemMessage({
      id: 'system',
      content: 'system prompt'
    }),
    new HumanMessage({
      id: 'user',
      content: 'initial user input'
    })
  ];
}

function mark<M extends BaseMessage>(message: M, iterationIndex: number): M {
  return markIterationOnMessage(message, iterationIndex) as M;
}

function retryNudge(id: string, iterationIndex: number): HumanMessage {
  return tagForgeMessage(
    mark(
      new HumanMessage({
        id,
        content: 'retry nudge'
      }),
      iterationIndex
    ),
    'forge:retry_nudge'
  );
}

function toolResult(id: string, iterationIndex: number, length = 260): ToolMessage {
  return mark(
    new ToolMessage({
      id,
      tool_call_id: `${id}-call`,
      name: 'read_file',
      content: 'x'.repeat(length),
      status: 'success'
    }),
    iterationIndex
  );
}

function toolResolution(id: string, iterationIndex: number): ToolMessage {
  return tagForgeMessage(
    mark(
      new ToolMessage({
        id,
        tool_call_id: `${id}-call`,
        name: 'read_background_task',
        content: '[ToolResolutionError] missing',
        status: 'success'
      }),
      iterationIndex
    ),
    'forge:tool_resolution'
  );
}

function assistantText(id: string, iterationIndex: number): AIMessage {
  return mark(
    new AIMessage({
      id,
      content: 'bare assistant text'
    }),
    iterationIndex
  );
}

function reasoningText(id: string, iterationIndex: number): AIMessage {
  return tagForgeMessage(
    mark(
      new AIMessage({
        id,
        content: 'internal reasoning'
      }),
      iterationIndex
    ),
    'forge:reasoning'
  );
}

function respondSynthetic(id: string, iterationIndex: number): AIMessage {
  return tagForgeMessage(
    mark(
      new AIMessage({
        id,
        content: 'visible response'
      }),
      iterationIndex
    ),
    'forge:respond_synthetic'
  );
}

function toolCallAi(id: string, iterationIndex: number): AIMessage {
  return mark(
    new AIMessage({
      id,
      content: '',
      tool_calls: [
        {
          name: 'read_file',
          args: { path: '/a.md' },
          id: `${id}-call`,
          type: 'tool_call'
        }
      ]
    }),
    iterationIndex
  );
}

async function applyTieredCompaction(messages: BaseMessage[], tokens: number, keepRecent = 2): Promise<void> {
  const edits = createForgeTieredCompactionEdits({
    budgetTokens: 1000,
    keepRecent,
    phaseThresholds: [0.6, 0.75, 0.9]
  });
  for (const edit of edits) {
    await edit.apply({
      messages,
      countTokens: async () => tokens
    });
  }
}

function ids(messages: BaseMessage[]): Array<string | undefined> {
  return messages.map((message) => message.id);
}

describe('ForgeTieredCompaction', () => {
  it('does not mutate messages below the first threshold', async () => {
    const messages = [...headers(), retryNudge('old-nudge', 1), toolResult('old-tool', 1)];
    const before = [...messages];

    await applyTieredCompaction(messages, 500);

    expect(messages).toEqual(before);
  });

  it('phase 1 drops old forge nudges and truncates old tool results', async () => {
    const messages = [...headers(), retryNudge('old-nudge', 1), toolResult('old-tool', 1), retryNudge('recent-nudge', 5)];

    await applyTieredCompaction(messages, 700);

    expect(ids(messages)).toEqual(['system', 'user', 'old-tool', 'recent-nudge']);
    const truncated = messages[2] as ToolMessage;
    expect(String(truncated.content)).toContain('[Truncated - 60 chars removed]');
    expect(String(truncated.content).startsWith('x'.repeat(200))).toBe(true);
  });

  it('phase 2 drops old tool results but keeps reasoning and text for later phases', async () => {
    const messages = [
      ...headers(),
      toolResult('old-tool', 1),
      reasoningText('old-reasoning', 1),
      assistantText('old-text', 1),
      toolCallAi('recent-anchor', 5)
    ];

    await applyTieredCompaction(messages, 850);

    expect(ids(messages)).toEqual(['system', 'user', 'old-reasoning', 'old-text', 'recent-anchor']);
  });

  it('phase 3 drops old reasoning and bare assistant text while keeping tool-call AI messages', async () => {
    const messages = [
      ...headers(),
      toolResult('old-tool', 1),
      reasoningText('old-reasoning', 1),
      assistantText('old-text', 1),
      toolCallAi('old-tool-call-ai', 1),
      toolCallAi('recent-anchor', 5)
    ];

    await applyTieredCompaction(messages, 980);

    expect(ids(messages)).toEqual(['system', 'user', 'old-tool-call-ai', 'recent-anchor']);
  });

  it('keeps the configured recent iteration window unchanged', async () => {
    const messages = [
      ...headers(),
      retryNudge('old-nudge', 1),
      toolResult('old-tool', 1),
      retryNudge('recent-nudge', 4),
      toolResult('recent-tool', 5)
    ];

    await applyTieredCompaction(messages, 980);

    expect(ids(messages)).toEqual(['system', 'user', 'recent-nudge', 'recent-tool']);
    expect(String((messages[3] as ToolMessage).content)).toBe('x'.repeat(260));
  });

  it('always preserves the system prompt and initial user input', async () => {
    const messages = [...headers(), retryNudge('old-nudge', 1), assistantText('old-text', 1)];

    await applyTieredCompaction(messages, 980);

    expect(ids(messages).slice(0, 2)).toEqual(['system', 'user']);
  });

  it('keeps tool-resolution soft errors when dropping normal tool results', async () => {
    const messages = [...headers(), toolResult('old-tool', 1), toolResolution('soft-error', 1), toolCallAi('recent-anchor', 5)];

    await applyTieredCompaction(messages, 850);

    expect(ids(messages)).toEqual(['system', 'user', 'soft-error', 'recent-anchor']);
  });

  it('keeps synthetic respond messages when dropping failed text responses', async () => {
    const messages = [...headers(), assistantText('old-text', 1), respondSynthetic('respond', 1), toolCallAi('recent-anchor', 5)];

    await applyTieredCompaction(messages, 980);

    expect(ids(messages)).toEqual(['system', 'user', 'respond', 'recent-anchor']);
  });

  it('does not compact when no message carries an iteration index', async () => {
    const messages = [
      ...headers(),
      tagForgeMessage(
        new HumanMessage({
          id: 'untagged-iteration-nudge',
          content: 'retry'
        }),
        'forge:retry_nudge'
      ),
      new ToolMessage({
        id: 'untagged-iteration-tool',
        tool_call_id: 'tool-call',
        name: 'read_file',
        content: 'x'.repeat(260),
        status: 'success'
      })
    ];
    const beforeIds = ids(messages);

    await applyTieredCompaction(messages, 980);

    expect(ids(messages)).toEqual(beforeIds);
    expect(String((messages[3] as ToolMessage).content)).toBe('x'.repeat(260));
  });
});
