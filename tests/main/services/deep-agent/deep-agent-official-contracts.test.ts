import { describe, expect, it } from 'vitest';
import type {
  AsyncSubAgent,
  AsyncTaskStatus,
  CreateDeepAgentParams,
  SubagentRunStream
} from 'deepagents';
import { DEEP_AGENT_BUILT_IN_TOOLS } from '../../../../src/main/services/deep-agent/types';

describe('DeepAgents official contract assumptions', () => {
  it('accepts async subagents through CreateDeepAgentParams', () => {
    const asyncSubagent: AsyncSubAgent = {
      name: 'remote-research',
      description: 'Run long research on an Agent Protocol server.',
      graphId: 'research_graph',
      url: 'http://127.0.0.1:2024'
    };

    const params = {
      subagents: [asyncSubagent]
    } satisfies Pick<CreateDeepAgentParams, 'subagents'>;

    expect(params.subagents?.[0]).toMatchObject({
      name: 'remote-research',
      graphId: 'research_graph'
    });
  });

  it('locks async task statuses used by Roc event payloads', () => {
    const statuses: AsyncTaskStatus[] = [
      'pending',
      'running',
      'success',
      'error',
      'cancelled',
      'timeout',
      'interrupted'
    ];

    expect(statuses).toEqual([
      'pending',
      'running',
      'success',
      'error',
      'cancelled',
      'timeout',
      'interrupted'
    ]);
  });

  it('documents SubagentRunStream fields consumed by the projection layer', () => {
    type RequiredKeys = 'name' | 'taskInput' | 'output' | 'messages' | 'toolCalls' | 'subagents';
    const keys: RequiredKeys[] = ['name', 'taskInput', 'output', 'messages', 'toolCalls', 'subagents'];

    const assertKeys = (_keys: Array<keyof SubagentRunStream>): Array<keyof SubagentRunStream> => _keys;

    expect(assertKeys(keys)).toEqual(['name', 'taskInput', 'output', 'messages', 'toolCalls', 'subagents']);
  });

  it('keeps Roc built-in tool allowlist from exposing DeepAgents native execute', () => {
    expect(DEEP_AGENT_BUILT_IN_TOOLS).toEqual([
      'write_todos',
      'task',
      'ls',
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep'
    ]);
    expect(DEEP_AGENT_BUILT_IN_TOOLS).not.toContain('execute');
  });
});
