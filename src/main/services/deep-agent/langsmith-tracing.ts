import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { Client } from 'langsmith';
import { RunTree } from 'langsmith/run_trees';
import { AsyncLocalStorageProviderSingleton } from 'langsmith/singletons/traceable';

import type { RunExecutionSnapshotV2 } from '../../../shared/types';

export type AgentLangSmithRunCorrelation = {
  runId: string;
  threadId: string;
  runOrigin: RunExecutionSnapshotV2['runOrigin'];
  manifestHash: string;
};

export type AgentLangSmithTraceCorrelation = AgentLangSmithRunCorrelation & {
  appVersion: string;
};

export type AgentLangSmithTraceSessionV1 = AgentLangSmithTraceCorrelation & {
  schemaVersion: 1;
  projectName: string;
  rootId: string;
  traceId: string;
  dottedOrder: string;
  startTime: number;
};

export type AgentLangSmithTraceSessionStore = {
  create(value: AgentLangSmithTraceSessionV1, createdAt: string): AgentLangSmithTraceSessionV1;
  delete(runId: string): void;
  get(runId: string): AgentLangSmithTraceSessionV1 | null;
};

export type LangSmithRunMetadata = {
  roc_run_id: string;
  roc_thread_id: string;
  roc_run_origin: RunExecutionSnapshotV2['runOrigin'];
  roc_manifest_hash: string;
  roc_app_version: string;
};

type LangSmithTerminalStatus = 'cancelled' | 'completed' | 'failed' | 'interrupted';

export type LangSmithRunTracing = {
  rootId: string;
  session: AgentLangSmithTraceSessionV1;
  runnableConfig: {
    callbacks: [BaseCallbackHandler];
    metadata: LangSmithRunMetadata;
    runName: 'roc.agent.invocation';
    tags: ['roc', 'agent'];
  };
  dispose(): void;
  run<T>(operation: () => T | Promise<T>): Promise<T>;
  finish(input: {
    error: string | null;
    status: LangSmithTerminalStatus;
  }): Promise<void>;
  shutdown(): Promise<void>;
};

export type AgentLangSmithTracingProvider = (
  correlation: AgentLangSmithRunCorrelation
) => LangSmithRunTracing | null;

const metadataKeys = [
  'roc_run_id',
  'roc_thread_id',
  'roc_run_origin',
  'roc_manifest_hash',
  'roc_app_version'
] as const;

const disabledTracingContext = Object.freeze({ tracingEnabled: false as const });

type AgentLangSmithRuntimeSettings = {
  apiKey: string;
  projectName: string;
};

type AgentLangSmithRunTracingManagerOptions = {
  appVersion: string;
  getRuntimeSettings: () => AgentLangSmithRuntimeSettings | null;
  sessions: AgentLangSmithTraceSessionStore;
};

export class AgentLangSmithRunTracingManager {
  private readonly traces = new Map<
    string,
    { correlation: AgentLangSmithRunCorrelation; tracing: LangSmithRunTracing }
  >();

  constructor(private readonly options: AgentLangSmithRunTracingManagerOptions) {}

  getRunTracing(correlation: AgentLangSmithRunCorrelation): LangSmithRunTracing | null {
    const existing = this.traces.get(correlation.runId);
    if (existing !== undefined) {
      requireMatchingCorrelation(existing.correlation, correlation);
      if (this.options.getRuntimeSettings() === null) {
        this.traces.delete(correlation.runId);
        existing.tracing.dispose();
        return null;
      }
      return existing.tracing;
    }
    const persisted = this.options.sessions.get(correlation.runId);
    if (persisted !== null) {
      requireMatchingCorrelation(persisted, correlation);
    }
    const runtimeSettings = this.options.getRuntimeSettings();
    if (runtimeSettings === null) {
      return null;
    }
    const tracing = createLangSmithRunTracing({
      apiKey: runtimeSettings.apiKey,
      projectName: persisted === null ? runtimeSettings.projectName : persisted.projectName,
      correlation: persisted === null
        ? {
            ...correlation,
            appVersion: this.options.appVersion
          }
        : persisted,
      ...(persisted === null ? {} : { session: persisted })
    });
    if (persisted === null) {
      this.options.sessions.create(tracing.session, new Date().toISOString());
    }
    this.traces.set(correlation.runId, { correlation, tracing });
    return tracing;
  }

