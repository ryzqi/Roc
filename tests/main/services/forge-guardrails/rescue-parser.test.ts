import { describe, expect, it } from 'vitest';
import { rescueToolCall, type RescueToolCandidate } from '../../../../src/main/services/forge-guardrails/rescue-parser';

describe('forge rescue parser', () => {
  it.each([
    [
      'JSON fence',
      '```json\n{"tool":"get_weather","args":{"city":"Paris"}}\n```',
      ['get_weather'],
      'json_fence',
      [{ tool: 'get_weather', args: { city: 'Paris' } }]
    ],
    [
      'OpenAI-style JSON',
      '{"name":"get_weather","arguments":{"city":"NYC"}}',
      ['get_weather'],
      'json_fence',
      [{ tool: 'get_weather', args: { city: 'NYC' } }]
    ],
    [
      'embedded JSON',
      'Sure, let me try: {"tool":"get_weather","args":{"city":"X"}} ok?',
      ['get_weather'],
      'json_fence',
      [{ tool: 'get_weather', args: { city: 'X' } }]
    ],
    [
      'rehearsal',
      'get_weather[ARGS]{"city":"Paris"}',
      ['get_weather'],
      'rehearsal',
      [{ tool: 'get_weather', args: { city: 'Paris' } }]
    ],
    [
      'Qwen XML',
      '<function=get_weather><parameter=city>Paris</parameter></function>',
      ['get_weather'],
      'qwen_xml',
      [{ tool: 'get_weather', args: { city: 'Paris' } }]
    ],
    [
      'Mistral bracket',
      '[TOOL_CALLS]get_weather{"city":"Paris"}',
      ['get_weather'],
      'mistral_bracket',
      [{ tool: 'get_weather', args: { city: 'Paris' } }]
    ],
    [
      'multiple Mistral bracket',
      '[TOOL_CALLS]A{"x":1}[TOOL_CALLS]B{"y":2}',
      ['A', 'B'],
      'mistral_bracket',
      [
        { tool: 'A', args: { x: 1 } },
        { tool: 'B', args: { y: 2 } }
      ]
    ],
    [
      'nested braces in JSON string',
      '{"tool":"x","args":{"q":"hello {world}"}}',
      ['x'],
      'json_fence',
      [{ tool: 'x', args: { q: 'hello {world}' } }]
    ]
  ] as const)('rescues %s', (_name, input, tools, strategy, toolCalls) => {
    expect(rescueToolCall(input, tools)).toMatchObject({
      strategy,
      toolCalls
    });
  });

  it('extracts reasoning text before parsing tool calls', () => {
    expect(rescueToolCall('<think>let me</think>\n{"tool":"x","args":{}}', ['x'])).toEqual({
      strategy: 'json_fence',
      reasoningText: 'let me',
      toolCalls: [{ tool: 'x', args: {} }]
    });
  });

  it('parses structured Qwen XML parameter values when they contain JSON', () => {
    expect(
      rescueToolCall(
        '<function=propose_background_task><parameter=goal>检查测试</parameter><parameter=trigger>{"type":"manual","description":"手动"}</parameter></function>',
        ['propose_background_task']
      )
    ).toEqual({
      strategy: 'qwen_xml',
      reasoningText: null,
      toolCalls: [
        {
          tool: 'propose_background_task',
          args: {
            goal: '检查测试',
            trigger: {
              type: 'manual',
              description: '手动'
            }
          }
        }
      ]
    });
  });

  it('ignores unknown tool names and free text', () => {
    expect(rescueToolCall('{"tool":"unknown","args":{}}', ['x'])).toEqual({
      strategy: null,
      reasoningText: null,
      toolCalls: []
    });
    expect(rescueToolCall('Hello, I am thinking about it.', ['x'])).toEqual({
      strategy: null,
      reasoningText: null,
      toolCalls: []
    });
  });

  it('keeps reasoning when only thinking text exists', () => {
    expect(rescueToolCall('<think>thinking only</think>', ['x'])).toEqual({
      strategy: null,
      reasoningText: 'thinking only',
      toolCalls: []
    });
  });

  it('rescues bare argument JSON only when exactly one candidate accepts the args', () => {
    const candidates: RescueToolCandidate[] = [
      {
        name: 'internet_search',
        acceptsBareArgs: (args) => typeof args.query === 'string'
      },
      {
        name: 'web_read',
        acceptsBareArgs: (args) => typeof args.url === 'string'
      }
    ];

    expect(rescueToolCall('{"query":"agnes"}', candidates)).toEqual({
      strategy: 'bare_args_json',
      reasoningText: null,
      toolCalls: [{ tool: 'internet_search', args: { query: 'agnes' } }]
    });
  });

  it('does not rescue bare argument JSON when candidates are ambiguous', () => {
    const candidates: RescueToolCandidate[] = [
      {
        name: 'first_search',
        acceptsBareArgs: (args) => typeof args.query === 'string'
      },
      {
        name: 'second_search',
        acceptsBareArgs: (args) => typeof args.query === 'string'
      }
    ];

    expect(rescueToolCall('{"query":"agnes"}', candidates)).toEqual({
      strategy: null,
      reasoningText: null,
      toolCalls: []
    });
  });
});
