import Database from 'better-sqlite3';
import type { BaseStore } from '@langchain/langgraph';
import { Client } from 'langsmith';
import { describe, expect, it, vi } from 'vitest';

import type { TaskRun } from '../../../../src/shared/types';
import { createAgentPlugin } from '../../../../src/main/plugins/agent';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocPluginContext } from '../../../../src/main/kernel/types';
import { AgentLangSmithTraceSessionRepository } from '../../../../src/main/plugins/agent/langsmith-trace-session-repository';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';
import { AgentTaskHistoryReader } from '../../../../src/main/plugins/task/agent-task-history';
import { applyTaskPluginSchema } from '../../../../src/main/plugins/task/schema';
import { TaskRepository } from '../../../../src/main/plugins/task/task-repository';
import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { RocPaths } from '../../../../src/main/services/paths';

const mocked = vi.hoisted(() => ({
  createAgentDeepAgentExecutor: vi.fn((_options: { store: BaseStore }) => ({
    execute: async function* () {}
  }))
}));

vi.mock('../../../../src/main/plugins/agent/deep-agent-executor', () => ({
  createAgentDeepAgentExecutor: mocked.createAgentDeepAgentExecutor
}));

const agentCapabilities = [
  'agent.status.get',
  'agent.config.preview',
  'agent.run.start',
  'agent.run.cancel',
  'agent.run.resume',
  'agent.run.events.list',
  'agent.run.active.get',
  'agent.sessions.list',
  'agent.sessions.search',
  'agent.langsmith.settings.get',
  'agent.langsmith.settings.save',
  'agent.langsmith.secret.set',
  'agent.langsmith.secret.clear'
];

const agentCapabilitiesWithPreview = [...agentCapabilities, 'agent.capability.preview'];