  async finishRun(input: {
    error: string | null;
    runId: string;
    status: LangSmithTerminalStatus;
  }): Promise<void> {
    let tracing = this.traces.get(input.runId)?.tracing;
    try {
      const persisted = this.options.sessions.get(input.runId);
      if (persisted === null) {
        return;
      }
      const runtimeSettings = this.options.getRuntimeSettings();
      if (runtimeSettings === null) {
        return;
      }
      if (tracing === undefined) {
        tracing = createLangSmithRunTracing({
          apiKey: runtimeSettings.apiKey,
          correlation: persisted,
          projectName: persisted.projectName,
          session: persisted
        });
      }
      await tracing.finish({
        error: input.error,
        status: input.status
      });
    } finally {
      this.traces.delete(input.runId);
      try {
        if (tracing !== undefined) {
          await tracing.shutdown();
        }
      } finally {
        this.options.sessions.delete(input.runId);
      }
    }
  }

  async shutdown(): Promise<void> {
    const traces = [...this.traces.values()].map((entry) => entry.tracing);
    this.traces.clear();
    await Promise.allSettled(traces.map(async (tracing) => await tracing.shutdown()));
  }
}

export async function runWithLangSmithTracing<T>(
  tracing: LangSmithRunTracing | null,
  operation: () => T | Promise<T>
): Promise<T> {
  if (tracing !== null) {
    return await tracing.run(operation);
  }
  return await runInTracingContext(disabledTracingContext, operation);
}

export function createLangSmithRunTracing(input: {
  apiKey: string;
  projectName: string;
  correlation: AgentLangSmithTraceCorrelation;
  session?: AgentLangSmithTraceSessionV1;
}): LangSmithRunTracing {
  const apiKey = input.apiKey.trim();
  if (apiKey.length === 0) {
    throw new Error('agent_langsmith_api_key_missing');
  }
  const projectName = input.projectName.trim();
  if (projectName.length === 0) {
    throw new Error('agent_langsmith_project_name_empty');
  }
  const metadata: LangSmithRunMetadata = {
    roc_run_id: input.correlation.runId,
    roc_thread_id: input.correlation.threadId,
    roc_run_origin: input.correlation.runOrigin,
    roc_manifest_hash: input.correlation.manifestHash,
    roc_app_version: input.correlation.appVersion
  };
  const tags: ['roc', 'agent'] = ['roc', 'agent'];
  if (input.session !== undefined) {
    requireMatchingTraceSession(input.session, input.correlation, projectName);
  }
  const client = new RuntimeRedactingLangSmithClient({
    apiKey,
    apiUrl: 'https://api.smith.langchain.com',
    workspaceId: '',
    debug: false,
    tracingMode: 'langsmith',
    tracingSamplingRate: 1,
    autoBatchTracing: true,
    blockOnRootRunFinalization: false,
    hideInputs: true,
    hideOutputs: true,
    hideMetadata: filterMetadata,
    anonymizer: () => ({ error: '[REDACTED]' }),
    omitTracedRuntimeInfo: true
  });
  const tracer = new LangChainTracer({
    client,
    projectName,
    metadata,
    tags,
    raiseError: false
  });
  const root = new RunTree({
    client,
    inputs: {},
    metadata,
    name: 'roc.agent.run',
    project_name: projectName,
    run_type: 'chain',
    tags,
    tracingEnabled: true,
    ...(input.session === undefined
      ? {}
      : {
          dotted_order: input.session.dottedOrder,
          id: input.session.rootId,
          start_time: input.session.startTime,
          trace_id: input.session.traceId
        })
  });
  const session: AgentLangSmithTraceSessionV1 = input.session === undefined
    ? {
        schemaVersion: 1,
        ...input.correlation,
        projectName,
        rootId: root.id,
        traceId: root.trace_id,
        dottedOrder: root.dotted_order,
        startTime: root.start_time
      }
    : input.session;
  let startPromise: Promise<void> | null = null;
  let finishPromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let disposed = false;

  const start = (): Promise<void> => {
    if (startPromise === null) {
      startPromise = root.postRun();
    }
    return startPromise;
  };

  const dispose = (): void => {
    if (!disposed) {
      disposed = true;
      client.cleanup();
    }
  };

  return {
    rootId: root.id,
    session,
    runnableConfig: {
      callbacks: [tracer],
      metadata,
      runName: 'roc.agent.invocation',
      tags
    },
    dispose,
    run: async <T>(operation: () => T | Promise<T>): Promise<T> => {
      await start();
      return await runInTracingContext(root, operation);
    },
    finish: async (terminal): Promise<void> => {
      if (finishPromise === null) {
        finishPromise = (async () => {
          await start();
          const error = readTerminalError(terminal);
          await root.end({ status: terminal.status }, error);
          await root.patchRun();
        })();
      }
      await finishPromise;
    },
    shutdown: async (): Promise<void> => {
      if (shutdownPromise === null) {
        shutdownPromise = (async () => {
          try {
            await client.awaitPendingTraceBatches();
          } finally {
            dispose();
          }
        })();
      }
      await shutdownPromise;
    }
  };
}

