import { describe, expect, it } from 'vitest';
import {
  classifyStreamedAssistantText,
  isNonAssistantTextMessage,
  isSummarizationMessage,
  readMessageContentSummary,
  readReasoningBlockText,
  readReasoningFromMessageOutput
} from '../../src/main/services/deep-agent/record-utils';

describe('record-utils reasoning helpers', () => {
  it('separates visible assistant text from reasoning blocks', () => {
    expect(
      readMessageContentSummary({
        content: [
          {
            type: 'reasoning',
            reasoning: '先分析。'
          },
          {
            type: 'text',
            text: '最终回答。'
          }
        ]
      })
    ).toEqual({
      hasReasoning: true,
      hasVisibleText: true,
      visibleText: '最终回答。'
    });
  });

  it('treats string content as visible assistant text without reasoning', () => {
    expect(
      readMessageContentSummary({
        content: '直接回答。'
      })
    ).toEqual({
      hasReasoning: false,
      hasVisibleText: true,
      visibleText: '直接回答。'
    });
  });

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

  it('reads reasoning from final output contentBlocks before legacy fallback fields', async () => {
    await expect(
      readReasoningFromMessageOutput({
        contentBlocks: [
          {
            type: 'reasoning',
            text: 'standard content block thinking'
          }
        ],
        additional_kwargs: {
          reasoning_content: 'legacy thinking'
        }
      })
    ).resolves.toBe('standard content block thinking');
  });

  it('ignores snake_case content block fallbacks that are no longer part of the supported contract', async () => {
    await expect(
      readReasoningFromMessageOutput({
        content_blocks: [
          {
            type: 'reasoning',
            reasoning: 'snake block thinking'
          }
        ]
      })
    ).resolves.toBeNull();
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

  it('reads reasoning from final output content array after metadata fallbacks are absent', async () => {
    await expect(
      readReasoningFromMessageOutput({
        content: [
          {
            type: 'reasoning',
            reasoning: 'content array thinking'
          },
          {
            type: 'text',
            text: 'visible answer'
          }
        ]
      })
    ).resolves.toBe('content array thinking');
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

  it('ignores legacy thinking blocks outside the supported reasoning block shape', () => {
    expect(
      readReasoningBlockText({
        type: 'thinking',
        thinking: 'native thinking'
      })
    ).toEqual([]);
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

  it('treats raw skill frontmatter text as assistant text unless the message is structurally tagged', () => {
    expect(
      classifyStreamedAssistantText('---\nname: project-review\ndescription: Review a project\n---\n# Project Review')
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

  it('identifies projection metadata tagged with lcSource=summarization as internal text', () => {
    expect(
      isSummarizationMessage({
        text: 'internal summary',
        metadata: {
          lcSource: 'summarization'
        }
      })
    ).toBe(true);
  });

  it('does not mark ordinary assistant messages as summarization text', () => {
    expect(
      isSummarizationMessage({
        text: 'visible answer',
        metadata: {
          lcSource: 'assistant'
        }
      })
    ).toBe(false);
  });

  it('identifies summarization markers on additional_kwargs, response_metadata, and tags', () => {
    expect(
      isSummarizationMessage({
        text: 'internal summary',
        additional_kwargs: {
          lc_source: 'summarization'
        }
      })
    ).toBe(true);
    expect(
      isSummarizationMessage({
        text: 'internal summary',
        additional_kwargs: {
          lcSource: 'summarization'
        }
      })
    ).toBe(true);
    expect(
      isSummarizationMessage({
        text: 'internal summary',
        response_metadata: {
          lc_source: 'summarization'
        }
      })
    ).toBe(true);
    expect(
      isSummarizationMessage({
        text: 'internal summary',
        tags: ['roc-context-summary']
      })
    ).toBe(true);
    expect(
      isSummarizationMessage({
        text: 'internal summary',
        metadata: {
          tags: ['nostream']
        }
      })
    ).toBe(false);
  });

  it('classifies a complete context summary JSON payload as non-assistant streamed text', () => {
    expect(classifyStreamedAssistantText(CONTEXT_SUMMARY_JSON)).toBe('non_assistant');
    expect(classifyStreamedAssistantText('```json\n' + CONTEXT_SUMMARY_JSON + '\n```')).toBe('non_assistant');
  });

  it('keeps a context summary JSON prefix pending until the schema is confirmed', () => {
    expect(classifyStreamedAssistantText('{')).toBe('pending');
    expect(classifyStreamedAssistantText('{\n  "goal": "create svg"')).toBe('pending');
    expect(classifyStreamedAssistantText('```json')).toBe('pending');
  });

  it('releases ordinary JSON as soon as the first key is not a context summary field', () => {
    expect(classifyStreamedAssistantText('{"status"')).toBe('assistant');
    expect(classifyStreamedAssistantText('{"status":"ok","message":"done"}')).toBe('assistant');
  });

  it('still hides a context summary JSON object that includes extra keys', () => {
    expect(classifyStreamedAssistantText(CONTEXT_SUMMARY_JSON_WITH_EXTRA_KEY)).toBe('non_assistant');
  });

  it('does not treat a truncated non-json fence as a context summary payload', () => {
    expect(classifyStreamedAssistantText('```j')).toBe('assistant');
  });

  it('does not hide ordinary assistant JSON or context digest XML', () => {
    expect(classifyStreamedAssistantText('{"status":"ok","message":"done"}')).toBe('assistant');
    expect(
      classifyStreamedAssistantText([
        '<roc_context_digest>',
        '<facts>',
        '- Workspace is F:\\Code\\Roc.',
        '</facts>',
        '<decisions />',
        '<filesTouched />',
        '<verifications />',
        '<openQuestions />',
        '<nextActions />',
        '</roc_context_digest>'
      ].join('\n'))
    ).toBe('assistant');
  });
});

const CONTEXT_SUMMARY_JSON = JSON.stringify({
  decisions: ['The SVG was created with the filename pelican_bike.svg and is complete, 118 lines.'],
  facts: ['Workspace directory is G:\\test.'],
  filesTouched: ['G:\\test\\pelican_bike.svg'],
  goal: 'create a pelican riding a bicycle svg in the current directory',
  nextActions: ['Report completion of the SVG file.'],
  openQuestions: ['Whether the user wants any visual adjustments after previewing the SVG in a browser.'],
  toolEvidence: ['Command: Get-Content produced the final SVG block and closed with </svg>.'],
  verification: ['File ends with </svg> and is not truncated.']
});

const CONTEXT_SUMMARY_JSON_WITH_EXTRA_KEY = JSON.stringify({
  ...JSON.parse(CONTEXT_SUMMARY_JSON),
  extra: 'ignored'
});
