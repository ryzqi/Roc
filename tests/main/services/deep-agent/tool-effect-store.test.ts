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
  it('does not create tool effect tables during construction', () => {
    const isolatedDb = new Database(':memory:');
    try {
      new AgentToolEffectStore(isolatedDb);

      expect(tableExists(isolatedDb, 'agent_tool_effects')).toBe(false);
    } finally {
      isolatedDb.close();
    }
  });

  it('returns a stored successful result for the same tool call and input hash', () => {
    const store = new AgentToolEffectStore(db);
    const identity = effectIdentity('main', 'checkpoint_1');
    store.start({
      ...identity,
      toolName: 'run_shell_command',
      effectClass: 'host_execution',
      reconcileStrategy: 'manual_confirmation'
    });
    store.finishSuccess({ ...identity, result: { ok: true } });

    expect(store.readReusable(identity)).toEqual({
      status: 'succeeded',
      result: { ok: true }
    });
  });

  it('fails when the same tool call id has a different input hash', () => {
    const store = new AgentToolEffectStore(db);
    const identity = effectIdentity('main', 'checkpoint_1');
    store.start({
      ...identity,
      toolName: 'delete_file',
      effectClass: 'workspace_mutation',
      reconcileStrategy: 'manual_confirmation'
    });

    expect(() => store.readReusable({ ...identity, inputHash: 'hash_2' })).toThrow(
      'agent_tool_effect_input_drift'
    );
  });

  it('fails when a duplicate side effect is still in progress', () => {
    const store = new AgentToolEffectStore(db);
    const identity = effectIdentity('main', 'checkpoint_1');
    store.start({
      ...identity,
      toolName: 'delete_file',
      effectClass: 'workspace_mutation',
      reconcileStrategy: 'manual_confirmation'
    });

    expect(() => store.readReusable(identity)).toThrow(
      'agent_tool_effect_in_progress'
    );
  });

  it('uses execution path and checkpoint identity for the effect key and exposes the full state machine', () => {
    const store = new AgentToolEffectStore(db);
    const first = effectIdentity('main', 'checkpoint_main');
    const nested = effectIdentity('subagent/research#0', 'checkpoint_nested');
    expect(store.readState(first)).toEqual({ status: 'not_started' });

    store.start({ ...first, toolName: 'run_shell_command', inputHash: 'hash_1', effectClass: 'host_execution', reconcileStrategy: 'manual_confirmation' });
    store.start({ ...nested, toolName: 'run_shell_command', inputHash: 'hash_1', effectClass: 'host_execution', reconcileStrategy: 'manual_confirmation' });
    expect(store.readState(first)).toEqual({ status: 'in_progress' });
    expect(store.readState(nested)).toEqual({ status: 'in_progress' });

    store.finishSuccess({ ...first, result: { ok: true } });
    store.finishError({ ...nested, error: new Error('transient'), retryable: true });
    expect(store.readReusable(first)).toEqual({ status: 'succeeded', result: { ok: true } });
    expect(store.readState(nested)).toEqual({ status: 'failed_retryable' });
    store.start({ ...nested, toolName: 'run_shell_command', inputHash: 'hash_1', effectClass: 'host_execution', reconcileStrategy: 'manual_confirmation' });
    expect(store.readState(nested)).toEqual({ status: 'in_progress' });
  });

  it('stores unknown effects and refuses blind reuse', () => {
    const store = new AgentToolEffectStore(db);
    const identity = effectIdentity('main', 'checkpoint_restart');
    store.start({ ...identity, toolName: 'delete_file', inputHash: 'hash_restart', effectClass: 'workspace_mutation', reconcileStrategy: 'manual_confirmation' });

    store.finishUnknown({ ...identity, error: new Error('result state cannot be confirmed') });

    expect(store.readState(identity)).toEqual({ status: 'unknown' });
    expect(() => store.readReusable({ ...identity, inputHash: 'hash_restart' })).toThrow(
      'agent_tool_effect_unknown_manual_confirmation'
    );
  });

  it('marks only in-progress effects as unknown during restart reconciliation', () => {
    const store = new AgentToolEffectStore(db);
    const inProgress = effectIdentity('main', 'checkpoint_in_progress');
    const completed = effectIdentity('main', 'checkpoint_completed');

    store.start({ ...inProgress, toolName: 'delete_file', effectClass: 'workspace_mutation', reconcileStrategy: 'manual_confirmation' });
    store.start({ ...completed, toolName: 'run_shell_command', effectClass: 'host_execution', reconcileStrategy: 'manual_confirmation' });
    store.finishSuccess({ ...completed, result: { ok: true } });

    expect(store.hasUnknown('run_1')).toBe(false);
    store.markRestartedUnknown('run_1');

    expect(store.hasUnknown('run_1')).toBe(true);
    expect(store.readState(inProgress)).toEqual({ status: 'unknown' });
    expect(store.readState(completed)).toEqual({ status: 'succeeded' });
  });

  it('deletes effects by thread and run through the owner API', () => {
    const store = new AgentToolEffectStore(db);
    const byThread = effectIdentity('main', 'checkpoint_thread');
    const byRun = {
      ...effectIdentity('subagent/research#0', 'checkpoint_run'),
      threadId: 'thread_orphan'
    };
    store.start({
      ...byThread,
      toolName: 'delete_file',
      effectClass: 'workspace_mutation',
      reconcileStrategy: 'manual_confirmation'
    });
    store.start({
      ...byRun,
      toolName: 'run_shell_command',
      effectClass: 'host_execution',
      reconcileStrategy: 'manual_confirmation'
    });

    expect(store.deleteForThread('thread_1')).toBe(1);
    expect(store.deleteForRunIds(['run_1'])).toBe(1);
    expect(store.readState(byThread)).toEqual({ status: 'not_started' });
    expect(store.readState(byRun)).toEqual({ status: 'not_started' });
  });
});

function effectIdentity(executionPath: string, checkpointId: string) {
  return {
    runId: 'run_1',
    threadId: 'thread_1',
    toolCallId: `call_${executionPath}`,
    executionPath,
    checkpointId,
    inputHash: 'hash_1'
  };
}

function tableExists(connection: Database.Database, tableName: string): boolean {
  const row = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
    | { name: string }
    | undefined;
  return row !== undefined;
}
