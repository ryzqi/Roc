import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentCapabilityPreview, AgentRuntimeStatus, EnabledCapabilities, TaskRun } from '../../../../src/shared/types';
import { buildAgentCapabilityPreview } from '../../../../src/main/plugins/agent/capability-preview';
import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';

import { applyTaskDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentTaskHistoryContract } from '../../../../src/main/plugins/agent/agent-task-history-contract';
import { TaskRepository } from '../../../../src/main/plugins/task/task-repository';
import { createTerminalRunTelemetry } from '../agent/run-telemetry-test-helpers';

let agentDb: Database.Database;
let taskDb: Database.Database;
let shadowTaskDb: Database.Database;

const enabledCapabilities: EnabledCapabilities = {
  mcpServers: [],
  skills: []
};

beforeEach(() => {
  agentDb = new Database(':memory:');
  agentDb.pragma('foreign_keys = ON');
  applyAgentDatabaseSchema(agentDb);
  taskDb = new Database(':memory:');
  taskDb.pragma('foreign_keys = ON');
  applyTaskDatabaseSchema(taskDb);
  shadowTaskDb = new Database(':memory:');
  shadowTaskDb.pragma('foreign_keys = ON');
  applyTaskDatabaseSchema(shadowTaskDb);
});

afterEach(() => {
  shadowTaskDb.close();
  taskDb.close();
  agentDb.close();
});

