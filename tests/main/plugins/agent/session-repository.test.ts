import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentCapabilityPreview, AgentRuntimeStatus, ChatPersistedAttachment, ChatRunEvent, EnabledCapabilities, TaskKind, TaskStatus } from '../../../../src/shared/types';
import { buildAgentCapabilityPreview } from '../../../../src/main/plugins/agent/capability-preview';
import { agentRunEventLogMaxEvents, AgentRunEventLog } from '../../../../src/main/plugins/agent/run-event-log';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';
import { RocSqliteCheckpointer } from '../../../../src/main/services/deep-agent/sqlite-checkpointer';
import { AgentToolEffectStore } from '../../../../src/main/services/deep-agent/tool-effect-store';
import { createTerminalRunTelemetry, requireRunTelemetry } from './run-telemetry-test-helpers';

let db: Database.Database;

const enabledCapabilities: EnabledCapabilities = {
  mcpServers: ['filesystem'],
  skills: ['typescript']
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

describe('AgentSessionRepository', () => {
  it('applies the migrated agent tables with current column names', () => {
    applyAgentPluginSchema(db);

    expect(columnNames('agent_runs')).toContain('thread_id');
    expect(columnNames('agent_events')).toContain('run_id');
    expect(columnNames('agent_events')).toContain('payload_json');
    expect(columnNames('session_messages')).toContain('phase');
  });

  it('migrates a persisted V1 execution snapshot to the frozen V2 call budget', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Resume legacy run'
    });
    const current = repository.getRunExecutionSnapshot(run.id);
    const legacy = {
      ...current,
      schemaVersion: 1,
      budget: {
        contextBudgetTokens: current.budget.contextBudgetTokens
      }
    };
    db.prepare('UPDATE agent_runs SET snapshot_json = ?, snapshot_version = 1 WHERE id = ?')
      .run(JSON.stringify(legacy), run.id);

    expect(repository.getRunExecutionSnapshot(run.id)).toMatchObject({
      schemaVersion: 2,
      budget: {
        contextBudgetTokens: null,
        modelCallLimit: 20,
        modelThreadCallLimit: 100,
        toolCallLimit: 40,
        toolThreadCallLimit: 200
      }
    });
  });

  it('composes replaceable checkpoint, tool-effect, and run-event owners', () => {
    applyAgentPluginSchema(db);
    const checkpointThreads: string[] = [];
    const restartedEffectRuns: string[] = [];
    const recordedEvents: ChatRunEvent[] = [];
    const repository = new AgentSessionRepository(db, {
      checkpointer: {
        hasCheckpoint(threadId) {
          checkpointThreads.push(threadId);
          return false;
        },
        readPendingInterrupts() {
          return null;
        }
      },
      toolEffectStore: {
        hasUnknown() {
          return false;
        },
        markRestartedUnknown(runId) {
          restartedEffectRuns.push(runId);
        }
      },
      runEventLog: {
        recordRunEvent(event, createdAt = '2026-07-17T00:00:00.000Z') {
          recordedEvents.push(event);
          return {
            runId: event.runId,
            sequence: recordedEvents.length,
            event,
            createdAt
          };
        }
      }
    });
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Use owner interfaces during restart reconciliation'
    });

    expect(repository.reconcileStartupRuns()).toEqual([
      expect.objectContaining({ id: run.id, status: 'interrupted' })
    ]);
    expect(checkpointThreads).toEqual([run.threadId]);
    expect(restartedEffectRuns).toEqual([run.id]);
    expect(recordedEvents.map((event) => event.type)).toEqual(['run_started', 'run_failed']);
  });

  it('reads and writes agent threads, agent runs, agent events, and session messages', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);

    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Summarize this workspace'
    });
    const event = repository.recordEvent({
      payload: {
        kind: 'text',
        blockId: `text-${run.id}`,
        phase: 'delta',
        text: 'Working'
      },
      runId: run.id,
      threadId: run.threadId,
      type: 'assistant_block'
    });
    const message = repository.recordSessionMessage({
      content: 'Compaction note',
      phase: 'pre_compaction_flush',
      role: 'system',
      threadId: run.threadId,
      tokenCount: 12
    });

    expect(repository.getRun(run.id)).toEqual(run);
    const events = repository.listThreadEvents(run.threadId);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      payload: {
        content: 'Summarize this workspace',
        enabledCapabilities,
        role: 'user'
      },
      runId: run.id,
      threadId: run.threadId,
      type: 'message'
    });
    expect(events[1]).toMatchObject({
      runId: run.id,
      threadId: run.threadId,
      type: 'context_manifest',
      payload: expect.objectContaining({
        manifest: expect.objectContaining({
          manifestHash: expect.any(String),
          schemaVersion: 1
        }),
        requestedCapabilities: enabledCapabilities,
        resolvedCapabilities: enabledCapabilities
      })
    });
    expect(events[2]).toMatchObject({
      runId: run.id,
      threadId: run.threadId,
      type: 'agent_update',
      payload: {
        status: 'running',
        providerId: 'test-provider',
        modelId: 'openai:gpt-4.1'
      }
    });
    expect(events[3]).toEqual(event);
    expect(
      db.prepare('SELECT next_sequence FROM agent_thread_event_cursors WHERE thread_id = ?').get(run.threadId)
    ).toEqual({ next_sequence: 5 });
    expect(
      db
        .prepare('SELECT sequence, event_json FROM agent_run_events WHERE run_id = ?')
        .all(run.id)
    ).toEqual([
      {
        sequence: 1,
        event_json: JSON.stringify({
          type: 'run_started',
          runId: run.id,
          mode: 'run',
          threadId: run.threadId,
          providerId: 'test-provider',
          modelId: 'openai:gpt-4.1',
          createdAt: run.startedAt
        })
      }
    ]);
    expect(repository.listSessionMessages({ threadId: run.threadId })).toEqual([message]);
    expect(rawRow('agent_runs', run.id)).toMatchObject({
      enabled_capabilities_json: JSON.stringify(enabledCapabilities),
      model_id: 'openai:gpt-4.1',
      provider_id: 'test-provider',
      snapshot_version: 2,
      thread_id: run.threadId
    });
    expect(rawRow('agent_events', event.id)).toMatchObject({
      payload_json: JSON.stringify({
        kind: 'text',
        blockId: `text-${run.id}`,
        phase: 'delta',
        text: 'Working'
      }),
      run_id: run.id,
      thread_id: run.threadId
    });
    expect(rawRow('session_messages', message.id)).toMatchObject({
      phase: 'pre_compaction_flush',
      thread_id: run.threadId,
      token_count: 12
    });
  });

  it('marks interrupted runs waiting for the user while persisting only interrupt UI data', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Review a pending command'
    });

    const interruptedRun = repository.markRunInterrupted({
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      runId: run.id,
      telemetry: requireRunTelemetry(repository, run),
      threadId: run.threadId,
      interrupts: [
        {
          interruptId: 'interrupt_repository_1',
          payload: {
            kind: 'approval',
            request: {
              actionRequests: [
                {
                  name: 'run_shell_command',
                  args: {
                    command: 'git status'
                  }
                }
              ],
              reviewConfigs: [
                {
                  actionName: 'run_shell_command',
                  allowedDecisions: ['approve', 'reject']
                }
              ]
            }
          }
        },
        {
          interruptId: 'interrupt_repository_2',
          payload: {
            kind: 'question',
            question: 'Which workspace?'
          }
        }
      ]
    });

    expect(interruptedRun.run.status).toBe('waiting_user');
    expect(interruptedRun.events.map((event) => event.type)).toEqual([
      'approval_requested',
      'human_question_requested'
    ]);
    expect(repository.getRunTransitionState(run.id)).toEqual({ stateVersion: 2, status: 'waiting_user' });
    expect(readPendingInterrupts(repository, run)).toEqual({
      runId: run.id,
      threadId: run.threadId,
      interrupts: [
        {
          interruptId: 'interrupt_repository_1',
          payload: {
            kind: 'approval',
            request: {
              actionRequests: [
                {
                  name: 'run_shell_command',
                  args: {
                    command: 'git status'
                  }
                }
              ],
              reviewConfigs: [
                {
                  actionName: 'run_shell_command',
                  allowedDecisions: ['approve', 'reject']
                }
              ]
            }
          }
        },
        {
          interruptId: 'interrupt_repository_2',
          payload: {
            kind: 'question',
            question: 'Which workspace?'
          }
        }
      ]
    });

    const firstDispatch = repository.beginResumeDispatch({
      expectedStateVersion: 2,
      expectedStatus: 'waiting_user',
      interruptId: 'interrupt_repository_1',
      runId: run.id
    });

    expect(firstDispatch.run).toMatchObject({ status: 'dispatch_pending' });
    expect(readPendingInterrupts(repository, run).interrupts).toHaveLength(2);

    const rolledBack = repository.rollbackResumeDispatch({
      expectedStateVersion: firstDispatch.stateVersion,
      expectedStatus: 'dispatch_pending',
      runId: run.id
    });

    expect(rolledBack.run).toMatchObject({ status: 'waiting_user' });
    expect(readPendingInterrupts(repository, run).interrupts).toHaveLength(2);

    const secondDispatch = repository.beginResumeDispatch({
      expectedStateVersion: rolledBack.stateVersion,
      expectedStatus: 'waiting_user',
      interruptId: 'interrupt_repository_1',
      runId: run.id
    });
    const resumed = repository.commitResumeDispatch({
      audit: {
        type: 'approval_decision',
        payload: {
          interruptId: 'interrupt_repository_1',
          decisions: [{ type: 'approve' }]
        }
      },
      expectedStateVersion: secondDispatch.stateVersion,
      expectedStatus: 'dispatch_pending',
      interruptId: 'interrupt_repository_1',
      runId: run.id
    });

    expect(resumed.run).toMatchObject({ status: 'running' });
    expect(repository.getRunTransitionState(run.id)).toEqual({ stateVersion: 6, status: 'running' });
    expect(readPendingInterrupts(repository, run).interrupts).toEqual([
      {
        interruptId: 'interrupt_repository_2',
        payload: {
          kind: 'question',
          question: 'Which workspace?'
        }
      }
    ]);
  });

  it('rolls back the waiting-user transition when telemetry persistence fails', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Keep interruption state atomic'
    });
    db.exec(`
      CREATE TRIGGER reject_agent_run_telemetry_update
      BEFORE UPDATE ON agent_run_telemetry
      BEGIN
        SELECT RAISE(ABORT, 'forced_telemetry_update_failure');
      END
    `);

    expect(() =>
      repository.markRunInterrupted({
        expectedStateVersion: 1,
        expectedStatus: 'waiting_next_turn',
        interrupts: [
          {
            interruptId: 'interrupt_atomic_telemetry',
            payload: {
              kind: 'question',
              question: 'Continue?'
            }
          }
        ],
        runId: run.id,
        telemetry: requireRunTelemetry(repository, run),
        threadId: run.threadId
      })
    ).toThrow('forced_telemetry_update_failure');
    expect(repository.getRunTransitionState(run.id)).toEqual({
      stateVersion: 1,
      status: 'waiting_next_turn'
    });
    expect(readPendingInterrupts(repository, run).interrupts).toEqual([]);
  });

  it('rebuilds a missing projection from the current checkpoint after a partial resume crash', async () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Recover the remaining question'
    });
    repository.markRunInterrupted({
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      runId: run.id,
      telemetry: requireRunTelemetry(repository, run),
      threadId: run.threadId,
      interrupts: [
        {
          interruptId: 'interrupt_partial_first',
          payload: {
            kind: 'question',
            question: 'First answer?'
          }
        },
        {
          interruptId: 'interrupt_partial_remaining',
          payload: {
            kind: 'question',
            question: 'Remaining answer?'
          }
        }
      ]
    });
    const dispatch = repository.beginResumeDispatch({
      expectedStateVersion: repository.getRunTransitionState(run.id).stateVersion,
      expectedStatus: 'waiting_user',
      interruptId: 'interrupt_partial_first',
      runId: run.id
    });
    repository.commitResumeDispatch({
      audit: {
        type: 'human_question_answered',
        payload: {
          interruptId: 'interrupt_partial_first',
          answer: 'First answer'
        },
        sessionMessage: {
          content: 'First answer',
          workspaceHash: null
        }
      },
      expectedStateVersion: dispatch.stateVersion,
      expectedStatus: 'dispatch_pending',
      interruptId: 'interrupt_partial_first',
      runId: run.id
    });
    await seedCheckpoint(run.threadId, [
      {
        id: 'interrupt_partial_first',
        payload: { kind: 'question', question: 'First answer?' }
      },
      {
        id: 'interrupt_partial_remaining',
        payload: { kind: 'question', question: 'Remaining answer?' }
      }
    ]);
    repository.clearPendingInterrupts(run.id);

    repository.reconcileStartupRuns();

    expect(repository.getRunTransitionState(run.id)).toEqual({
      stateVersion: 5,
      status: 'waiting_user'
    });
    expect(readPendingInterrupts(repository, run).interrupts).toEqual([
      {
        interruptId: 'interrupt_partial_remaining',
        payload: {
          kind: 'question',
          question: 'Remaining answer?'
        }
      }
    ]);
  });

  it('rebuilds an incomplete projection when no durable resume audit answers the missing interrupt', async () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Recover every unanswered interrupt'
    });
    const interrupts = [
      { interruptId: 'interrupt-incomplete-first', payload: { kind: 'question' as const, question: 'First answer?' } },
      { interruptId: 'interrupt-incomplete-second', payload: { kind: 'question' as const, question: 'Second answer?' } }
    ];
    repository.markRunInterrupted({
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      runId: run.id,
      telemetry: requireRunTelemetry(repository, run),
      threadId: run.threadId,
      interrupts
    });
    await seedCheckpoint(run.threadId, interrupts.map((interrupt) => ({ id: interrupt.interruptId, payload: interrupt.payload })));
    db.prepare('DELETE FROM agent_pending_interrupts WHERE run_id = ? AND interrupt_id = ?')
      .run(run.id, 'interrupt-incomplete-second');

    repository.reconcileStartupRuns();

    expect(readPendingInterrupts(repository, run).interrupts).toEqual(interrupts);
  });

  it('rejects a corrupt persisted interrupt payload explicitly', async () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Validate stored interrupt payload'
    });
    repository.markRunInterrupted({
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      runId: run.id,
      telemetry: requireRunTelemetry(repository, run),
      threadId: run.threadId,
      interrupts: [{ interruptId: 'interrupt-corrupt', payload: { kind: 'question', question: 'Continue?' } }]
    });
    db.prepare('UPDATE agent_pending_interrupts SET payload_json = ? WHERE run_id = ?')
      .run('{"kind":"approval"}', run.id);

    expect(() => readPendingInterrupts(repository, run)).toThrow('agent_pending_interrupt_payload_invalid');
    await seedCheckpoint(run.threadId, [
      {
        id: 'interrupt-corrupt',
        payload: { kind: 'question', question: 'Continue?' }
      }
    ]);

    expect(() => repository.reconcileStartupRuns()).toThrow('agent_pending_interrupt_payload_invalid');
    expect(() => readPendingInterrupts(repository, run)).toThrow('agent_pending_interrupt_payload_invalid');
  });

  it('rolls back question audit and session message writes as one resume transaction', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Answer transactionally'
    });
    repository.markRunInterrupted({
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      runId: run.id,
      telemetry: requireRunTelemetry(repository, run),
      threadId: run.threadId,
      interrupts: [
        {
          interruptId: 'interrupt_question_transaction',
          payload: {
            kind: 'question',
            question: 'Transaction question?'
          }
        }
      ]
    });
    const dispatch = repository.beginResumeDispatch({
      expectedStateVersion: repository.getRunTransitionState(run.id).stateVersion,
      expectedStatus: 'waiting_user',
      interruptId: 'interrupt_question_transaction',
      runId: run.id
    });
    db.exec(`
      CREATE TRIGGER fail_resume_question_session_message
      BEFORE INSERT ON session_messages
      BEGIN
        SELECT RAISE(ABORT, 'resume_question_session_message_failed');
      END;
    `);

    expect(() =>
      repository.commitResumeDispatch({
        audit: {
          type: 'human_question_answered',
          payload: {
            interruptId: 'interrupt_question_transaction',
            answer: 'Must not persist'
          },
          sessionMessage: {
            content: 'Must not persist',
            workspaceHash: null
          }
        },
        expectedStateVersion: dispatch.stateVersion,
        expectedStatus: 'dispatch_pending',
        interruptId: 'interrupt_question_transaction',
        runId: run.id
      })
    ).toThrow('resume_question_session_message_failed');

    expect(repository.getRunTransitionState(run.id)).toEqual({
      stateVersion: dispatch.stateVersion,
      status: 'dispatch_pending'
    });
    expect(readPendingInterrupts(repository, run).interrupts).toEqual([
      {
        interruptId: 'interrupt_question_transaction',
        payload: {
          kind: 'question',
          question: 'Transaction question?'
        }
      }
    ]);
    expect(repository.listSessionMessages({ threadId: run.threadId }).map((message) => message.content)).toEqual([]);
    expect(repository.listThreadEvents(run.threadId).some((event) => event.type === 'human_question_answered')).toBe(false);
    expect(
      repository.listThreadEvents(run.threadId).some((event) => {
        return (
          event.type === 'message' &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          Reflect.get(event.payload, 'content') === 'Must not persist'
        );
      })
    ).toBe(false);
  });

  it('does not restore a stale waiting projection when the latest checkpoint has no interrupt', async () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Do not restore stale projection'
    });
    repository.markRunInterrupted({
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      runId: run.id,
      telemetry: requireRunTelemetry(repository, run),
      threadId: run.threadId,
      interrupts: [
        {
          interruptId: 'interrupt_stale_projection',
          payload: {
            kind: 'question',
            question: 'Stale?'
          }
        }
      ]
    });
    await seedCheckpoint(run.threadId);
    await seedCheckpoint(run.threadId, [], 'checkpoint_restart_reconcile_z');

    repository.reconcileStartupRuns();

    expect(repository.getRun(run.id).status).toBe('interrupted');
  });

  it('orders question resume message and audit events after the requested event', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Record question order'
    });
    repository.markRunInterrupted({
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      runId: run.id,
      telemetry: requireRunTelemetry(repository, run),
      threadId: run.threadId,
      interrupts: [
        {
          interruptId: 'interrupt_question_order',
          payload: {
            kind: 'question',
            question: 'Order question?'
          }
        }
      ]
    });
    const dispatch = repository.beginResumeDispatch({
      expectedStateVersion: repository.getRunTransitionState(run.id).stateVersion,
      expectedStatus: 'waiting_user',
      interruptId: 'interrupt_question_order',
      runId: run.id
    });
    repository.commitResumeDispatch({
      audit: {
        type: 'human_question_answered',
        payload: {
          interruptId: 'interrupt_question_order',
          answer: 'Ordered answer'
        },
        sessionMessage: {
          content: 'Ordered answer',
          workspaceHash: null
        }
      },
      expectedStateVersion: dispatch.stateVersion,
      expectedStatus: 'dispatch_pending',
      interruptId: 'interrupt_question_order',
      runId: run.id
    });

    const runEvents = repository.listThreadEvents(run.threadId).filter((event) => event.runId === run.id);
    expect(runEvents.slice(-3).map((event) => event.type)).toEqual([
      'human_question_requested',
      'message',
      'human_question_answered'
    ]);
    expect(repository.listSessionMessages({ threadId: run.threadId }).map((message) => message.content)).toEqual([
      'Ordered answer'
    ]);
  });

  it('applies run status transitions with status and state-version CAS', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Transition this run'
    });

    const transitioned = repository.transitionRun({
      endedAt: null,
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      runId: run.id,
      status: 'running'
    });

    expect(transitioned.run.status).toBe('running');
    expect(transitioned.stateVersion).toBe(2);
    expect(() =>
      repository.transitionRun({
        endedAt: '2026-07-17T00:00:00.000Z',
        expectedStateVersion: 1,
        expectedStatus: 'waiting_next_turn',
        runId: run.id,
        status: 'completed'
      })
    ).toThrowError(expect.objectContaining({ code: 'agent_run_transition_conflict' }));
    expect(() =>
      repository.transitionRun({
        endedAt: null,
        expectedStateVersion: 2,
        expectedStatus: 'running',
        runId: run.id,
        status: 'waiting_next_turn'
      })
    ).toThrowError(expect.objectContaining({ code: 'agent_run_transition_invalid' }));
  });

  it('atomically records a completed run, its terminal timeline, and its task outbox event', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Complete this run atomically'
    });

    const terminal = repository.completeRunAtomically({
      assistantMessage: 'Completed answer',
      durationMs: 42,
      endedAt: '2026-07-17T01:00:00.000Z',
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      modelId: 'openai:gpt-4.1',
      providerId: 'test-provider',
      runId: run.id,
      runStartedAt: run.startedAt,
      summary: 'Completed summary',
      telemetry: createTerminalRunTelemetry({
        repository,
        run,
        terminal: {
          status: 'completed',
          durationMs: 42,
          errorCode: null,
          retryable: null,
          cancelSource: null
        }
      }),
      workspaceHash: 'workspace_hash_terminal'
    });

    expect(terminal.run.status).toBe('completed');
    expect(terminal.stateVersion).toBe(2);
    expect(terminal.message).toMatchObject({
      content: 'Completed answer',
      role: 'assistant',
      threadId: run.threadId,
      workspaceHash: 'workspace_hash_terminal'
    });
    expect(terminal.event).toMatchObject({
      runId: run.id,
      threadId: run.threadId,
      type: 'message',
      payload: {
        role: 'assistant',
        content: 'Completed answer',
        providerId: 'test-provider',
        modelId: 'openai:gpt-4.1'
      }
    });
    expect(
      db.prepare('SELECT run_id, thread_id, event_type, payload_json FROM agent_outbox WHERE run_id = ?').all(run.id)
    ).toEqual([
      {
        run_id: run.id,
        thread_id: run.threadId,
        event_type: 'run_completed',
        payload_json: JSON.stringify({
          assistantMessage: 'Completed answer',
          durationMs: 42,
          finishReason: 'stop',
          modelId: 'openai:gpt-4.1',
          providerId: 'test-provider',
          summary: 'Completed summary'
        })
      }
    ]);
    expect(
      db.prepare('SELECT sequence, event_json FROM agent_run_events WHERE run_id = ? ORDER BY sequence').all(run.id)
    ).toHaveLength(2);
    expect(db.prepare('SELECT * FROM agent_run_leases WHERE run_id = ?').get(run.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM agent_pending_interrupts WHERE run_id = ?').get(run.id)).toBeUndefined();
  });

  it('rejects terminal telemetry whose frozen correlation differs from the run snapshot', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Reject mismatched terminal telemetry'
    });
    const telemetry = createTerminalRunTelemetry({
      repository,
      run,
      terminal: {
        status: 'completed',
        durationMs: 42,
        errorCode: null,
        retryable: null,
        cancelSource: null
      }
    });
    telemetry.correlation.manifestHash = 'tampered-manifest-hash';

    expect(() =>
      repository.completeRunAtomically({
        assistantMessage: 'Must not persist',
        durationMs: 42,
        endedAt: '2026-07-17T01:00:00.000Z',
        expectedStateVersion: 1,
        expectedStatus: 'waiting_next_turn',
        modelId: 'openai:gpt-4.1',
        providerId: 'test-provider',
        runId: run.id,
        runStartedAt: run.startedAt,
        summary: 'Must not persist',
        telemetry,
        workspaceHash: null
      })
    ).toThrow('agent_run_telemetry_identity_mismatch');
    expect(repository.getRun(run.id).status).toBe('waiting_next_turn');
  });

  it('rejects persisted telemetry whose frozen correlation differs from the run snapshot', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Reject mismatched persisted telemetry'
    });
    const telemetry = repository.getRunTelemetry(run.id);
    if (telemetry === null) {
      throw new Error('test_agent_run_telemetry_missing');
    }
    const mutations = [
      (candidate: typeof telemetry) => {
        candidate.correlation.threadId = 'thread_tampered';
      },
      (candidate: typeof telemetry) => {
        candidate.correlation.manifestHash = 'manifest_tampered';
      },
      (candidate: typeof telemetry) => {
        candidate.correlation.providerId = 'provider_tampered';
      },
      (candidate: typeof telemetry) => {
        candidate.correlation.modelId = 'model_tampered';
      }
    ];

    for (const mutate of mutations) {
      const candidate = structuredClone(telemetry);
      mutate(candidate);
      db.prepare('UPDATE agent_run_telemetry SET telemetry_json = ? WHERE run_id = ?').run(
        JSON.stringify(candidate),
        run.id
      );

      expect(() => repository.getRunTelemetry(run.id)).toThrow('agent_run_telemetry_identity_mismatch');
    }
  });

  it('does not overwrite corrupt telemetry while committing a terminal run', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Preserve corrupt telemetry evidence'
    });
    const telemetry = createTerminalRunTelemetry({
      repository,
      run,
      terminal: {
        status: 'completed',
        durationMs: 42,
        errorCode: null,
        retryable: null,
        cancelSource: null
      }
    });
    db.prepare('UPDATE agent_run_telemetry SET telemetry_json = ? WHERE run_id = ?').run('{not-json', run.id);

    expect(() =>
      repository.completeRunAtomically({
        assistantMessage: 'Must not persist',
        durationMs: 42,
        endedAt: '2026-07-17T01:00:00.000Z',
        expectedStateVersion: 1,
        expectedStatus: 'waiting_next_turn',
        modelId: 'openai:gpt-4.1',
        providerId: 'test-provider',
        runId: run.id,
        runStartedAt: run.startedAt,
        summary: 'Must not persist',
        telemetry,
        workspaceHash: null
      })
    ).toThrow('agent_run_telemetry_corrupt');
    expect(repository.getRun(run.id).status).toBe('waiting_next_turn');
    expect(
      db.prepare('SELECT telemetry_json FROM agent_run_telemetry WHERE run_id = ?').pluck().get(run.id)
    ).toBe('{not-json');
  });

  it('trims the oldest timeline event before accepting more streamed events', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Reserve the terminal timeline slot'
    });
    const log = new AgentRunEventLog(db);
    for (let index = 0; index < agentRunEventLogMaxEvents - 2; index += 1) {
      log.recordRunEvent({
        type: 'assistant_block',
        runId: run.id,
        block: {
          kind: 'text',
          blockId: `text-${index}`,
          phase: 'delta',
          text: String(index)
        }
      });
    }

    log.recordRunEvent({
      type: 'assistant_block',
      runId: run.id,
      block: {
        kind: 'text',
        blockId: 'text-overflow',
        phase: 'delta',
        text: 'overflow'
      }
    });

    repository.completeRunAtomically({
      assistantMessage: 'Terminal answer',
      durationMs: 42,
      endedAt: '2026-07-17T01:00:00.000Z',
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      modelId: 'openai:gpt-4.1',
      providerId: 'test-provider',
      runId: run.id,
      runStartedAt: run.startedAt,
      summary: 'Terminal answer',
      telemetry: createTerminalRunTelemetry({
        repository,
        run,
        terminal: {
          status: 'completed',
          durationMs: 42,
          errorCode: null,
          retryable: null,
          cancelSource: null
        }
      }),
      workspaceHash: null
    });

    expect(
      db.prepare('SELECT sequence, event_json FROM agent_run_events WHERE run_id = ? ORDER BY sequence ASC').all(run.id)
    ).toHaveLength(agentRunEventLogMaxEvents);
    expect(
      db.prepare('SELECT sequence, event_json FROM agent_run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1').get(run.id)
    ).toEqual({
      sequence: agentRunEventLogMaxEvents + 1,
      event_json: expect.stringContaining('run_completed')
    });
  });

  it('atomically records a failed run, its terminal timeline, and its task outbox event', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Fail this run atomically'
    });

    const terminal = repository.failRunAtomically({
      code: 'provider_unavailable',
      diagnostic: {
        toolName: 'web_read'
      },
      endedAt: '2026-07-17T01:00:00.000Z',
      error: 'Provider is unavailable',
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      modelId: 'openai:gpt-4.1',
      providerId: 'test-provider',
      retryable: true,
      runId: run.id,
      suggestion: 'Check the provider connection.',
      telemetry: createTerminalRunTelemetry({
        repository,
        run,
        terminal: {
          status: 'failed',
          durationMs: 42,
          errorCode: 'provider_unavailable',
          retryable: true,
          cancelSource: null
        }
      })
    });

    expect(terminal.run.status).toBe('failed');
    expect(terminal.stateVersion).toBe(2);
    expect(terminal.event).toMatchObject({
      runId: run.id,
      threadId: run.threadId,
      type: 'error',
      payload: {
        code: 'provider_unavailable',
        diagnostic: {
          toolName: 'web_read'
        },
        error: 'Provider is unavailable',
        retryable: true,
        suggestion: 'Check the provider connection.'
      }
    });
    expect(
      db.prepare('SELECT run_id, thread_id, event_type, payload_json FROM agent_outbox WHERE run_id = ?').all(run.id)
    ).toEqual([
      {
        run_id: run.id,
        thread_id: run.threadId,
        event_type: 'run_failed',
        payload_json: JSON.stringify({
          code: 'provider_unavailable',
          error: 'Provider is unavailable',
          modelId: 'openai:gpt-4.1',
          providerId: 'test-provider',
          retryable: true,
          diagnostic: {
            toolName: 'web_read'
          },
          suggestion: 'Check the provider connection.'
        })
      }
    ]);
    expect(
      db.prepare('SELECT sequence, event_json FROM agent_run_events WHERE run_id = ? ORDER BY sequence').all(run.id)
    ).toHaveLength(2);
    expect(db.prepare('SELECT * FROM agent_run_leases WHERE run_id = ?').get(run.id)).toBeUndefined();
  });

  it('rejects a second active run for one thread', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const first = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'First active run'
    });

    expect(() =>
      createRun(repository, {
        enabledCapabilities,
        modelId: 'openai:gpt-4.1',
        threadId: first.threadId,
        threadKind: 'chat',
        userInput: 'Second active run'
      })
    ).toThrowError(expect.objectContaining({ code: 'thread_run_conflict' }));
  });

  it('reconciles interrupted startup runs into durable terminal records without replaying them', async () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const waitingNextTurn = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Restart before dispatch'
    });
    const dispatchPending = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Restart while pending dispatch'
    });
    const running = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Restart while running'
    });
    const recovering = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Restart while recovering'
    });
    const waitingUser = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Wait for explicit approval'
    });
    const resumeDispatchPending = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Restart while dispatching a resume'
    });

    transitionRun(repository, dispatchPending.id, 'dispatch_pending');
    transitionRun(repository, running.id, 'running');
    transitionRun(repository, recovering.id, 'recovering');
    const waitingUserState = repository.getRunTransitionState(waitingUser.id);
    repository.markRunInterrupted({
      expectedStateVersion: waitingUserState.stateVersion,
      expectedStatus: waitingUserState.status,
      runId: waitingUser.id,
      telemetry: requireRunTelemetry(repository, waitingUser),
      threadId: waitingUser.threadId,
      interrupts: [
        {
          interruptId: 'interrupt_restart_reconcile',
          payload: {
            kind: 'approval',
            request: {
              actionRequests: [],
              reviewConfigs: []
            }
          }
        }
      ]
    });
    const resumeWaitingState = repository.getRunTransitionState(resumeDispatchPending.id);
    repository.markRunInterrupted({
      expectedStateVersion: resumeWaitingState.stateVersion,
      expectedStatus: resumeWaitingState.status,
      runId: resumeDispatchPending.id,
      telemetry: requireRunTelemetry(repository, resumeDispatchPending),
      threadId: resumeDispatchPending.threadId,
      interrupts: [
        {
          interruptId: 'interrupt_resume_dispatch_restart',
          payload: {
            kind: 'question',
            question: 'Resume after restart?'
          }
        }
      ]
    });
    const resumeDispatchState = repository.getRunTransitionState(resumeDispatchPending.id);
    repository.beginResumeDispatch({
      expectedStateVersion: resumeDispatchState.stateVersion,
      expectedStatus: resumeDispatchState.status,
      interruptId: 'interrupt_resume_dispatch_restart',
      runId: resumeDispatchPending.id
    });
    for (const run of [waitingNextTurn, dispatchPending, running, recovering]) {
      await seedCheckpoint(run.threadId);
    }
    await seedCheckpoint(waitingUser.threadId, [
      {
        id: 'interrupt_restart_reconcile',
        payload: { kind: 'question', question: 'Resume after restart?' }
      }
    ]);
    await seedCheckpoint(resumeDispatchPending.threadId, [
      {
        id: 'interrupt_resume_dispatch_restart',
        payload: { kind: 'question', question: 'Resume after restart?' }
      }
    ]);

    new AgentToolEffectStore(db).start({
      runId: running.id,
      threadId: running.threadId,
      executionPath: 'main',
      checkpointId: 'checkpoint_restart',
      toolCallId: 'call_inflight_restart',
      toolName: 'run_shell_command',
      inputHash: 'input_hash_restart',
      effectClass: 'host_execution',
      reconcileStrategy: 'manual_confirmation'
    });

    repository.reconcileStartupRuns();

    for (const run of [waitingNextTurn, dispatchPending, running, recovering]) {
      expect(repository.getRun(run.id)).toMatchObject({
        status: 'interrupted',
        endedAt: expect.any(String)
      });
      expect(repository.getRunTelemetry(run.id)).toMatchObject({
        terminal: {
          status: 'interrupted'
        }
      });
      expect(db.prepare('SELECT run_id FROM agent_run_leases WHERE run_id = ?').get(run.id)).toBeUndefined();
      expect(
        db.prepare('SELECT sequence, event_json FROM agent_run_events WHERE run_id = ? ORDER BY sequence ASC').all(run.id)
      ).toEqual([
        expect.objectContaining({ sequence: 1 }),
        expect.objectContaining({
          sequence: 2,
          event_json: expect.stringContaining('agent_run_interrupted_on_restart')
        })
      ]);
    }
    expect(
      db.prepare('SELECT event_json FROM agent_run_events WHERE run_id = ? AND sequence = 2').get(running.id)
    ).toEqual({ event_json: expect.stringContaining('agent_run_interrupted_on_restart_effect_unknown') });
    expect(db.prepare('SELECT status FROM agent_tool_effects WHERE run_id = ?').get(running.id)).toEqual({
      status: 'unknown'
    });
    expect(repository.getRunTransitionState(waitingNextTurn.id).stateVersion).toBe(2);
    expect(repository.getRunTransitionState(dispatchPending.id).stateVersion).toBe(3);
    expect(repository.getRunTransitionState(running.id).stateVersion).toBe(3);
    expect(repository.getRunTransitionState(recovering.id).stateVersion).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_outbox WHERE event_type = 'run_failed'").get()).toEqual({ count: 4 });
    expect(repository.getRun(waitingUser.id).status).toBe('waiting_user');
    expect(readPendingInterrupts(repository, waitingUser)).toMatchObject({
      interrupts: [{ interruptId: 'interrupt_restart_reconcile' }]
    });
    expect(repository.getRunTransitionState(resumeDispatchPending.id)).toEqual({
      stateVersion: 4,
      status: 'waiting_user'
    });
    expect(readPendingInterrupts(repository, resumeDispatchPending)).toMatchObject({
      interrupts: [{ interruptId: 'interrupt_resume_dispatch_restart' }]
    });

    repository.reconcileStartupRuns();

    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_outbox WHERE event_type = 'run_failed'").get()).toEqual({ count: 4 });
  });

  it('quarantines a corrupt execution snapshot without reusing it for a run', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Recover this run'
    });
    db.prepare('UPDATE agent_runs SET snapshot_json = ? WHERE id = ?').run('{not-json', run.id);

    expect(() => repository.getRunExecutionSnapshot(run.id)).toThrow('run_execution_snapshot_json_invalid');
    expect(repository.getRun(run.id).status).toBe('interrupted');
    expect(rawRow('agent_runs', run.id)).toMatchObject({
      snapshot_error_code: 'run_execution_snapshot_json_invalid'
    });
    expect(repository.listThreadEvents(run.threadId)).toContainEqual(
      expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({
          code: 'run_execution_snapshot_json_invalid'
        })
      })
    );
  });

  it('persists workspace hash on session messages', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Remember workspace context'
    });

    const message = repository.recordSessionMessage({
      content: 'Workspace specific answer',
      role: 'assistant',
      threadId: run.threadId,
      workspaceHash: 'workspace_hash_a'
    });

    expect(columnNames('session_messages')).toContain('workspace_hash');
    expect(message.workspaceHash).toBe('workspace_hash_a');
    expect(rawRow('session_messages', message.id)).toMatchObject({
      workspace_hash: 'workspace_hash_a'
    });
    expect(repository.listSessionMessages({ threadId: run.threadId })).toEqual([message]);
  });

  it('migrates existing session messages to support workspace hashes', () => {
    db.exec(`
      CREATE TABLE session_messages (
        id             TEXT PRIMARY KEY,
        thread_id      TEXT NOT NULL,
        role           TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
        content        TEXT NOT NULL,
        token_count    INTEGER,
        phase          TEXT NOT NULL DEFAULT 'visible' CHECK(phase IN ('visible','pre_compaction_flush')),
        created_at     TEXT NOT NULL
      );

      INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, created_at)
      VALUES ('smsg_legacy', 'thread_legacy', 'assistant', 'Legacy context', 8, 'visible', '2026-06-24T00:00:00.000Z');
    `);

    applyAgentPluginSchema(db);

    expect(columnNames('session_messages')).toContain('workspace_hash');
    expect(rawRow('session_messages', 'smsg_legacy')).toMatchObject({
      content: 'Legacy context',
      workspace_hash: null
    });
  });

  it('stores user image attachment metadata without base64 data', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: '描述图片',
      attachments: [
        {
          kind: 'image',
          name: 'diagram.png',
          mediaType: 'image/png',
          sizeBytes: 123
        }
      ]
    });

    const events = repository.listThreadEvents(run.threadId);

    expect(events[0]?.payload).toEqual({
      role: 'user',
      content: '描述图片',
      enabledCapabilities,
      attachments: [
        {
          kind: 'image',
          name: 'diagram.png',
          mediaType: 'image/png',
          sizeBytes: 123
        }
      ]
    });
    expect(JSON.stringify(events[0]?.payload)).not.toContain('base64');
  });

  it('filters current workspace search by workspace hash and keeps unscoped rows only in all scope', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const runA = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Workspace A'
    });
    const runB = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Workspace B'
    });

    repository.recordSessionMessage({
      content: 'alpha recall from workspace a',
      role: 'assistant',
      threadId: runA.threadId,
      workspaceHash: 'workspace_hash_a'
    });
    repository.recordSessionMessage({
      content: 'alpha recall from workspace b',
      role: 'assistant',
      threadId: runB.threadId,
      workspaceHash: 'workspace_hash_b'
    });
    repository.recordSessionMessage({
      content: 'alpha recall from unscoped history',
      role: 'assistant',
      threadId: runB.threadId,
      workspaceHash: null
    });

    const current = repository.searchSessionMessages({
      query: 'alpha',
      workspaceScope: 'current',
      workspaceHash: 'workspace_hash_a'
    });
    expect(current.items.map((item) => item.content)).toEqual(['alpha recall from workspace a']);

    const all = repository.searchSessionMessages({
      query: 'alpha',
      workspaceScope: 'all'
    });
    expect(all.items.map((item) => item.content).sort()).toEqual([
      'alpha recall from unscoped history',
      'alpha recall from workspace a',
      'alpha recall from workspace b'
    ]);
  });

  it('includes pre-compaction flush rows in workspace-scoped session search', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Create a long context summary'
    });

    repository.recordSessionMessage({
      content: 'summary index includes context artifact paymentserviceevidence',
      phase: 'pre_compaction_flush',
      role: 'system',
      threadId: run.threadId,
      tokenCount: 120,
      workspaceHash: 'workspace_hash_summary'
    });

    const result = repository.searchSessionMessages({
      query: 'paymentserviceevidence',
      workspaceHash: 'workspace_hash_summary',
      workspaceScope: 'current'
    });

    expect(result.items.map((item) => ({
      content: item.content,
      phase: item.phase,
      workspaceHash: item.workspaceHash
    }))).toEqual([
      {
        content: 'summary index includes context artifact paymentserviceevidence',
        phase: 'pre_compaction_flush',
        workspaceHash: 'workspace_hash_summary'
      }
    ]);
  });

  it('treats punctuation-heavy session_search queries as plain text instead of FTS syntax', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = createRun(repository, {
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Review service evidence'
    });

    repository.recordSessionMessage({
      content: 'payment-service evidence lives under F:\\Code\\Roc\\src\\payments',
      role: 'assistant',
      threadId: run.threadId,
      workspaceHash: 'workspace_hash_query'
    });

    const result = repository.searchSessionMessages({
      query: 'payment-service F:\\Code\\Roc',
      workspaceHash: 'workspace_hash_query',
      workspaceScope: 'current'
    });

    expect(result.items.map((item) => item.content)).toEqual([
      'payment-service evidence lives under F:\\Code\\Roc\\src\\payments'
    ]);
  });
});

