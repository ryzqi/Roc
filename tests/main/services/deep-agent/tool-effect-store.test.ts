import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentToolEffectStore } from '../../../../src/main/services/deep-agent/tool-effect-store';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyAgentPluginSchema(db);
});

afterEach(() => {
  db.close();
});

describe('AgentToolEffectStore', () => {
  it('returns a stored successful result for the same tool call and input hash', () => {
    const store = new AgentToolEffectStore(db);
    store.start({
      runId: 'run_1',
      threadId: 'thread_1',
      toolCallId: 'call_1',
      toolName: 'run_shell_command',
      inputHash: 'hash_1'
    });
    store.finishSuccess({ runId: 'run_1', toolCallId: 'call_1', result: { ok: true } });

    expect(store.readReusable({ runId: 'run_1', toolCallId: 'call_1', inputHash: 'hash_1' })).toEqual({
      status: 'success',
      result: { ok: true }
    });
  });

  it('fails when the same tool call id has a different input hash', () => {
    const store = new AgentToolEffectStore(db);
    store.start({
      runId: 'run_1',
      threadId: 'thread_1',
      toolCallId: 'call_1',
      toolName: 'delete_file',
      inputHash: 'hash_1'
    });

    expect(() => store.readReusable({ runId: 'run_1', toolCallId: 'call_1', inputHash: 'hash_2' })).toThrow(
      'agent_tool_effect_input_drift'
    );
  });

  it('fails when a duplicate side effect is still in progress', () => {
    const store = new AgentToolEffectStore(db);
    store.start({
      runId: 'run_1',
      threadId: 'thread_1',
      toolCallId: 'call_1',
      toolName: 'delete_file',
      inputHash: 'hash_1'
    });

    expect(() => store.readReusable({ runId: 'run_1', toolCallId: 'call_1', inputHash: 'hash_1' })).toThrow(
      'agent_tool_effect_in_progress'
    );
  });
});
