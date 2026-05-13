import { describe, expect, it } from 'vitest';
import { readReasoningBlockText, readReasoningFromMessageOutput } from '../../src/main/services/deep-agent/record-utils';

describe('record-utils reasoning helpers', () => {
  it('reads reasoning_content from message output additional_kwargs', async () => {
    await expect(
      readReasoningFromMessageOutput({
        additional_kwargs: {
          reasoning_content: 'trailing thinking'
        }
      })
    ).resolves.toBe('trailing thinking');
  });

  it('reads reasoning text from content blocks', async () => {
    await expect(
      readReasoningFromMessageOutput({
        contentBlocks: [
          {
            type: 'reasoning',
            reasoning: 'block thinking'
          }
        ]
      })
    ).resolves.toBe('block thinking');
  });

  it('reads reasoning block text from thinking blocks', () => {
    expect(
      readReasoningBlockText({
        type: 'thinking',
        thinking: 'native thinking'
      })
    ).toEqual(['native thinking']);
  });
});