describe('agent plugin manifest', () => {
  it('declares the Phase 2 critical agent plugin contract', () => {
    const plugin = createAgentPlugin();

    expect(plugin.manifest.id).toBe('@roc/plugin-agent');
    expect(plugin.manifest.loadPhase).toBe('critical');
    expect(plugin.manifest.required).toBe(true);
    expect(plugin.manifest.dependencies).toEqual(['@roc/plugin-workspace']);
    expect(plugin.manifest.capabilities.map((capability) => capability.name)).toEqual(agentCapabilities);
  });

  it('declares plugin dependencies when the capability preview API is enabled', () => {
    const plugin = createAgentPlugin({
      capabilityPreview: {
        deleteFileApprovalModeProvider: () => 'fully_automatic',
        mcpApprovalModeProvider: () => 'fully_automatic'
      }
    });

    expect(plugin.manifest.dependencies).toEqual(['@roc/plugin-workspace', '@roc/plugin-mcp', '@roc/plugin-skills']);
    expect(plugin.manifest.capabilities.map((capability) => capability.name)).toEqual(agentCapabilitiesWithPreview);
  });

  it('declares plugin dependencies when the DeepAgent executor is enabled', () => {
    const plugin = createAgentPlugin({
      deepAgentExecutor: {
        appVersion: '0.1.0',
        paths: new RocPaths('F:\\Code\\Roc')
      }
    });

    expect(plugin.manifest.dependencies).toEqual([
      '@roc/plugin-workspace',
      '@roc/plugin-mcp',
      '@roc/plugin-skills',
      '@roc/plugin-runtime-tools'
    ]);
    expect(Reflect.get(plugin.manifest, 'capabilityDependencies')).toEqual(['@roc/plugin-task']);
  });

  it('creates the DeepAgent executor with runtime stores outside core.db', async () => {
    const agentDb = new Database(':memory:');
    const memoryDb = new Database(':memory:');
    const taskDb = new Database(':memory:');
    const coreDb = new Database(':memory:');
    try {
      const plugin = createAgentPlugin({
        deepAgentExecutor: {
          appVersion: '0.1.0',
          paths: new RocPaths('F:\\Code\\Roc')
        }
      });

      const context = createContext(agentDb, memoryDb, taskDb, coreDb);
      for (const capability of plugin.manifest.capabilities) {
        context.capabilities.declare(plugin.manifest.id, capability);
      }
      await plugin.initialize(context);

      const options = mocked.createAgentDeepAgentExecutor.mock.calls[0]?.[0] as { store: BaseStore } | undefined;
      expect(options?.store.constructor.name).toBe('RocSqliteStore');
      expect(agentDb.prepare("SELECT name FROM sqlite_master WHERE name = 'langgraph_checkpoints'").pluck().get()).toBe(
        'langgraph_checkpoints'
      );
      expect(agentDb.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_tool_effects'").pluck().get()).toBe(
        'agent_tool_effects'
      );
      expect(memoryDb.prepare("SELECT name FROM sqlite_master WHERE name = 'langgraph_store_items'").pluck().get()).toBe(
        'langgraph_store_items'
      );
      expect(coreDb.prepare("SELECT name FROM sqlite_master WHERE name = 'langgraph_store_items'").pluck().get()).toBeUndefined();
    } finally {
      agentDb.close();
      memoryDb.close();
      taskDb.close();
      coreDb.close();
    }
  });

  it('reconciles persisted agent runs during plugin initialization', async () => {
    const agentDb = new Database(':memory:');
    const memoryDb = new Database(':memory:');
    const taskDb = new Database(':memory:');
    const coreDb = new Database(':memory:');
    const reconcileStartupRuns = vi.spyOn(AgentSessionRepository.prototype, 'reconcileStartupRuns');
    const startedAt = '2026-07-26T00:00:00.000Z';
    const reconciledRun: TaskRun = {
      id: 'run_startup_interrupted',
      threadId: 'thread_startup_interrupted',
      runNumber: 1,
      userInput: 'Resume after restart',
      status: 'interrupted',
      startedAt,
      endedAt: '2026-07-26T00:00:01.000Z',
      modelId: 'openai:gpt-4.1',
      enabledCapabilities: { mcpServers: [], skills: [] }
    };
    try {
      applyAgentDatabaseSchema(agentDb);
      agentDb.prepare(
        `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
         VALUES (?, 'chat', 'Startup trace', 'Startup trace', 'interrupted', ?, ?)`
      ).run(reconciledRun.threadId, startedAt, startedAt);
      agentDb.prepare(
        `INSERT INTO agent_runs
         (id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json)
         VALUES (?, ?, 1, ?, 'interrupted', ?, ?, ?, ?)`
      ).run(
        reconciledRun.id,
        reconciledRun.threadId,
        reconciledRun.userInput,
        reconciledRun.startedAt,
        reconciledRun.endedAt,
        reconciledRun.modelId,
        JSON.stringify(reconciledRun.enabledCapabilities)
      );
      new AgentLangSmithTraceSessionRepository(agentDb).create({
        schemaVersion: 1,
        runId: reconciledRun.id,
        threadId: reconciledRun.threadId,
        runOrigin: 'chat',
        manifestHash: 'a'.repeat(64),
        appVersion: '0.1.0',
        projectName: 'roc-production',
        rootId: '11111111-1111-4111-8111-111111111111',
        traceId: '11111111-1111-4111-8111-111111111111',
        dottedOrder: '20260726T000000000Z11111111-1111-4111-8111-111111111111',
        startTime: 1_753_488_000_000
      }, startedAt);
      reconcileStartupRuns.mockReturnValue([reconciledRun]);
      const plugin = createAgentPlugin({
        deepAgentExecutor: {
          appVersion: '0.1.0',
          paths: new RocPaths('F:\\Code\\Roc')
        }
      });
      const context = createContext(agentDb, memoryDb, taskDb, coreDb);
      for (const capability of plugin.manifest.capabilities) {
        context.capabilities.declare(plugin.manifest.id, capability);
      }

      await plugin.initialize(context);

      expect(reconcileStartupRuns).toHaveBeenCalledTimes(1);
      expect(
        agentDb.prepare('SELECT COUNT(*) FROM agent_langsmith_trace_sessions WHERE run_id = ?').pluck().get(reconciledRun.id)
      ).toBe(0);
      await plugin.shutdown();
    } finally {
      reconcileStartupRuns.mockRestore();
      agentDb.close();
      memoryDb.close();
      taskDb.close();
      coreDb.close();
    }
  });

  it('reconciles a trace session left after the run reached a terminal state', async () => {
    const agentDb = new Database(':memory:');
    const memoryDb = new Database(':memory:');
    const taskDb = new Database(':memory:');
    const coreDb = new Database(':memory:');
    const startedAt = '2026-07-26T00:00:00.000Z';
    const createRun = vi.spyOn(Client.prototype, 'createRun').mockResolvedValue();
    const updateRun = vi.spyOn(Client.prototype, 'updateRun').mockResolvedValue();
    try {
      applyAgentDatabaseSchema(agentDb);
      agentDb.prepare(
        `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
         VALUES
           ('thread_terminal_trace', 'chat', 'Terminal trace', 'Terminal trace', 'failed', ?, ?),
           ('thread_waiting_trace', 'chat', 'Waiting trace', 'Waiting trace', 'waiting_user', ?, ?)`
      ).run(startedAt, startedAt, startedAt, startedAt);
      agentDb.prepare(
        `INSERT INTO agent_runs
         (id, thread_id, run_number, user_input, status, started_at, ended_at, enabled_capabilities_json)
         VALUES
           ('run_terminal_trace', 'thread_terminal_trace', 1, 'Terminal trace', 'failed', ?, ?, '{}'),
           ('run_waiting_trace', 'thread_waiting_trace', 1, 'Waiting trace', 'waiting_user', ?, NULL, '{}')`
      ).run(startedAt, '2026-07-26T00:00:01.000Z', startedAt);
      const traceSessions = new AgentLangSmithTraceSessionRepository(agentDb);
      traceSessions.create({
        schemaVersion: 1,
        runId: 'run_terminal_trace',
        threadId: 'thread_terminal_trace',
        runOrigin: 'chat',
        manifestHash: 'a'.repeat(64),
        appVersion: '0.1.0',
        projectName: 'roc-production',
        rootId: '11111111-1111-4111-8111-111111111111',
        traceId: '11111111-1111-4111-8111-111111111111',
        dottedOrder: '20260726T000000000Z11111111-1111-4111-8111-111111111111',
        startTime: 1_753_488_000_000
      }, startedAt);
      traceSessions.create({
        schemaVersion: 1,
        runId: 'run_waiting_trace',
        threadId: 'thread_waiting_trace',
        runOrigin: 'chat',
        manifestHash: 'b'.repeat(64),
        appVersion: '0.1.0',
        projectName: 'roc-production',
        rootId: '22222222-2222-4222-8222-222222222222',
        traceId: '22222222-2222-4222-8222-222222222222',
        dottedOrder: '20260726T000000000Z22222222-2222-4222-8222-222222222222',
        startTime: 1_753_488_000_000
      }, startedAt);
      const plugin = createAgentPlugin({
        deepAgentExecutor: {
          appVersion: '0.1.0',
          paths: new RocPaths('F:\\Code\\Roc')
        }
      });
      const context = createContext(agentDb, memoryDb, taskDb, coreDb);
      vi.spyOn(context.config, 'get').mockReturnValue({
        schemaVersion: 1,
        enabled: true,
        projectName: 'roc-production'
      });
      vi.spyOn(context.secrets, 'get').mockReturnValue('lsv2_secret');
      for (const capability of plugin.manifest.capabilities) {
        context.capabilities.declare(plugin.manifest.id, capability);
      }

      await plugin.initialize(context);

      expect(traceSessions.get('run_terminal_trace')).toBeNull();
      expect(traceSessions.get('run_waiting_trace')).not.toBeNull();
      expect(createRun).toHaveBeenCalledTimes(1);
      expect(createRun.mock.calls[0]?.[0]).toMatchObject({
        id: '11111111-1111-4111-8111-111111111111',
        trace_id: '11111111-1111-4111-8111-111111111111'
      });
      expect(updateRun).toHaveBeenCalledTimes(1);
      const update = updateRun.mock.calls[0];
      if (update === undefined) {
        throw new Error('expected_terminal_trace_update');
      }
      expect(update[0]).toBe('11111111-1111-4111-8111-111111111111');
      expect(update[1]).toMatchObject({
        error: 'agent_run_failed_before_trace_cleanup',
        outputs: { status: 'failed' }
      });
      await plugin.shutdown();
    } finally {
      createRun.mockRestore();
      updateRun.mockRestore();
      agentDb.close();
      memoryDb.close();
      taskDb.close();
      coreDb.close();
    }
  });

  it('initializes after a normal background-task placeholder run is persisted', async () => {
    const agentDb = new Database(':memory:');
    const memoryDb = new Database(':memory:');
    const taskDb = new Database(':memory:');
    const coreDb = new Database(':memory:');
    try {
      applyAgentDatabaseSchema(agentDb);
      applyTaskPluginSchema(taskDb);
      const task = new TaskRepository(taskDb, new AgentTaskHistoryReader(agentDb)).createBackgroundTask({
        goal: 'Review the workspace every morning',
        trigger: {
          type: 'manual',
          description: 'Run when requested'
        },
        workspacePath: 'F:\\Code\\Roc',
        allowedActions: [],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      });
      const plugin = createAgentPlugin();
      const context = createContext(agentDb, memoryDb, taskDb, coreDb);
      for (const capability of plugin.manifest.capabilities) {
        context.capabilities.declare(plugin.manifest.id, capability);
      }

      await expect(plugin.initialize(context)).resolves.toBeUndefined();
      expect(
        agentDb.prepare('SELECT snapshot_json, provider_id, model_id, status FROM agent_runs WHERE id = ?').get(task.runId)
      ).toEqual({ snapshot_json: null, provider_id: null, model_id: null, status: 'running' });
    } finally {
      agentDb.close();
      memoryDb.close();
      taskDb.close();
      coreDb.close();
    }
  });
});

