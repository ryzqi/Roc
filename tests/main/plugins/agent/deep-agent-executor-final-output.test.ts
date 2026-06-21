import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { tagForgeMessage } from '../../../../src/main/services/forge-guardrails';
import {
  buildExecutorOnce,
  collectExecutorEvents,
  createCapabilities,
  createControlledAsyncStream,
  createDeferred,
  createMcpTool,
  drainIterator,
  findTool,
  isChatRunEventBuffer,
  readBuildInput,
  readBuiltTools,
  readIteratorValue,
  readJson,
  startExecutorExecution,
  waitForPromise,
  workspacePath
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


  it('uses final ToolMessage content for tool block output when present', async () => {
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

    expect(events).toEqual([
      {
        type: 'assistant_block',
        runId: 'run-1',
        block: {
          kind: 'tool_call',
          blockId: 'tool-call-write',
          callId: 'call-write',
          name: 'write_file',
          phase: 'end',
          output: 'Successfully wrote to /workspace/hello.docx'
        }
      }
    ]);
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