function columnNames(tableName: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name);
}

function rawRow(tableName: string, id: string): Record<string, unknown> {
  return db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id) as Record<string, unknown>;
}

function transitionRun(repository: AgentSessionRepository, runId: string, status: TaskStatus): void {
  const state = repository.getRunTransitionState(runId);
  repository.transitionRun({
    endedAt: null,
    expectedStateVersion: state.stateVersion,
    expectedStatus: state.status,
    runId,
    status
  });
}

async function seedCheckpoint(
  threadId: string,
  interrupts: ReadonlyArray<{ id: string; payload: unknown }> = [],
  checkpointId = 'checkpoint_restart_reconcile'
): Promise<void> {
  const checkpointer = new RocSqliteCheckpointer(db);
  const config = await checkpointer.put(
    { configurable: { thread_id: threadId, checkpoint_ns: '' } },
    {
      v: 4,
      id: checkpointId,
      ts: '2026-07-17T01:00:00.000Z',
      channel_values: {},
      channel_versions: {},
      versions_seen: {}
    },
    { source: 'input', step: 1, parents: {} },
    {}
  );
  if (interrupts.length > 0) {
    await checkpointer.putWrites(
      config,
      [['__interrupt__', interrupts.map((interrupt) => ({ id: interrupt.id, value: interrupt.payload }))]],
      `task_${checkpointId}`
    );
  }
}

