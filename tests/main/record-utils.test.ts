import { describe, expect, it } from 'vitest';
import {
  classifyStreamedAssistantText,
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
  it('keeps hosted search text prefixes pending until the raw result shape is confirmed', () => {
    expect(
      classifyStreamedAssistantText('Title: 成都 - 中国气象局-天气预报-城市预报\nURL: https://weather.cma.cn/web/weather/57303.html\nPub')
    ).toBe('pending');
  });

  it('classifies the hosted search raw result template as non-assistant streamed text', () => {
    expect(
      classifyStreamedAssistantText(
        [
          'Title: 成都 - 中国气象局-天气预报-城市预报',
          'URL: https://weather.cma.cn/web/weather/57303.html',
          'Published: N/A',
          'Author: N/A',
          'Highlights:'
        ].join('\n')
      )
    ).toBe('non_assistant');
  });

  it('returns assistant once a Title-prefixed message diverges from the hosted search result template', () => {
    expect(
      classifyStreamedAssistantText('Title: 成都天气总结\n今天多云，气温 22 度。')
    ).toBe('assistant');
  });

  it('identifies top-level server tool result messages as non-assistant text', () => {
    expect(
      isNonAssistantTextMessage({
        type: 'server_tool_call_result',
        text: 'RAW_EXA_RESULT_BODY'
      })
    ).toBe(true);
  });

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

  it('identifies hosted search result text blocks as non-assistant text', () => {
    expect(
      isNonAssistantTextMessage({
        content: [
          {
            type: 'text',
            text: [
              'Title: NVIDIA Corp (NVDA) | Currently at $235.74 (+4.39%) | May 14, 2026',
              'URL: https://finance.yahoo.com/quote/NVDA/',
              'Published: 2026-05-15T09:50:39.199Z',
              'Author: N/A',
              'Highlights:',
              '',
              'NVDA — NVIDIA Corp'
            ].join('\n')
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

  it('identifies skill file reads tagged with a /skills/.../SKILL.md path as non-assistant text', () => {
    expect(
      isNonAssistantTextMessage({
        text: '# Project Review\nFollow the review workflow.',
        additional_kwargs: {
          path: '/skills/project-review/SKILL.md'
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