describe('agent run schema explicit skills', () => {
  it('accepts explicit skill ids on chat start requests', () => {
    const plugin = createAgentPlugin();
    const startDescriptor = plugin.manifest.capabilities.find((capability) => capability.name === 'agent.run.start');
    const parsed = startDescriptor?.inputSchema.safeParse({
      input: '优化这段代码',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: ['existing-skill']
      },
      explicitSkillIds: ['python-expert']
    });

    expect(parsed?.success).toBe(true);
  });

  it('accepts plan mode chat start requests', () => {
    const plugin = createAgentPlugin();
    const startDescriptor = plugin.manifest.capabilities.find((capability) => capability.name === 'agent.run.start');
    const parsed = startDescriptor?.inputSchema.safeParse({
      input: 'Plan this change',
      mode: 'plan',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      },
      workflowHint: null,
      taskSource: null,
      workspacePath: null
    });

    expect(parsed?.success).toBe(true);
  });

  it('accepts plan mode chat start results', () => {
    const plugin = createAgentPlugin();
    const startDescriptor = plugin.manifest.capabilities.find((capability) => capability.name === 'agent.run.start');
    const parsed = startDescriptor?.outputSchema.safeParse({
      runId: 'run_plan_1',
      mode: 'plan',
      threadId: 'thread_plan_1',
      providerId: 'smoke-provider',
      modelId: 'smoke-model',
      createdAt: '2026-06-25T00:00:00.000Z'
    });

    expect(parsed?.success).toBe(true);
  });

  it('rejects empty explicit skill ids', () => {
    const plugin = createAgentPlugin();
    const startDescriptor = plugin.manifest.capabilities.find((capability) => capability.name === 'agent.run.start');
    const parsed = startDescriptor?.inputSchema.safeParse({
      input: '优化这段代码',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      },
      explicitSkillIds: ['']
    });

    expect(parsed?.success).toBe(false);
  });
});

