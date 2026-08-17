import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { tagForgeMessage } from '../../../../src/main/services/forge-guardrails';
import { createCapabilities } from './agent-capability-test-fixtures';
import { startExecutorExecution } from './deep-agent-executor-test-helpers';

describe('createAgentDeepAgentExecutor', () => {
  it('does not synthesize earlier assistant output when the final message is not assistant text', async () => {
    const execution = await startExecutorExecution({
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
    const firstEvent = execution.events[Symbol.asyncIterator]().next();

    await expect(firstEvent).rejects.toThrow('agent_model_response_empty');
    await expect(execution.outcome).rejects.toThrow('agent_model_response_empty');
  });


  it('does not backfill a tool block from final ToolMessage content', async () => {
    const execution = await startExecutorExecution({
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
    const firstEvent = execution.events[Symbol.asyncIterator]().next();

    await expect(firstEvent).rejects.toThrow('agent_model_response_empty');
    await expect(execution.outcome).rejects.toThrow('agent_model_response_empty');
  });


  it('does not emit final tool blocks for Forge tagged ToolMessage output', async () => {
    const execution = await startExecutorExecution({
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
    const firstEvent = execution.events[Symbol.asyncIterator]().next();

    await expect(firstEvent).rejects.toThrow('agent_model_response_empty');
    await expect(execution.outcome).rejects.toThrow('agent_model_response_empty');
  });
});

