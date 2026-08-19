import { randomUUID } from 'node:crypto';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { RunnableLambda } from '@langchain/core/runnables';
import Database from 'better-sqlite3';
import type { Client } from 'langsmith';
import { describe, expect, it, vi } from 'vitest';

import { AgentLangSmithTraceSessionRepository } from '../../../../src/main/plugins/agent/langsmith-trace-session-repository';
import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import {
  AgentLangSmithRunTracingManager,
  createLangSmithRunTracing
} from '../../../../src/main/services/deep-agent/langsmith-tracing';

const correlation = {
  runId: 'run_11111111-1111-4111-8111-111111111111',
  threadId: 'thread_22222222-2222-4222-8222-222222222222',
  runOrigin: 'chat' as const,
  manifestHash: 'a'.repeat(64),
  appVersion: '0.1.0'
};

describe('LangSmith run tracing', () => {
  it('reconstructs the same native root after a process restart', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAgentDatabaseSchema(db);
    seedRun(db);
    const sessions = new AgentLangSmithTraceSessionRepository(db);
    const createManager = (projectName: string, appVersion: string) => new AgentLangSmithRunTracingManager({
      appVersion,
      getRuntimeSettings: () => ({
        apiKey: 'lsv2_secret',
        projectName
      }),
      sessions
    });
    const runCorrelation = readRunCorrelation();

    const firstManager = createManager('roc-production', correlation.appVersion);
    const first = firstManager.getRunTracing(runCorrelation);
    if (first === null) {
      throw new Error('expected_initial_langsmith_run_tracing');
    }
    const firstRequests = installTracingFetchCollector(first);
    const runnable = RunnableLambda.from((input: string) => `business-result:${input}`);
    await expect(first.run(async () => await runnable.invoke('initial', first.runnableConfig))).resolves.toBe(
      'business-result:initial'
    );
    await firstManager.shutdown();

    const secondManager = createManager('roc-renamed', '0.2.0');
    const resumed = secondManager.getRunTracing(runCorrelation);
    if (resumed === null) {
      throw new Error('expected_resumed_langsmith_run_tracing');
    }
    const resumedRequests = installTracingFetchCollector(resumed);
    expect(resumed.rootId).toBe(first.rootId);
    expect(sessions.get(correlation.runId)).toMatchObject({
      rootId: first.rootId,
      projectName: 'roc-production',
      appVersion: correlation.appVersion
    });
    const resumedTracer = resumed.runnableConfig.callbacks[0];
    if (!(resumedTracer instanceof LangChainTracer)) {
      throw new Error('expected_resumed_langchain_tracer');
    }
    expect(resumedTracer.projectName).toBe('roc-production');

    await expect(resumed.run(async () => await runnable.invoke('resumed', resumed.runnableConfig))).resolves.toBe(
      'business-result:resumed'
    );
    await secondManager.finishRun({
      error: null,
      runId: correlation.runId,
      status: 'completed'
    });

    const childCreates = await Promise.all(
      [...firstRequests, ...resumedRequests]
        .filter((request) => request.init.method === 'POST' && request.url.endsWith('/runs'))
        .map(readJsonBody)
    );
    expect(
      childCreates.filter((body) => body.name === 'roc.agent.invocation')
    ).toEqual([
      expect.objectContaining({ parent_run_id: first.rootId, trace_id: first.rootId }),
      expect.objectContaining({ parent_run_id: first.rootId, trace_id: first.rootId })
    ]);
    expect(sessions.get(correlation.runId)).toBeNull();
    await secondManager.shutdown();
    db.close();
  });

  it('reuses one native root trace for repeated invocations of the same Roc run', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAgentDatabaseSchema(db);
    seedRun(db);
    const manager = new AgentLangSmithRunTracingManager({
      appVersion: correlation.appVersion,
      getRuntimeSettings: () => ({
        apiKey: 'lsv2_secret',
        projectName: 'roc-production'
      }),
      sessions: new AgentLangSmithTraceSessionRepository(db)
    });
    const runCorrelation = {
      runId: correlation.runId,
      threadId: correlation.threadId,
      runOrigin: correlation.runOrigin,
      manifestHash: correlation.manifestHash
    };

    const first = manager.getRunTracing(runCorrelation);
    const resumed = manager.getRunTracing(runCorrelation);

    if (first === null || resumed === null) {
      throw new Error('expected_langsmith_run_tracing');
    }
    expect(resumed).toBe(first);
    const tracer = first.runnableConfig.callbacks[0];
    if (!(tracer instanceof LangChainTracer)) {
      throw new Error('expected_langchain_tracer');
    }
    const requests = installFetchCollector(tracer.client as Client);
    const runnable = RunnableLambda.from((input: string) => `business-result:${input}`);

    await expect(
      first.run(async () => await runnable.invoke('initial', first.runnableConfig))
    ).resolves.toBe('business-result:initial');
    await expect(
      resumed.run(async () => await runnable.invoke('resumed', resumed.runnableConfig))
    ).resolves.toBe('business-result:resumed');
    await manager.finishRun({
      error: null,
      runId: correlation.runId,
      status: 'completed'
    });

    const creates = await Promise.all(
      requests
        .filter((request) => request.init.method === 'POST' && request.url.endsWith('/runs'))
        .map(readJsonBody)
    );
    expect(creates).toHaveLength(3);
    expect(creates[0]).toMatchObject({
      id: first.rootId,
      trace_id: first.rootId,
      name: 'roc.agent.run'
    });
    expect(creates[0]?.parent_run_id).toBeUndefined();
    expect(creates.slice(1)).toEqual([
      expect.objectContaining({
        parent_run_id: first.rootId,
        trace_id: first.rootId,
        name: 'roc.agent.invocation'
      }),
      expect.objectContaining({
        parent_run_id: first.rootId,
        trace_id: first.rootId,
        name: 'roc.agent.invocation'
      })
    ]);
    expect(
      requests.some((request) =>
        request.init.method === 'PATCH' && request.url.endsWith(`/runs/${first.rootId}`)
      )
    ).toBe(true);
    await manager.shutdown();
    db.close();
  });

  it('releases active tracing and deletes the session when the persisted identity read fails during finish', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAgentDatabaseSchema(db);
    seedRun(db);
    const sessions = new AgentLangSmithTraceSessionRepository(db);
    const manager = new AgentLangSmithRunTracingManager({
      appVersion: correlation.appVersion,
      getRuntimeSettings: () => ({ apiKey: 'lsv2_secret', projectName: 'roc-production' }),
      sessions
    });
    const tracing = manager.getRunTracing(readRunCorrelation());
    if (tracing === null) {
      throw new Error('expected_langsmith_run_tracing');
    }
    const tracer = tracing.runnableConfig.callbacks[0];
    if (!(tracer instanceof LangChainTracer)) {
      throw new Error('expected_langchain_tracer');
    }
    const client = tracer.client as Client;
    const cleanup = vi.spyOn(client, 'cleanup');
    const getSession = vi.spyOn(sessions, 'get');
    getSession.mockImplementationOnce(() => {
      throw new Error('trace_session_read_failed');
    });

    try {
      await expect(manager.finishRun({
        error: null,
        runId: correlation.runId,
        status: 'completed'
      })).rejects.toThrow('trace_session_read_failed');
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(sessions.get(correlation.runId)).toBeNull();
    } finally {
      getSession.mockRestore();
      await manager.shutdown();
      db.close();
    }
  });

  it('waits for active client batches and cleans up the client before manager shutdown completes', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAgentDatabaseSchema(db);
    seedRun(db);
    const manager = new AgentLangSmithRunTracingManager({
      appVersion: correlation.appVersion,
      getRuntimeSettings: () => ({ apiKey: 'lsv2_secret', projectName: 'roc-production' }),
      sessions: new AgentLangSmithTraceSessionRepository(db)
    });
    const tracing = manager.getRunTracing(readRunCorrelation());
    if (tracing === null) {
      throw new Error('expected_langsmith_run_tracing');
    }
    const tracer = tracing.runnableConfig.callbacks[0];
    if (!(tracer instanceof LangChainTracer)) {
      throw new Error('expected_langchain_tracer');
    }
    const client = tracer.client as Client;
    let releasePendingBatches: (() => void) | undefined;
    const pendingBatches = new Promise<void>((resolve) => {
      releasePendingBatches = resolve;
    });
    const awaitPendingTraceBatches = vi
      .spyOn(client, 'awaitPendingTraceBatches')
      .mockReturnValue(pendingBatches);
    const cleanup = vi.spyOn(client, 'cleanup');
    let shutdownSettled = false;
    const shutdown = manager.shutdown().then(() => {
      shutdownSettled = true;
    });

    try {
      await Promise.resolve();
      expect(awaitPendingTraceBatches).toHaveBeenCalledTimes(1);
      expect(shutdownSettled).toBe(false);
    } finally {
      if (releasePendingBatches === undefined) {
        throw new Error('pending_batch_release_missing');
      }
      releasePendingBatches();
      await shutdown;
      db.close();
    }
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('disposes the active client when tracing is disabled between invocations', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAgentDatabaseSchema(db);
    seedRun(db);
    const sessions = new AgentLangSmithTraceSessionRepository(db);
    let enabled = true;
    const manager = new AgentLangSmithRunTracingManager({
      appVersion: correlation.appVersion,
      getRuntimeSettings: () => enabled
        ? { apiKey: 'lsv2_secret', projectName: 'roc-production' }
        : null,
      sessions
    });
    const tracing = manager.getRunTracing(readRunCorrelation());
    if (tracing === null) {
      throw new Error('expected_langsmith_run_tracing');
    }
    const tracer = tracing.runnableConfig.callbacks[0];
    if (!(tracer instanceof LangChainTracer)) {
      throw new Error('expected_langchain_tracer');
    }
    const cleanup = vi.spyOn(tracer.client as Client, 'cleanup');

    enabled = false;
    expect(manager.getRunTracing(readRunCorrelation())).toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(sessions.get(correlation.runId)).not.toBeNull();

    await manager.finishRun({
      error: null,
      runId: correlation.runId,
      status: 'cancelled'
    });
    expect(sessions.get(correlation.runId)).toBeNull();
    await manager.shutdown();
    db.close();
  });

  it('creates one native LangChain tracer with fixed root identity and allowlisted correlation metadata', () => {
    const tracing = createLangSmithRunTracing({
      apiKey: 'lsv2_secret',
      projectName: 'roc-production',
      correlation
    });

    expect(tracing.rootId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
    expect(tracing.runnableConfig.runName).toBe('roc.agent.invocation');
    expect(tracing.runnableConfig.tags).toEqual(['roc', 'agent']);
    expect(tracing.runnableConfig.metadata).toEqual({
      roc_run_id: correlation.runId,
      roc_thread_id: correlation.threadId,
      roc_run_origin: correlation.runOrigin,
      roc_manifest_hash: correlation.manifestHash,
      roc_app_version: correlation.appVersion
    });
    expect(tracing.runnableConfig.callbacks).toHaveLength(1);
    const tracer = tracing.runnableConfig.callbacks[0];
    expect(tracer).toBeInstanceOf(LangChainTracer);
    if (!(tracer instanceof LangChainTracer)) {
      throw new Error('expected_langchain_tracer');
    }
    expect(tracer.projectName).toBe('roc-production');
  });

  it('redacts prompt, reasoning, paths, tool output, errors, token events, and non-allowlisted metadata before fetch', async () => {
    const tracer = createTracer();
    const requests = installFetchCollector(tracer.client as Client);
    const id = randomUUID();

    await (tracer.client as Client).createRun({
      id,
      trace_id: id,
      dotted_order: `20260726T000000000Z${id}`,
      name: 'raw-run',
      run_type: 'chain',
      project_name: 'roc-production',
      inputs: {
        prompt: 'SECRET PROMPT',
        workspacePath: 'F:\\Code\\Roc\\private'
      },
      outputs: {
        reasoning: 'SECRET REASONING',
        toolOutput: 'TOOL OUTPUT '.repeat(10_000)
      },
      error: 'Authorization: Bearer lsv2_secret',
      serialized: {
        id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'],
        kwargs: {
          clientConfig: {
            defaultHeaders: {
              Authorization: 'Bearer provider-secret'
            }
          },
          workspacePath: 'F:\\Code\\Roc\\private'
        }
      },
      events: [
        {
          name: 'new_token',
          time: '2026-07-26T00:00:00.000Z',
          kwargs: { token: 'SECRET TOKEN' }
        }
      ],
      extra: {
        metadata: {
          ...createLangSmithRunTracing({
            apiKey: 'lsv2_secret',
            projectName: 'roc-production',
            correlation
          }).runnableConfig.metadata,
          apiKey: 'lsv2_secret',
          localPath: 'F:\\Code\\Roc\\private',
          rawReasoning: 'SECRET REASONING'
        }
      }
    } as never);

    const body = await readJsonBody(
      requests.find((request) => request.init.method === 'POST' && request.url.endsWith('/runs'))
    );
    expect(body.inputs).toEqual({});
    expect(body.outputs).toEqual({});
    expect(body.error).toBe('[REDACTED]');
    expect(body.extra).toEqual({
      metadata: {
        roc_run_id: correlation.runId,
        roc_thread_id: correlation.threadId,
        roc_run_origin: correlation.runOrigin,
        roc_manifest_hash: correlation.manifestHash,
        roc_app_version: correlation.appVersion
      }
    });
    expect(body.events).toEqual([
      {
        name: 'new_token',
        time: '2026-07-26T00:00:00.000Z'
      }
    ]);
    expect(body.serialized).toBeUndefined();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('F:\\\\Code');
    expect(serialized).not.toContain('lsv2_secret');
    expect(serialized).not.toContain('TOOL OUTPUT');
    expect(serialized).not.toContain('runtime');
  });

  it('finishes an interrupted root with a redacted terminal error', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAgentDatabaseSchema(db);
    seedRun(db);
    const sessions = new AgentLangSmithTraceSessionRepository(db);
    const manager = new AgentLangSmithRunTracingManager({
      appVersion: correlation.appVersion,
      getRuntimeSettings: () => ({ apiKey: 'lsv2_secret', projectName: 'roc-production' }),
      sessions
    });
    const tracing = manager.getRunTracing(readRunCorrelation());
    if (tracing === null) {
      throw new Error('expected_langsmith_run_tracing');
    }
    const requests = installTracingFetchCollector(tracing);

    await tracing.run(async () => 'business-result');
    await manager.finishRun({
      error: 'agent_run_interrupted_on_startup_reconciliation',
      runId: correlation.runId,
      status: 'interrupted'
    });

    const patchRequest = requests.find(
      (request) => request.init.method === 'PATCH' && request.url.endsWith(`/runs/${tracing.rootId}`)
    );
    expect(await readJsonBody(patchRequest)).toMatchObject({
      error: '[REDACTED]'
    });
    expect(sessions.get(correlation.runId)).toBeNull();
    await manager.shutdown();
    db.close();
  });

  it('removes SDK runtime details from manual root POST and PATCH payloads', async () => {
    const tracing = createLangSmithRunTracing({
      apiKey: 'lsv2_secret',
      projectName: 'roc-production',
      correlation
    });
    const requests = installTracingFetchCollector(tracing);

    await expect(tracing.run(async () => 'business-result')).resolves.toBe('business-result');
    await tracing.finish({ error: null, status: 'completed' });

    const rootRequests = requests.filter((request) => request.url.includes(`/runs${request.init.method === 'PATCH' ? `/${tracing.rootId}` : ''}`));
    const bodies = await Promise.all(rootRequests.map(readJsonBody));
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.extra).toEqual({
        metadata: {
          roc_run_id: correlation.runId,
          roc_thread_id: correlation.threadId,
          roc_run_origin: correlation.runOrigin,
          roc_manifest_hash: correlation.manifestHash,
          roc_app_version: correlation.appVersion
        }
      });
      expect(JSON.stringify(body)).not.toContain('runtime');
    }
  });

  it('uses native callback parent ids for graph and tool hierarchy', async () => {
    const tracer = createTracer();
    const requests = installFetchCollector(tracer.client as Client);
    const rootId = randomUUID();
    const toolId = randomUUID();

    await tracer.handleChainStart(
      { id: ['roc', 'agent'] } as never,
      { prompt: 'SECRET PROMPT' },
      rootId,
      undefined,
      ['runtime-tag'],
      { localPath: 'F:\\Code\\Roc' },
      'chain',
      'roc.agent.run'
    );
    await tracer.handleToolStart(
      { id: ['roc', 'tool'] } as never,
      'SECRET TOOL INPUT',
      toolId,
      rootId,
      ['tool-tag'],
      { toolPath: 'F:\\Code\\Roc\\tool' },
      'run_shell_command'
    );
    await tracer.handleToolEnd('SECRET TOOL OUTPUT', toolId);
    await tracer.handleChainEnd({ answer: 'SECRET ANSWER' }, rootId);

    const creates = await Promise.all(
      requests
        .filter((request) => request.init.method === 'POST' && request.url.endsWith('/runs'))
        .map(readJsonBody)
    );
    expect(creates).toHaveLength(2);
    expect(creates[0]).toMatchObject({
      id: rootId,
      trace_id: rootId,
      name: 'roc.agent.run',
      inputs: {}
    });
    expect(creates[0]?.parent_run_id).toBeUndefined();
    expect(creates[1]).toMatchObject({
      id: toolId,
      parent_run_id: rootId,
      trace_id: rootId,
      name: 'run_shell_command',
      inputs: {}
    });
  });

  it('does not fail the callback lifecycle when the exporter rejects', async () => {
    const tracer = createTracer();
    const exporterError = new Error('exporter_unavailable');
    vi.spyOn(tracer.client, 'createRun').mockRejectedValue(exporterError);
    vi.spyOn(tracer.client, 'updateRun').mockRejectedValue(exporterError);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runnable = RunnableLambda.from((input: string) => `business-result:${input}`);

    await expect(runnable.invoke('unchanged', { callbacks: [tracer] })).resolves.toBe(
      'business-result:unchanged'
    );
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('keeps root business and terminal results unchanged when POST and PATCH exporters reject', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAgentDatabaseSchema(db);
    seedRun(db);
    const sessions = new AgentLangSmithTraceSessionRepository(db);
    const manager = new AgentLangSmithRunTracingManager({
      appVersion: correlation.appVersion,
      getRuntimeSettings: () => ({ apiKey: 'lsv2_secret', projectName: 'roc-production' }),
      sessions
    });
    const tracing = manager.getRunTracing(readRunCorrelation());
    if (tracing === null) {
      throw new Error('expected_langsmith_run_tracing');
    }
    const tracer = tracing.runnableConfig.callbacks[0];
    if (!(tracer instanceof LangChainTracer)) {
      throw new Error('expected_langchain_tracer');
    }
    const exporterError = new Error('exporter_unavailable');
    const createRun = vi.spyOn(tracer.client, 'createRun').mockRejectedValue(exporterError);
    const updateRun = vi.spyOn(tracer.client, 'updateRun').mockRejectedValue(exporterError);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(tracing.run(async () => 'business-result')).resolves.toBe('business-result');
    await expect(manager.finishRun({
      error: null,
      runId: correlation.runId,
      status: 'completed'
    })).resolves.toBeUndefined();
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(updateRun).toHaveBeenCalledTimes(1);
    expect(sessions.get(correlation.runId)).toBeNull();

    await manager.shutdown();
    consoleError.mockRestore();
    db.close();
  });
});