describe('agent run resume schema', () => {
  it.each([
    { type: 'edit' },
    { type: 'approve', message: 'forged' },
    { type: 'reject', message: '' }
  ])('rejects a malformed HITL decision before runtime execution', (decision) => {
    const parsed = getResumeInputSchema().safeParse(approvalResumeRequest([decision]));

    expect(parsed.success).toBe(false);
  });

  it('rejects an empty HITL decision list', () => {
    expect(getResumeInputSchema().safeParse(approvalResumeRequest([])).success).toBe(false);
  });

  it('accepts approve, reject, and edit decisions without changing their payloads', () => {
    const decisions = [
      { type: 'approve' as const },
      { type: 'reject' as const, message: 'Do not run this command.' },
      {
        type: 'edit' as const,
        editedAction: {
          name: 'run_shell_command',
          args: { command: 'git status' }
        }
      }
    ];
    const parsed = getResumeInputSchema().safeParse(approvalResumeRequest(decisions));

    expect(parsed).toEqual({
      success: true,
      data: approvalResumeRequest(decisions)
    });
  });

  it('rejects unknown fields on question and outer resume requests', () => {
    expect(
      getResumeInputSchema().safeParse({
        kind: 'question',
        runId: 'run-1',
        threadId: 'thread-1',
        interruptId: 'interrupt-1',
        answer: 'Use Roc.',
        decisions: [{ type: 'approve' }]
      }).success
    ).toBe(false);
  });
});

function getResumeInputSchema() {
  const descriptor = createAgentPlugin().manifest.capabilities.find((capability) => capability.name === 'agent.run.resume');
  if (descriptor === undefined) {
    throw new Error('agent_run_resume_descriptor_missing');
  }
  return descriptor.inputSchema;
}

function approvalResumeRequest(decisions: unknown[]) {
  return {
    kind: 'approval' as const,
    runId: 'run-1',
    threadId: 'thread-1',
    interruptId: 'interrupt-1',
    decisions
  };
}

function createContext(
  agentDb: Database.Database,
  memoryDb: Database.Database,
  taskDb: Database.Database,
  coreDb: Database.Database
): RocPluginContext {
  return {
    pluginId: '@roc/plugin-agent',
    eventBus: {
      publish: async () => {},
      subscribe: () => () => {}
    },
    capabilities: new CapabilityRegistry(),
    database: {
      getConnection: () => agentDb,
      getCoreConnection: () => coreDb,
      getAgentConnection: () => agentDb,
      getMemoryConnection: () => memoryDb,
      getTaskConnection: () => taskDb
    },
    config: { get: () => null, set: () => {} },
    secrets: { get: () => null, set: () => {}, clear: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  };
}
