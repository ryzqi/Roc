import { describe, expect, it } from 'vitest';
import {
  isNonAssistantTextMessage,
  readReasoningBlockText,
  readReasoningFromMessageOutput
} from '../../src/main/services/deep-agent/record-utils';

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

  it('reads reasoning text from snake_case content blocks', async () => {
    await expect(
      readReasoningFromMessageOutput({
        content_blocks: [
          {
            type: 'reasoning',
            reasoning: 'snake block thinking'
          }
        ]
      })
    ).resolves.toBe('snake block thinking');
  });

  it('reads OpenAI Responses reasoning summaries from additional kwargs', async () => {
    await expect(
      readReasoningFromMessageOutput({
        additional_kwargs: {
          reasoning: {
            summary: [
              {
                type: 'summary_text',
                text: 'summary one'
              },
              {
                type: 'summary_text',
                text: 'summary two'
              }
            ]
          }
        }
      })
    ).resolves.toBe('summary onesummary two');
  });

  it('does not read plain text content blocks as reasoning', async () => {
    await expect(
      readReasoningFromMessageOutput({
        contentBlocks: [
          {
            type: 'text',
            text: 'plain answer'
          }
        ]
      })
    ).resolves.toBeNull();
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

describe('record-utils assistant text boundaries', () => {
  it('identifies tool result content blocks as non-assistant text', () => {
    expect(
      isNonAssistantTextMessage({
        contentBlocks: [
          {
            type: 'tool_result',
            name: 'web_search',
            content: '{"results":[{"title":"Exa raw result"}]}'
          }
        ]
      })
    ).toBe(true);
  });

  it('identifies skill load content blocks as non-assistant text', () => {
    expect(
      isNonAssistantTextMessage({
        additional_kwargs: {
          content_blocks: [
            {
              type: 'skill_loaded',
              name: 'project-review',
              path: '/skills/project-review/SKILL.md',
              content: '---\nname: project-review\ndescription: Review a project\n---\n# Project Review'
            }
          ]
        }
      })
    ).toBe(true);
  });

  it('keeps ordinary assistant text messages visible', () => {
    expect(
      isNonAssistantTextMessage({
        contentBlocks: [
          {
            type: 'text',
            text: '这是模型最终回答。'
          }
        ]
      })
    ).toBe(false);
  });
});