function createRun(
  repository: AgentSessionRepository,
  input: {
    attachments?: ChatPersistedAttachment[];
    enabledCapabilities: EnabledCapabilities;
    modelId: string;
    threadId?: string;
    threadKind: TaskKind;
    userInput: string;
  }
) {
  const capabilityPreview = createCapabilityPreview(input.enabledCapabilities);
  return repository.createTaskRun({
    attachments: input.attachments,
    capabilityPreview,
    snapshot: {
      schemaVersion: 2,
      runOrigin: 'chat',
      model: {
        providerId: 'test-provider',
        modelId: input.modelId
      },
      mode: 'run',
      workspace: null,
      capabilityManifest: capabilityPreview.manifest,
      budget: {
        contextBudgetTokens: null,
        modelCallLimit: 20,
        modelThreadCallLimit: 100,
        toolCallLimit: 40,
        toolThreadCallLimit: 200
      },
      workflowHint: null,
      explicitSkillIds: [],
      dispatchKey: null
    },
    threadId: input.threadId,
    threadKind: input.threadKind,
    userInput: input.userInput
  });
}

function readPendingInterrupts(
  repository: AgentSessionRepository,
  run: { id: string; threadId: string }
) {
  return repository.interruptProjection.readPending({ runId: run.id, threadId: run.threadId });
}

