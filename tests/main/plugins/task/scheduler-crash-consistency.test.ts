import { completedTestOutcome, createTestAgentExecution } from '../agent/test-execution';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocEventBus } from '../../../../src/main/kernel/types';
import type { AgentModelFactoryAdapter } from '../../../../src/main/plugins/agent/model-factory-adapter';
import { compileRunCapabilityManifest } from '../../../../src/main/plugins/agent/run-capability-manifest';
import { AgentPluginRuntime } from '../../../../src/main/plugins/agent/runtime';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';
import { createTaskPlugin } from '../../../../src/main/plugins/task';
import { AgentTaskHistoryContract } from '../../../../src/main/plugins/agent/agent-task-history-contract';
import { TaskScheduler } from '../../../../src/main/plugins/task/scheduler';
import { applyTaskPluginSchema } from '../../../../src/main/plugins/task/schema';
import { TaskRepository } from '../../../../src/main/plugins/task/task-repository';
import type { AgentCapabilityPreview, ChatRunEvent, ChatStartRunRequest } from '../../../../src/shared/types';
import { createTaskPluginTestDatabaseFacade, createTaskPluginTestEventBus } from './task-plugin-test-harness';

let agentDb: Database.Database;
let db: Database.Database;

const modelFactory: AgentModelFactoryAdapter = {
  createDefaultModelHandle: async () => ({
    modelId: 'openai:gpt-4.1',
    providerId: 'openai'
  }),
  createModelHandleByProviderAndModel: async ({ providerId, modelId }) => ({
    modelId,
    providerId
  })
};

const eventBus: RocEventBus = {
  publish: async () => {},
  subscribe: () => () => {}
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyTaskPluginSchema(db);
  agentDb = new Database(':memory:');
  agentDb.pragma('foreign_keys = ON');
  applyAgentDatabaseSchema(agentDb);
  vi.useFakeTimers({ now: new Date('2026-07-15T00:00:00.000Z') });
});

afterEach(() => {
  vi.useRealTimers();
  agentDb.close();
  db.close();
});