function createTracer(): LangChainTracer {
  const tracing = createLangSmithRunTracing({
    apiKey: 'lsv2_secret',
    projectName: 'roc-production',
    correlation
  });
  const tracer = tracing.runnableConfig.callbacks[0];
  if (!(tracer instanceof LangChainTracer)) {
    throw new Error('expected_langchain_tracer');
  }
  return tracer;
}

type CollectedRequest = {
  url: string;
  init: RequestInit;
};

function installFetchCollector(client: Client): CollectedRequest[] {
  const requests: CollectedRequest[] = [];
  Reflect.set(client, 'autoBatchTracing', false);
  Reflect.set(client, 'fetchImplementation', async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init === undefined ? {} : init });
    return new Response(null, { status: 200 });
  });
  return requests;
}

function installTracingFetchCollector(tracing: ReturnType<typeof createLangSmithRunTracing>): CollectedRequest[] {
  const tracer = tracing.runnableConfig.callbacks[0];
  if (!(tracer instanceof LangChainTracer)) {
    throw new Error('expected_langchain_tracer');
  }
  return installFetchCollector(tracer.client as Client);
}

function readRunCorrelation() {
  return {
    runId: correlation.runId,
    threadId: correlation.threadId,
    runOrigin: correlation.runOrigin,
    manifestHash: correlation.manifestHash
  };
}

function seedRun(db: Database.Database): void {
  const startedAt = '2026-07-26T00:00:00.000Z';
  db.prepare(
    `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
     VALUES (?, 'chat', 'Tracing', 'Tracing', 'waiting_user', ?, ?)`
  ).run(correlation.threadId, startedAt, startedAt);
  db.prepare(
    `INSERT INTO agent_runs
     (id, thread_id, run_number, user_input, status, started_at, enabled_capabilities_json)
     VALUES (?, ?, 1, 'Trace', 'waiting_user', ?, '{}')`
  ).run(correlation.runId, correlation.threadId, startedAt);
}

async function readJsonBody(request: CollectedRequest | undefined): Promise<Record<string, unknown>> {
  if (request === undefined || request.init.body === undefined || request.init.body === null) {
    throw new Error('expected_json_request_body');
  }
  return JSON.parse(await new Response(request.init.body).text()) as Record<string, unknown>;
}