function createCapabilityPreview(requestedCapabilities: EnabledCapabilities): AgentCapabilityPreview {
  return buildAgentCapabilityPreview({
    deleteFileApprovalMode: 'fully_automatic',
    mcpApprovalMode: 'fully_automatic',
    mcpServers: requestedCapabilities.mcpServers.map((id) => ({
      id,
      name: id,
      enabled: true,
      transport: 'http' as const,
      status: 'ready' as const,
      tools: 0,
      allowedTools: []
    })),
    requestedCapabilities,
    runtimeStatus: readyRuntimeStatus(),
    skills: requestedCapabilities.skills.map((id) => ({
      id,
      name: id,
      enabled: true,
      path: `F:\\skills\\${id}`,
      description: `${id} skill`,
      status: 'ready' as const
    })),
    mode: 'chat',
    workflowHint: null
  });
}

function readyRuntimeStatus(): AgentRuntimeStatus {
  return {
    deepAgentsPackage: 'available',
    deepAgentsApi: {
      createDeepAgent: true
    },
    defaultModelConfigured: true,
    defaultModelState: {
      status: 'ready',
      modelId: 'openai:gpt-4.1',
      providerId: 'test-provider',
      reason: 'ready'
    },
    memoryAccess: 'store_backend',
    execution: 'ready'
  };
}