describe('TaskScheduler crash consistency characterization', () => {
  it('claims the occurrence before it starts the agent and links the resulting run', async () => {
    const repository = new TaskRepository(db, new AgentTaskHistoryContract(agentDb));
    const task = repository.createBackgroundTask({
      goal: 'Run a due background task',
      trigger: {
        type: 'once',
        description: 'One second from now',
        nextRunAt: '2026-07-15T00:00:01.000Z'
      },
      workspacePath: 'F:\\Code\\Roc',
      allowedActions: ['git status'],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    agentDb
      .prepare(
        `INSERT INTO agent_runs
         (id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
          enabled_capabilities_json, workspace_path, task_source, workflow_hint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'run_scheduler_crash_gap',
        task.threadId,
        2,
        task.goal,
        'running',
        task.createdAt,
        null,
        null,
        null,
        JSON.stringify({ mcpServers: [], skills: [] }),
        task.workspacePath,
        'background_schedule',
        null
      );
    const calls: string[] = [];
    const originalClaim = repository.claimDueScheduledOccurrence.bind(repository);
    vi.spyOn(repository, 'claimDueScheduledOccurrence').mockImplementation((input) => {
      calls.push('claim_occurrence');
      return originalClaim(input);
    });
    const originalMarkDispatched = repository.markScheduledOccurrenceDispatched.bind(repository);
    vi.spyOn(repository, 'markScheduledOccurrenceDispatched').mockImplementation((input) => {
      calls.push('mark_occurrence_dispatched');
      return originalMarkDispatched(input);
    });
    const scheduler = new TaskScheduler(repository, {
      startRun: async (request) => {
        calls.push('start_agent');
        expect(request.shellAllowedCommands).toEqual(['git status']);
        expect(
          db.prepare('SELECT status FROM scheduled_occurrences WHERE background_task_id = ?').all(task.id)
        ).toEqual([{ status: 'claimed' }]);
        return {
          runId: 'run_scheduler_crash_gap',
          mode: 'task',
          threadId: task.threadId,
          providerId: 'test-provider',
          modelId: 'test-model',
          createdAt: new Date().toISOString()
        };
      }
    });

    scheduler.start();
    await vi.runAllTimersAsync();

    expect(calls).toEqual(['claim_occurrence', 'start_agent', 'mark_occurrence_dispatched']);
    expect(
      db.prepare('SELECT status, run_id FROM scheduled_occurrences WHERE background_task_id = ?').all(task.id)
    ).toEqual([{ status: 'dispatched', run_id: 'run_scheduler_crash_gap' }]);
  });

  it('reclaims a persistent claim after a crash before agent start', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-scheduler-claim-crash-'));
    const taskPath = join(root, 'task.db');
    const agentPath = join(root, 'agent.db');
    let firstTaskDb: Database.Database | null = null;
    let firstAgentDb: Database.Database | null = null;
    let restartedTaskDb: Database.Database | null = null;
    let restartedAgentDb: Database.Database | null = null;
    try {
      firstTaskDb = new Database(taskPath);
      firstTaskDb.pragma('foreign_keys = ON');
      firstAgentDb = new Database(agentPath);
      firstAgentDb.pragma('foreign_keys = ON');
      applyTaskPluginSchema(firstTaskDb);
      applyAgentDatabaseSchema(firstAgentDb);
      const firstRepository = new TaskRepository(firstTaskDb, new AgentTaskHistoryContract(firstAgentDb));
      const task = firstRepository.createBackgroundTask({
        goal: 'Recover a claim before agent start',
        trigger: {
          type: 'once',
          description: 'Already due',
          nextRunAt: '2026-07-15T00:00:00.000Z'
        },
        workspacePath: 'F:\\Code\\Roc',
        allowedActions: [],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      });
      const claim = firstRepository.claimDueScheduledOccurrence({
        claimOwner: 'crashed-scheduler',
        now: '2026-07-15T00:00:00.000Z',
        taskId: task.id
      });
      if (claim === null) {
        throw new Error('scheduled_occurrence_claim_missing');
      }
      expect(firstAgentDb.prepare('SELECT COUNT(*) AS total FROM agent_runs WHERE dispatch_key = ?').get(claim.dispatchKey)).toEqual({
        total: 0
      });

      firstTaskDb.close();
      firstTaskDb = null;
      firstAgentDb.close();
      firstAgentDb = null;

      vi.setSystemTime(new Date('2026-07-15T00:01:01.000Z'));
      restartedTaskDb = new Database(taskPath);
      restartedTaskDb.pragma('foreign_keys = ON');
      restartedAgentDb = new Database(agentPath);
      restartedAgentDb.pragma('foreign_keys = ON');
      applyTaskPluginSchema(restartedTaskDb);
      applyAgentDatabaseSchema(restartedAgentDb);
      const restartedRepository = new TaskRepository(restartedTaskDb, new AgentTaskHistoryContract(restartedAgentDb));
      const restartedAgentRepository = new AgentSessionRepository(restartedAgentDb);
      const restartedRuntime = createSchedulerAgentRuntime(restartedAgentRepository);
      const linked = createDeferred();
      const originalMarkDispatched = restartedRepository.markScheduledOccurrenceDispatched.bind(restartedRepository);
      vi.spyOn(restartedRepository, 'markScheduledOccurrenceDispatched').mockImplementation((input) => {
        const updated = originalMarkDispatched(input);
        linked.resolve();
        return updated;
      });
      const scheduler = new TaskScheduler(restartedRepository, {
        startRun: async (request) => await restartedRuntime.startRun(request)
      });

      scheduler.start();
      await linked.promise;

      const run = restartedAgentRepository.findRunByDispatchKey(claim.dispatchKey);
      if (run === null) {
        throw new Error('reclaimed_dispatch_key_run_missing');
      }
      expect(
        restartedTaskDb.prepare('SELECT status, run_id FROM scheduled_occurrences WHERE occurrence_key = ?').get(claim.occurrenceKey)
      ).toEqual({ status: 'dispatched', run_id: run.id });
      expect(restartedAgentDb.prepare('SELECT COUNT(*) AS total FROM agent_runs WHERE dispatch_key = ?').get(claim.dispatchKey)).toEqual({
        total: 1
      });
      scheduler.stop();
    } finally {
      restartedTaskDb?.close();
      restartedAgentDb?.close();
      firstTaskDb?.close();
      firstAgentDb?.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('reconciles the agent-start and occurrence-link crash across persistent database restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-scheduler-crash-gap-'));
    const taskPath = join(root, 'task.db');
    const agentPath = join(root, 'agent.db');
    let firstTaskDb: Database.Database | null = null;
    let firstAgentDb: Database.Database | null = null;
    let restartedTaskDb: Database.Database | null = null;
    let restartedAgentDb: Database.Database | null = null;
    try {
      firstTaskDb = new Database(taskPath);
      firstTaskDb.pragma('foreign_keys = ON');
      firstAgentDb = new Database(agentPath);
      firstAgentDb.pragma('foreign_keys = ON');
      applyTaskPluginSchema(firstTaskDb);
      applyAgentDatabaseSchema(firstAgentDb);
      const firstRepository = new TaskRepository(firstTaskDb, new AgentTaskHistoryContract(firstAgentDb));
      const firstAgentRepository = new AgentSessionRepository(firstAgentDb);
      const firstRuntime = createSchedulerAgentRuntime(firstAgentRepository);
      const task = firstRepository.createBackgroundTask({
        goal: 'Recover an agent-start to task-link crash',
        trigger: {
          type: 'once',
          description: 'One second from now',
          nextRunAt: '2026-07-15T00:00:01.000Z'
        },
        workspacePath: 'F:\\Code\\Roc',
        allowedActions: [],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      });
      const firstDispatchKeys: string[] = [];
      const firstStartReturned = createDeferred();
      const firstScheduler = new TaskScheduler(firstRepository, {
        startRun: async (request) => {
          if (request.dispatchKey === undefined) {
            throw new Error('scheduler_dispatch_key_missing');
          }
          firstDispatchKeys.push(request.dispatchKey);
          const result = await firstRuntime.startRun(request);
          firstStartReturned.resolve();
          return result;
        }
      });
      vi.spyOn(firstRepository, 'markScheduledOccurrenceDispatched').mockImplementation(() => {
        throw new Error('crash_after_agent_start_before_occurrence_link');
      });

      firstScheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await firstStartReturned.promise;
      await vi.advanceTimersByTimeAsync(1);

      expect(firstDispatchKeys).toHaveLength(1);
      expect(
        firstTaskDb.prepare('SELECT status, run_id FROM scheduled_occurrences WHERE background_task_id = ?').get(task.id)
      ).toEqual({ status: 'claimed', run_id: null });
      const firstRun = firstAgentRepository.findRunByDispatchKey(firstDispatchKeys[0]);
      if (firstRun === null) {
        throw new Error('first_dispatch_key_run_missing');
      }
      expect(
        firstAgentDb.prepare('SELECT id, dispatch_key, status FROM agent_runs WHERE id = ?').get(firstRun.id)
      ).toEqual({ id: firstRun.id, dispatch_key: firstDispatchKeys[0], status: 'completed' });
      expect(
        firstAgentDb.prepare('SELECT event_type, run_id FROM agent_outbox WHERE run_id = ?').get(firstRun.id)
      ).toEqual({ event_type: 'run_completed', run_id: firstRun.id });

      firstScheduler.stop();
      firstTaskDb.close();
      firstTaskDb = null;
      firstAgentDb.close();
      firstAgentDb = null;

      vi.setSystemTime(new Date('2026-07-15T00:01:02.000Z'));
      restartedTaskDb = new Database(taskPath);
      restartedTaskDb.pragma('foreign_keys = ON');
      restartedAgentDb = new Database(agentPath);
      restartedAgentDb.pragma('foreign_keys = ON');
      applyTaskPluginSchema(restartedTaskDb);
      applyAgentDatabaseSchema(restartedAgentDb);
      const restartedRepository = new TaskRepository(restartedTaskDb, new AgentTaskHistoryContract(restartedAgentDb));
      const restartedAgentRepository = new AgentSessionRepository(restartedAgentDb);
      const restartedRuntime = createSchedulerAgentRuntime(restartedAgentRepository);
      const restartedDispatchKeys: string[] = [];
      const restartedScheduler = new TaskScheduler(restartedRepository, {
        startRun: async (request) => {
          if (request.dispatchKey === undefined) {
            throw new Error('scheduler_dispatch_key_missing');
          }
          restartedDispatchKeys.push(request.dispatchKey);
          return await restartedRuntime.startRun(request);
        }
      });

      restartedScheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(restartedDispatchKeys).toEqual(firstDispatchKeys);
      expect(
        restartedAgentDb.prepare('SELECT COUNT(*) AS total FROM agent_runs WHERE dispatch_key = ?').get(firstDispatchKeys[0])
      ).toEqual({ total: 1 });
      expect(
        restartedTaskDb.prepare('SELECT status, run_id, terminal_at FROM scheduled_occurrences WHERE background_task_id = ?').get(task.id)
      ).toEqual({ status: 'completed', run_id: firstRun.id, terminal_at: '2026-07-15T00:01:02.000Z' });
      restartedRepository.reconcileScheduledOccurrences({ now: '2026-07-15T00:01:04.000Z' });

      expect(
        restartedTaskDb.prepare('SELECT status, terminal_at FROM scheduled_occurrences WHERE background_task_id = ?').get(task.id)
      ).toEqual({ status: 'completed', terminal_at: '2026-07-15T00:01:02.000Z' });
      restartedScheduler.stop();
    } finally {
      restartedTaskDb?.close();
      restartedAgentDb?.close();
      firstTaskDb?.close();
      firstAgentDb?.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('replays a persistent terminal outbox after a crash before task projection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-scheduler-terminal-crash-'));
    const taskPath = join(root, 'task.db');
    const agentPath = join(root, 'agent.db');
    let firstTaskDb: Database.Database | null = null;
    let firstAgentDb: Database.Database | null = null;
    let restartedTaskDb: Database.Database | null = null;
    let restartedAgentDb: Database.Database | null = null;
    let replayedTaskDb: Database.Database | null = null;
    try {
      firstTaskDb = new Database(taskPath);
      firstTaskDb.pragma('foreign_keys = ON');
      firstAgentDb = new Database(agentPath);
      firstAgentDb.pragma('foreign_keys = ON');
      applyTaskPluginSchema(firstTaskDb);
      applyAgentDatabaseSchema(firstAgentDb);
      const firstRepository = new TaskRepository(firstTaskDb, new AgentTaskHistoryContract(firstAgentDb));
      const firstAgentRepository = new AgentSessionRepository(firstAgentDb);
      const firstRuntime = createSchedulerAgentRuntime(firstAgentRepository);
      const task = firstRepository.createBackgroundTask({
        goal: 'Recover terminal projection after restart',
        trigger: {
          type: 'once',
          description: 'One second from now',
          nextRunAt: '2026-07-15T00:00:01.000Z'
        },
        workspacePath: 'F:\\Code\\Roc',
        allowedActions: [],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      });
      const started = createDeferred();
      const linked = createDeferred();
      const originalMarkDispatched = firstRepository.markScheduledOccurrenceDispatched.bind(firstRepository);
      vi.spyOn(firstRepository, 'markScheduledOccurrenceDispatched').mockImplementation((input) => {
        const updated = originalMarkDispatched(input);
        linked.resolve();
        return updated;
      });
      const firstScheduler = new TaskScheduler(firstRepository, {
        startRun: async (request) => {
          const result = await firstRuntime.startRun(request);
          started.resolve();
          return result;
        }
      });

      firstScheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await started.promise;
      await linked.promise;
      await vi.advanceTimersByTimeAsync(1);

      const occurrence = firstTaskDb
        .prepare('SELECT occurrence_key, status, run_id FROM scheduled_occurrences WHERE background_task_id = ?')
        .get(task.id) as { occurrence_key: string; run_id: string; status: string };
      expect(occurrence.status).toBe('dispatched');
      expect(firstAgentDb.prepare('SELECT status FROM agent_runs WHERE id = ?').get(occurrence.run_id)).toEqual({ status: 'completed' });
      expect(firstAgentDb.prepare('SELECT event_type FROM agent_outbox WHERE run_id = ?').get(occurrence.run_id)).toEqual({
        event_type: 'run_completed'
      });

      firstScheduler.stop();
      firstTaskDb.close();
      firstTaskDb = null;
      firstAgentDb.close();
      firstAgentDb = null;

      restartedTaskDb = new Database(taskPath);
      restartedTaskDb.pragma('foreign_keys = ON');
      restartedAgentDb = new Database(agentPath);
      restartedAgentDb.pragma('foreign_keys = ON');
      applyTaskPluginSchema(restartedTaskDb);
      applyAgentDatabaseSchema(restartedAgentDb);
      const outbox = restartedAgentDb
        .prepare('SELECT sequence FROM agent_outbox WHERE run_id = ?')
        .get(occurrence.run_id) as { sequence: number } | undefined;
      if (outbox === undefined) {
        throw new Error('terminal_outbox_missing_after_restart');
      }
      const restartedPlugin = await initializePersistentTaskPlugin(restartedTaskDb, restartedAgentDb);
      const restartedRepository = new TaskRepository(restartedTaskDb, new AgentTaskHistoryContract(restartedAgentDb));
      expect(restartedRepository.getAgentOutboxCursor('task_background_status')).toBe(outbox.sequence);
      expect(
        restartedTaskDb.prepare('SELECT status, terminal_at FROM scheduled_occurrences WHERE occurrence_key = ?').get(occurrence.occurrence_key)
      ).toEqual({ status: 'completed', terminal_at: '2026-07-15T00:00:01.001Z' });
      await restartedPlugin.shutdown();

      restartedTaskDb.close();
      restartedTaskDb = null;
      replayedTaskDb = new Database(taskPath);
      replayedTaskDb.pragma('foreign_keys = ON');
      applyTaskPluginSchema(replayedTaskDb);
      const replayedPlugin = await initializePersistentTaskPlugin(replayedTaskDb, restartedAgentDb);
      const replayedRepository = new TaskRepository(replayedTaskDb, new AgentTaskHistoryContract(restartedAgentDb));
      expect(replayedRepository.getAgentOutboxCursor('task_background_status')).toBe(outbox.sequence);
      expect(
        replayedTaskDb.prepare('SELECT status, terminal_at FROM scheduled_occurrences WHERE occurrence_key = ?').get(occurrence.occurrence_key)
      ).toEqual({ status: 'completed', terminal_at: '2026-07-15T00:00:01.001Z' });
      await replayedPlugin.shutdown();
    } finally {
      replayedTaskDb?.close();
      restartedTaskDb?.close();
      restartedAgentDb?.close();
      firstTaskDb?.close();
      firstAgentDb?.close();
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function createSchedulerAgentRuntime(repository: AgentSessionRepository): AgentPluginRuntime {
  return new AgentPluginRuntime({
    capabilityPreviewProvider: async (input) => createCapabilityPreview(input.requestedCapabilities, input.explicitSkillIds),
    deepAgentExecutor: createTextDeepAgentExecutor(),
    eventBus,
    modelFactory,
    repository
  });
}

function createTextDeepAgentExecutor(): NonNullable<ConstructorParameters<typeof AgentPluginRuntime>[0]['deepAgentExecutor']> {
  return {
    execute(input) {
  return createTestAgentExecution(() => (async function* () {
      yield {
        type: 'assistant_block',
        runId: input.run.id,
        block: {
          kind: 'text',
          blockId: `text-${input.run.id}`,
          phase: 'delta',
          text: 'Scheduled run completed.'
        }
      } satisfies ChatRunEvent;
    })(), completedTestOutcome({ finalMessage: 'Scheduled run completed.' }));
}
  };
}

function createCapabilityPreview(
  requestedCapabilities: ChatStartRunRequest['enabledCapabilities'],
  explicitSkillIds: ChatStartRunRequest['explicitSkillIds'] = []
): AgentCapabilityPreview {
  const compiled = compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic',
    explicitSkillIds,
    mcpApprovalMode: 'fully_automatic',
    mcpServers: [],
    mode: 'chat',
    workflowHint: null,
    requestedCapabilities,
    skills: []
  });
  return {
    runnable: false,
    modelId: 'openai:gpt-4.1',
    builtInTools: [],
    selectedCapabilities: compiled.manifest.resolvedCapabilities,
    requestedCapabilities: compiled.manifest.requestedCapabilities,
    skippedCapabilities: compiled.manifest.skippedCapabilities,
    toolCards: compiled.toolCards,
    skillCards: compiled.skillCards,
    subagents: compiled.subagents,
    interruptOn: compiled.interruptOn,
    manifest: compiled.manifest,
    untrustedContextPolicy: 'external_content_reference_only',
    reason: 'test'
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveValue: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (resolveValue === null) {
        throw new Error('deferred_not_initialized');
      }
      resolveValue();
    }
  };
}

async function initializePersistentTaskPlugin(taskDb: Database.Database, agentDb: Database.Database) {
  const plugin = createTaskPlugin({ agentTaskHistory: new AgentTaskHistoryContract(agentDb) });
  const capabilities = new CapabilityRegistry();
  for (const descriptor of plugin.manifest.capabilities) {
    capabilities.declare(plugin.manifest.id, descriptor);
  }
  await plugin.initialize({
    pluginId: plugin.manifest.id,
    eventBus: createTaskPluginTestEventBus(agentDb),
    capabilities,
    database: createTaskPluginTestDatabaseFacade(taskDb, agentDb),
    config: { get: () => null, set: () => {} },
    secrets: { get: () => null, set: () => {}, clear: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });
  return plugin;
}
