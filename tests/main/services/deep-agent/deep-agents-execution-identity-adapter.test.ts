import { describe, expect, it } from 'vitest';

import packageJson from '../../../../package.json';
import { readDeepAgentsExecutionIdentity } from '../../../../src/main/services/deep-agent/deep-agents-execution-identity-adapter';

describe('Deep Agents execution identity adapter', () => {
  it('pins the vendor versions that own the configurable shape', () => {
    expect(packageJson.dependencies.deepagents).toBe('1.13.2');
    expect(packageJson.dependencies['@langchain/langgraph']).toBe('1.4.13');
  });

  it('translates root and subagent configurable identities', () => {
    expect(readDeepAgentsExecutionIdentity({
      ls_agent_type: 'root',
      checkpoint_ns: 'tools:call-root',
      checkpoint_map: { '': 'checkpoint-root' }
    })).toEqual({
      executionPath: 'main',
      checkpointId: 'checkpoint-root'
    });
    expect(readDeepAgentsExecutionIdentity({
      ls_agent_type: 'subagent',
      checkpoint_ns: 'tools:research|tools:call-child',
      checkpoint_map: { 'tools:research': 'checkpoint-child' }
    })).toEqual({
      executionPath: 'subagent/tools:research',
      checkpointId: 'checkpoint-child'
    });
  });

  it('rejects drifted or incomplete configurable shapes explicitly', () => {
    expect(readDeepAgentsExecutionIdentity({
      ls_agent_type: 'root',
      checkpoint_ns: 'tools:research|tools:call-child',
      checkpoint_map: { 'tools:research': 'checkpoint-child' }
    })).toBeNull();
    expect(readDeepAgentsExecutionIdentity({ checkpoint_ns: 'tools:call-root' })).toBeNull();
  });
});
