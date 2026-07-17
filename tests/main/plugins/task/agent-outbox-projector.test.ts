import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentCapabilityPreview, AgentRuntimeStatus, EnabledCapabilities, TaskRun } from '../../../../src/shared/types';
import { buildAgentCapabilityPreview } from '../../../../src/main/plugins/agent/capability-preview';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';
import { deleteAgentThreadHistory } from '../../../../src/main/infrastructure/agent-history-deletion';
import { applyTaskPluginSchema } from '../../../../src/main/plugins/task/schema';
import { AgentTaskHistoryReader } from '../../../../src/main/plugins/task/agent-task-history';
import { TaskRepository } from '../../../../src/main/plugins/task/task-repository';

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
  applyAgentPluginSchema(agentDb);
  taskDb = new Database(':memory:');
  taskDb.pragma('foreign_keys = ON');
  applyTaskPluginSchema(taskDb);
  shadowTaskDb = new Database(':memory:');
  shadowTaskDb.pragma('foreign_keys = ON');
  applyTaskPluginSchema(shadowTaskDb);
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
      workspaceHash: null
    });

    const history = new AgentTaskHistoryReader(agentDb);
    const repository = new TaskRepository(taskDb, history);
    const taskId = seedBackgroundTask(repository, taskDb, run);
    const shadowRepository = new TaskRepository(shadowTaskDb, new AgentTaskHistoryReader(agentDb));
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

    const restartedRepository = new TaskRepository(taskDb, new AgentTaskHistoryReader(agentDb));
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
      suggestion: '检查提供商凭据后重试。'
    });

    const history = new AgentTaskHistoryReader(agentDb);
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

  it('projects a cancelled run without pausing the background task', () => {
    const agentRepository = new AgentSessionRepository(agentDb);
    const run = createRun(agentRepository, 'Cancel the scheduled task');
    agentRepository.cancelRunAtomically({
      endedAt: '2026-07-17T01:00:00.000Z',
      expectedStateVersion: 1,
      expectedStatus: 'waiting_next_turn',
      runId: run.id
    });

    const history = new AgentTaskHistoryReader(agentDb);
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
      workspaceHash: null
    });
    deleteAgentThreadHistory(agentDb, deletedRun.threadId);

    const history = new AgentTaskHistoryReader(agentDb);
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
      workspaceHash: null
    });

    const nextEvents = history.listOutboxEventsAfter({ afterSequence: 1, limit: 20 });
    expect(nextEvents).toMatchObject([{ eventType: 'run_completed', sequence: 2 }]);
    expect(repository.projectAgentOutboxEvents({ events: nextEvents, projectorName: 'task_background_status' })).toEqual({
      appliedCount: 1,
      lastSequence: 2
    });
  });
});

function createRun(repository: AgentSessionRepository, userInput: string): TaskRun {
  const capabilityPreview = createCapabilityPreview();
  return repository.createTaskRun({
    capabilityPreview,
    snapshot: {
      schemaVersion: 1,
      runOrigin: 'background_schedule',
      model: {
        providerId: 'test-provider',
        modelId: 'openai:gpt-4.1'
      },
      mode: 'task',
      workspace: null,
      capabilityManifest: capabilityPreview.manifest,
      budget: {
        contextBudgetTokens: null
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
    mode: 'task'
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