describe('agent outbox projector', () => {
  it('replays a completed run once and retains the durable cursor after repository restart', () => {
    const agentRepository = new AgentSessionRepository(agentDb);
    const run = createRun(agentRepository, 'Complete the scheduled task');
    agentRepository.completeRunAtomically({
      assistantMessage: 'Scheduled task completed',
      durationMs: 50,
      endedAt: '2026-07-17T01:00:00.000Z',
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      modelId: 'openai:gpt-4.1',
      providerId: 'test-provider',
      runId: run.id,
      runStartedAt: run.startedAt,
      summary: 'Completed scheduled task',
      telemetry: createTerminalRunTelemetry({
        repository: agentRepository,
        run,
        terminal: {
          status: 'completed',
          durationMs: 50,
          errorCode: null,
          retryable: null,
          cancelSource: null
        }
      }),
      workspaceHash: null
    });

    const history = new AgentTaskHistoryContract(agentDb);
    const repository = new TaskRepository(taskDb, history);
    const taskId = seedBackgroundTask(repository, taskDb, run);
    const shadowRepository = new TaskRepository(shadowTaskDb, new AgentTaskHistoryContract(agentDb));
    const shadowTaskId = seedBackgroundTask(shadowRepository, shadowTaskDb, run);
    const events = history.listOutboxEventsAfter({ afterSequence: 0, limit: 20 });
    const event = events[0];
    if (event === undefined || event.eventType !== 'run_completed') {
      throw new Error('agent_outbox_completed_event_missing');
    }

    shadowRepository.recordAgentRunCompleted({
      runId: event.runId,
      threadId: event.threadId,
      ...event.payload
    });

    expect(repository.projectAgentOutboxEvents({ events, projectorName: 'task_background_status' })).toEqual({
      appliedCount: 1,
      lastSequence: event.sequence
    });
    expect(repository.findBackgroundTask(taskId)).toMatchObject({
      status: 'running',
      lastRunStatus: 'success'
    });
    expect(repository.findBackgroundTask(taskId)).toMatchObject({
      status: shadowRepository.findBackgroundTask(shadowTaskId)?.status,
      lastRunStatus: shadowRepository.findBackgroundTask(shadowTaskId)?.lastRunStatus
    });

    const restartedRepository = new TaskRepository(taskDb, new AgentTaskHistoryContract(agentDb));
    expect(restartedRepository.projectAgentOutboxEvents({ events, projectorName: 'task_background_status' })).toEqual({
      appliedCount: 0,
      lastSequence: event.sequence
    });
  });

  it('projects a failed run into the background task failure policy', () => {
    const agentRepository = new AgentSessionRepository(agentDb);
    const run = createRun(agentRepository, 'Fail the scheduled task');
    agentRepository.failRunAtomically({
      code: 'provider_unavailable',
      diagnostic: {
        badKeys: ['apiKey'],
        schemaPath: 'tools[0].input',
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
      suggestion: '检查提供商凭据后重试。',
      telemetry: createTerminalRunTelemetry({
        repository: agentRepository,
        run,
        terminal: {
          status: 'failed',
          durationMs: 50,
          errorCode: 'provider_unavailable',
          retryable: true,
          cancelSource: null
        }
      })
    });

    const history = new AgentTaskHistoryContract(agentDb);
    const repository = new TaskRepository(taskDb, history);
    const taskId = seedBackgroundTask(repository, taskDb, run);
    const events = history.listOutboxEventsAfter({ afterSequence: 0, limit: 20 });

    expect(events).toMatchObject([
      {
        eventType: 'run_failed',
        payload: {
          diagnostic: {
            badKeys: ['apiKey'],
            schemaPath: 'tools[0].input',
            toolName: 'web_read'
          },
          suggestion: '检查提供商凭据后重试。'
        }
      }
    ]);

    expect(repository.projectAgentOutboxEvents({ events, projectorName: 'task_background_status' })).toEqual({
      appliedCount: 1,
      lastSequence: events[0]!.sequence
    });
    expect(repository.findBackgroundTask(taskId)).toMatchObject({
      status: 'paused',
      lastRunStatus: 'failed'
    });
    expect(history.findActiveThread(run.threadId)).toMatchObject({ status: 'paused' });
    expect(history.listEventsForRun(run.threadId, run.id)).toContainEqual(
      expect.objectContaining({
        type: 'background_task_paused',
        payload: {
          taskId,
          status: 'paused'
        }
      })
    );
    const pausedEventCount = history
      .listEventsForRun(run.threadId, run.id)
      .filter((event) => event.type === 'background_task_paused').length;
    expect(repository.projectAgentOutboxEvents({ events, projectorName: 'task_background_status' })).toEqual({
      appliedCount: 0,
      lastSequence: events[0]!.sequence
    });
    expect(
      history.listEventsForRun(run.threadId, run.id).filter((event) => event.type === 'background_task_paused')
    ).toHaveLength(pausedEventCount);
  });

  it('marks the linked occurrence failed without letting an older run pause a newer task projection', () => {
    const agentRepository = new AgentSessionRepository(agentDb);
    const run = createRun(agentRepository, 'Fail an older scheduled occurrence');
    const history = new AgentTaskHistoryContract(agentDb);
    const repository = new TaskRepository(taskDb, history);
    const scheduledAt = '2026-07-17T01:00:00.000Z';
    const task = repository.createBackgroundTask({
      goal: run.userInput,
      trigger: {
        description: 'At the scheduled time',
        nextRunAt: scheduledAt,
        type: 'once'
      },
      workspacePath: 'F:\\Code\\Roc',
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations',
      enabledCapabilities
    });
    taskDb.prepare('UPDATE background_tasks SET thread_id = ? WHERE id = ?').run(run.threadId, task.id);
    const claim = repository.claimDueScheduledOccurrence({
      claimOwner: 'scheduler-a',
      now: '2026-07-17T01:00:01.000Z',
      taskId: task.id
    });
    if (claim === null) {
      throw new Error('scheduled_occurrence_claim_missing');
    }
    repository.markScheduledOccurrenceDispatched({
      attempt: claim.attempt,
      claimOwner: claim.claimOwner,
      dispatchedAt: '2026-07-17T01:00:02.000Z',
      occurrenceKey: claim.occurrenceKey,
      runId: run.id
    });
    taskDb
      .prepare('UPDATE background_tasks SET run_id = ?, status = ?, last_run_status = ? WHERE id = ?')
      .run('run_newer_occurrence', 'running', null, task.id);
    agentRepository.failRunAtomically({
      code: 'provider_unavailable',
      endedAt: '2026-07-17T01:01:00.000Z',
      error: 'Provider is unavailable',
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      modelId: 'openai:gpt-4.1',
      providerId: 'test-provider',
      retryable: true,
      runId: run.id,
      telemetry: createTerminalRunTelemetry({
        repository: agentRepository,
        run,
        terminal: {
          status: 'failed',
          durationMs: 60,
          errorCode: 'provider_unavailable',
          retryable: true,
          cancelSource: null
        }
      })
    });

    const events = history.listOutboxEventsAfter({ afterSequence: 0, limit: 20 });
    expect(repository.projectAgentOutboxEvents({ events, projectorName: 'task_background_status' })).toEqual({
      appliedCount: 1,
      lastSequence: events[0]!.sequence
    });
    expect(
      taskDb.prepare('SELECT status, terminal_at FROM scheduled_occurrences WHERE occurrence_key = ?').get(claim.occurrenceKey)
    ).toEqual({ status: 'failed', terminal_at: '2026-07-17T01:01:00.000Z' });
    expect(repository.findBackgroundTask(task.id)).toMatchObject({
      runId: 'run_newer_occurrence',
      status: 'running',
      lastRunStatus: null
    });
  });

  it('projects a cancelled run without pausing the background task', () => {
    const agentRepository = new AgentSessionRepository(agentDb);
    const run = createRun(agentRepository, 'Cancel the scheduled task');
    agentRepository.cancelRunAtomically({
      endedAt: '2026-07-17T01:00:00.000Z',
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      runId: run.id,
      telemetry: createTerminalRunTelemetry({
        repository: agentRepository,
        run,
        terminal: {
          status: 'cancelled',
          durationMs: 10,
          errorCode: null,
          retryable: null,
          cancelSource: 'user_cancelled'
        }
      })
    });

    const history = new AgentTaskHistoryContract(agentDb);
    const repository = new TaskRepository(taskDb, history);
    const taskId = seedBackgroundTask(repository, taskDb, run);
    const events = history.listOutboxEventsAfter({ afterSequence: 0, limit: 20 });

    expect(events).toMatchObject([
      {
        eventType: 'run_cancelled',
        payload: { reason: 'user_cancelled' }
      }
    ]);
    expect(repository.projectAgentOutboxEvents({ events, projectorName: 'task_background_status' })).toEqual({
      appliedCount: 1,
      lastSequence: events[0]!.sequence
    });
    expect(repository.findBackgroundTask(taskId)).toMatchObject({
      status: 'running',
      lastRunStatus: 'cancelled'
    });
  });

  it('keeps deleted history as a no-op outbox tombstone so the durable cursor never gaps or reuses a sequence', () => {
    const agentRepository = new AgentSessionRepository(agentDb);
    const deletedRun = createRun(agentRepository, 'Delete this task history');
    agentRepository.completeRunAtomically({
      assistantMessage: 'Deleted task completed',
      durationMs: 10,
      endedAt: '2026-07-17T01:00:00.000Z',
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      modelId: 'openai:gpt-4.1',
      providerId: 'test-provider',
      runId: deletedRun.id,
      runStartedAt: deletedRun.startedAt,
      summary: 'Deleted task completed',
      telemetry: createTerminalRunTelemetry({
        repository: agentRepository,
        run: deletedRun,
        terminal: {
          status: 'completed',
          durationMs: 10,
          errorCode: null,
          retryable: null,
          cancelSource: null
        }
      }),
      workspaceHash: null
    });
    expect(agentRepository.getRunTelemetry(deletedRun.id)).not.toBeNull();
    new AgentTaskHistoryContract(agentDb).deleteThread( deletedRun.threadId);
    expect(agentDb.prepare('SELECT COUNT(*) FROM agent_run_telemetry WHERE run_id = ?').pluck().get(deletedRun.id)).toBe(0);

    const history = new AgentTaskHistoryContract(agentDb);
    const repository = new TaskRepository(taskDb, history);
    const tombstone = history.listOutboxEventsAfter({ afterSequence: 0, limit: 20 });

    expect(tombstone).toMatchObject([{ eventType: 'run_deleted', sequence: 1, payload: {} }]);
    expect(repository.projectAgentOutboxEvents({ events: tombstone, projectorName: 'task_background_status' })).toEqual({
      appliedCount: 1,
      lastSequence: 1
    });

    const activeRun = createRun(agentRepository, 'Keep this task history');
    agentRepository.completeRunAtomically({
      assistantMessage: 'Active task completed',
      durationMs: 10,
      endedAt: '2026-07-17T01:00:01.000Z',
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      modelId: 'openai:gpt-4.1',
      providerId: 'test-provider',
      runId: activeRun.id,
      runStartedAt: activeRun.startedAt,
      summary: 'Active task completed',
      telemetry: createTerminalRunTelemetry({
        repository: agentRepository,
        run: activeRun,
        terminal: {
          status: 'completed',
          durationMs: 10,
          errorCode: null,
          retryable: null,
          cancelSource: null
        }
      }),
      workspaceHash: null
    });

    const nextEvents = history.listOutboxEventsAfter({ afterSequence: 1, limit: 20 });
    expect(nextEvents).toMatchObject([{ eventType: 'run_completed', sequence: 2 }]);
    expect(repository.projectAgentOutboxEvents({ events: nextEvents, projectorName: 'task_background_status' })).toEqual({
      appliedCount: 1,
      lastSequence: 2
    });
  });

  it('rejects an out-of-order event without advancing the cursor or mutating task projection', () => {
    const agentRepository = new AgentSessionRepository(agentDb);
    const firstRun = createRun(agentRepository, 'Complete the first ordered task');
    const secondRun = createRun(agentRepository, 'Complete the second ordered task');
    agentRepository.completeRunAtomically({
      assistantMessage: 'First task completed',
      durationMs: 10,
      endedAt: '2026-07-17T01:00:00.000Z',
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      modelId: 'openai:gpt-4.1',
      providerId: 'test-provider',
      runId: firstRun.id,
      runStartedAt: firstRun.startedAt,
      summary: 'First task completed',
      telemetry: createTerminalRunTelemetry({
        repository: agentRepository,
        run: firstRun,
        terminal: {
          status: 'completed',
          durationMs: 10,
          errorCode: null,
          retryable: null,
          cancelSource: null
        }
      }),
      workspaceHash: null
    });
    agentRepository.completeRunAtomically({
      assistantMessage: 'Second task completed',
      durationMs: 10,
      endedAt: '2026-07-17T01:00:01.000Z',
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      modelId: 'openai:gpt-4.1',
      providerId: 'test-provider',
      runId: secondRun.id,
      runStartedAt: secondRun.startedAt,
      summary: 'Second task completed',
      telemetry: createTerminalRunTelemetry({
        repository: agentRepository,
        run: secondRun,
        terminal: {
          status: 'completed',
          durationMs: 10,
          errorCode: null,
          retryable: null,
          cancelSource: null
        }
      }),
      workspaceHash: null
    });
    const history = new AgentTaskHistoryContract(agentDb);
    const repository = new TaskRepository(taskDb, history);
    const secondTaskId = seedBackgroundTask(repository, taskDb, secondRun);
    const events = history.listOutboxEventsAfter({ afterSequence: 0, limit: 20 });
    const firstEvent = events[0];
    const secondEvent = events[1];
    if (firstEvent === undefined || secondEvent === undefined) {
      throw new Error('ordered_agent_outbox_events_missing');
    }

    expect(() =>
      repository.projectAgentOutboxEvents({
        events: [secondEvent],
        projectorName: 'task_background_status'
      })
    ).toThrow('task_agent_outbox_sequence_gap');
    expect(repository.getAgentOutboxCursor('task_background_status')).toBe(0);
    expect(repository.findBackgroundTask(secondTaskId)).toMatchObject({
      status: 'running',
      lastRunStatus: null
    });

    expect(repository.projectAgentOutboxEvents({ events: [firstEvent, secondEvent], projectorName: 'task_background_status' })).toEqual({
      appliedCount: 2,
      lastSequence: secondEvent.sequence
    });
    expect(repository.getAgentOutboxCursor('task_background_status')).toBe(secondEvent.sequence);
    expect(repository.findBackgroundTask(secondTaskId)).toMatchObject({
      status: 'running',
      lastRunStatus: 'success'
    });
  });
});

function createRun(repository: AgentSessionRepository, userInput: string): TaskRun {
  const capabilityPreview = createCapabilityPreview();
  return repository.createTaskRun({
    capabilityPreview,
    snapshot: {
      schemaVersion: 2,
      runOrigin: 'background_schedule',
      model: {
        providerId: 'test-provider',
        modelId: 'openai:gpt-4.1'
      },
      mode: 'task',
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
    threadKind: 'background',
    userInput
  });
}

function seedBackgroundTask(repository: TaskRepository, db: Database.Database, run: TaskRun): string {
  const task = repository.createBackgroundTask({
    goal: run.userInput,
    trigger: {
      type: 'manual',
      description: 'Manual test task'
    },
    workspacePath: 'F:\\Code\\Roc',
    allowedActions: [],
    forbiddenActions: [],
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations',
    enabledCapabilities
  });
  db.prepare('UPDATE background_tasks SET thread_id = ?, run_id = ? WHERE id = ?').run(run.threadId, run.id, task.id);
  return task.id;
}

function createCapabilityPreview(): AgentCapabilityPreview {
  return buildAgentCapabilityPreview({
    deleteFileApprovalMode: 'fully_automatic',
    mcpApprovalMode: 'fully_automatic',
    mcpServers: [],
    requestedCapabilities: enabledCapabilities,
    runtimeStatus: readyRuntimeStatus(),
    skills: [],
    mode: 'task',
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