function runInTracingContext<T>(
  context: RunTree | typeof disabledTracingContext,
  operation: () => T | Promise<T>
): Promise<T> {
  const storage = AsyncLocalStorageProviderSingleton.getInstance();
  return new Promise<T>((resolve, reject) => {
    storage.run(context, () => {
      void Promise.resolve().then(operation).then(resolve, reject);
    });
  });
}

function readTerminalError(input: {
  error: string | null;
  status: LangSmithTerminalStatus;
}): string | undefined {
  if (input.status === 'failed' || input.status === 'interrupted') {
    if (input.error === null || input.error.trim().length === 0) {
      throw new Error('agent_langsmith_terminal_error_missing');
    }
    return input.error;
  }
  if (input.error !== null) {
    throw new Error('agent_langsmith_terminal_error_unexpected');
  }
  return undefined;
}

function requireMatchingCorrelation(
  current: AgentLangSmithRunCorrelation,
  next: AgentLangSmithRunCorrelation
): void {
  if (
    current.threadId !== next.threadId ||
    current.runOrigin !== next.runOrigin ||
    current.manifestHash !== next.manifestHash
  ) {
    throw new Error('agent_langsmith_run_correlation_mismatch');
  }
}

function requireMatchingTraceSession(
  session: AgentLangSmithTraceSessionV1,
  correlation: AgentLangSmithTraceCorrelation,
  projectName: string
): void {
  requireMatchingCorrelation(session, correlation);
  if (
    session.runId !== correlation.runId ||
    session.appVersion !== correlation.appVersion ||
    session.projectName !== projectName ||
    session.rootId !== session.traceId
  ) {
    throw new Error('agent_langsmith_trace_session_mismatch');
  }
}

class RuntimeRedactingLangSmithClient extends Client {
  override createRun(
    run: Parameters<Client['createRun']>[0],
    options?: Parameters<Client['createRun']>[1]
  ): Promise<void> {
    const redacted = removeSensitiveRunFields(run);
    if (options === undefined) {
      return super.createRun(redacted);
    }
    return super.createRun(redacted, options);
  }

  override updateRun(
    runId: string,
    run: Parameters<Client['updateRun']>[1],
    options?: Parameters<Client['updateRun']>[2]
  ): Promise<void> {
    const redacted = removeSensitiveRunFields(run);
    if (options === undefined) {
      return super.updateRun(runId, redacted);
    }
    return super.updateRun(runId, redacted, options);
  }
}

function removeSensitiveRunFields<T extends { extra?: Record<string, unknown>; serialized?: unknown }>(run: T): T {
  let runtimeRedactedExtra: Record<string, unknown> | undefined;
  if (run.extra !== undefined && Object.hasOwn(run.extra, 'runtime')) {
    runtimeRedactedExtra = removeRuntimeField(run.extra);
  }
  const hasSerialized = Object.hasOwn(run, 'serialized');
  if (runtimeRedactedExtra === undefined && !hasSerialized) {
    return run;
  }
  const redacted = {
    ...run,
    ...(runtimeRedactedExtra === undefined ? {} : { extra: runtimeRedactedExtra })
  };
  Reflect.deleteProperty(redacted, 'serialized');
  return redacted;
}

function removeRuntimeField(extra: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...extra };
  Reflect.deleteProperty(redacted, 'runtime');
  return redacted;
}

function filterMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const key of metadataKeys) {
    const value = metadata[key];
    if (typeof value === 'string') {
      filtered[key] = value;
    }
  }
  return filtered;
}
