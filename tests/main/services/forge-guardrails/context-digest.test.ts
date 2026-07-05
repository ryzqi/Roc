import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import {
  createContextDigestMessage,
  createEmptyContextDigest,
  isContextDigestMessage,
  refreshContextDigestMessage
} from '../../../../src/main/services/forge-guardrails/context-digest';
import { markIterationOnMessage } from '../../../../src/main/services/forge-guardrails';

function mark<M extends BaseMessage>(message: M, iterationIndex: number): M {
  return markIterationOnMessage(message, iterationIndex) as M;
}

describe('RocContextDigest', () => {
  it('creates a protected digest message', () => {
    const message = createContextDigestMessage({
      ...createEmptyContextDigest(),
      facts: ['Workspace is F:\\Code\\Roc.'],
      nextActions: ['Run targeted tests.']
    });

    expect(isContextDigestMessage(message)).toBe(true);
    expect(String(message.content)).toContain('Workspace is F:\\Code\\Roc.');
    expect(String(message.content)).toContain('Run targeted tests.');
  });

  it('refreshes digest from old assistant text and tool results', () => {
    const messages: BaseMessage[] = [
      mark(new AIMessage({ id: 'old-ai', content: 'Decision: use native DeepAgents memory.\nNext: update tests.' }), 1),
      mark(
        new ToolMessage({
          id: 'old-tool',
          tool_call_id: 'old-tool-call',
          name: 'run_shell_command',
          content: 'pnpm test -- tests/main/foo.test.ts\nPASS',
          status: 'success'
        }),
        1
      ),
      mark(new AIMessage({ id: 'recent-ai', content: 'Recent answer.' }), 5)
    ];

    refreshContextDigestMessage(messages, 2);

    const digests = messages.filter(isContextDigestMessage);
    expect(digests).toHaveLength(1);
    const digest = digests[0];
    if (digest === undefined) {
      throw new Error('Expected refreshContextDigestMessage to create one context digest');
    }
    expect(String(digest.content)).toContain('use native DeepAgents memory');
    expect(String(digest.content)).toContain('update tests');
    expect(String(digest.content)).toContain('pnpm test -- tests/main/foo.test.ts');
  });
});
