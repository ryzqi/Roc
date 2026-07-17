import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { tagForgeMessage } from '../../../../src/main/services/forge-guardrails';
import {
  collectExecutorEvents,
  createCapabilities
} from './deep-agent-executor-test-helpers';

describe('createAgentDeepAgentExecutor', () => {
  it('does not synthesize earlier assistant output when the final message is not assistant text', async () => {
    const events = await collectExecutorEvents({
      capabilities: createCapabilities([]),
      output: {
        messages: [
          {
            content: '历史回答',
            type: 'ai'
          },
          {
            content: '新的用户输入',
            type: 'human'
          }
        ]
      }
    });

    expect(events).toEqual([]);
  });


  it('does not backfill a tool block from final ToolMessage content', async () => {
    const events = await collectExecutorEvents({
      capabilities: createCapabilities([]),
      output: {
        messages: [
          new ToolMessage({
            content: 'Successfully wrote to /workspace/hello.docx',
            name: 'write_file',
            tool_call_id: 'call-write'
          })
        ]
      }
    });

    expect(events).toEqual([]);
  });


  it('does not emit final tool blocks for Forge tagged ToolMessage output', async () => {
    const events = await collectExecutorEvents({
      capabilities: createCapabilities([]),
      output: {
        messages: [
          tagForgeMessage(
            new ToolMessage({
              content: '[ToolResolutionError] Missing prerequisite.',
              name: 'web_search',
              tool_call_id: 'call-search'
            }),
            'forge:tool_resolution'
          )
        ]
      }
    });

    expect(events).toEqual([]);
  });
});

