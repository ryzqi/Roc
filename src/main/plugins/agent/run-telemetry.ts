import type { Database as DatabaseConnection } from 'better-sqlite3';
import { z } from 'zod';

import type { ChatAssistantBlock, ChatRunEvent, RunExecutionSnapshotV2, TaskRun } from '../../../shared/types';

const nullableCountSchema = z.number().int().nonnegative().nullable();

const runTelemetrySchema = z
  .object({
    schemaVersion: z.literal(1),
    correlation: z
      .object({
        runId: z.string().min(1),
        threadId: z.string().min(1),
        runOrigin: z.enum(['background_schedule', 'chat', 'manual_task_run', 'workbench_creation']),
        dispatchKey: z.string().min(1).nullable(),
        snapshotVersion: z.literal(2),
        manifestHash: z.string().min(1),
        providerId: z.string().min(1),
        modelId: z.string().min(1)
      })
      .strict(),
    model: z
      .object({
        callCount: z.number().int().nonnegative(),
        inputTokens: nullableCountSchema,
        outputTokens: nullableCountSchema,
        totalTokens: nullableCountSchema,
        cacheReadTokens: nullableCountSchema,
        cacheCreationTokens: nullableCountSchema,
        reportedCostUsd: z.number().nonnegative().nullable()
      })
      .strict(),
    tool: z
      .object({
        callCount: z.number().int().nonnegative(),
        errorCount: z.number().int().nonnegative()
      })
      .strict(),
    subagent: z
      .object({
        count: z.number().int().nonnegative(),
        failedCount: z.number().int().nonnegative(),
        maxDepth: z.number().int().nonnegative()
      })
      .strict(),
    context: z
      .object({
        compactionCount: z.number().int().nonnegative(),
        summaryCount: z.number().int().nonnegative(),
        artifactCount: z.number().int().nonnegative(),
        failureCount: z.number().int().nonnegative(),
        estimatedCount: z.number().int().nonnegative(),
        inputTokens: nullableCountSchema,
        budgetTokens: nullableCountSchema,
        removedChars: z.number().int().nonnegative(),
        persistedChars: z.number().int().nonnegative()
      })
      .strict(),
    runtime: z
      .object({
        firstOutputMs: nullableCountSchema,
        totalDurationMs: z.number().int().nonnegative(),
        recoveryCount: z.number().int().nonnegative()
      })
      .strict(),
    terminal: z
      .object({
        status: z.enum(['cancelled', 'completed', 'failed', 'interrupted']).nullable(),
        errorCode: z.string().min(1).nullable(),
        retryable: z.boolean().nullable(),
        cancelSource: z.literal('user_cancelled').nullable()
      })
      .strict()
  })
  .strict();

export type AgentRunTelemetryV1 = z.infer<typeof runTelemetrySchema>;

export type AgentModelUsageTelemetry = {
  callCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
};

type AgentRunTelemetryRow = {
  run_id: string;
  schema_version: number;
  telemetry_json: string;
};

export class AgentRunTelemetryRepository {
  constructor(private readonly db: DatabaseConnection) {}

  save(value: unknown, updatedAt: string): AgentRunTelemetryV1 {
    const parsed = runTelemetrySchema.safeParse(value);
    if (!parsed.success) {
      throw new Error('agent_run_telemetry_invalid');
    }
    const telemetry = parsed.data;
    this.db
      .prepare(
        `INSERT INTO agent_run_telemetry
         (run_id, schema_version, telemetry_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           telemetry_json = excluded.telemetry_json,
           updated_at = excluded.updated_at`
      )
      .run(
        telemetry.correlation.runId,
        telemetry.schemaVersion,
        JSON.stringify(telemetry),
        updatedAt,
        updatedAt
      );
    return telemetry;
  }

  get(runId: string): AgentRunTelemetryV1 | null {
    const row = this.db
      .prepare('SELECT run_id, schema_version, telemetry_json FROM agent_run_telemetry WHERE run_id = ?')
      .get(runId) as AgentRunTelemetryRow | undefined;
    if (row === undefined) {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(row.telemetry_json) as unknown;
    } catch {
      throw new Error('agent_run_telemetry_corrupt');
    }
    const parsed = runTelemetrySchema.safeParse(value);
    if (
      !parsed.success ||
      row.schema_version !== 1 ||
      parsed.data.schemaVersion !== row.schema_version ||
      parsed.data.correlation.runId !== row.run_id
    ) {
      throw new Error('agent_run_telemetry_corrupt');
    }
    return parsed.data;
  }

}

export class AgentRunTelemetryAccumulator {
  private readonly telemetry: AgentRunTelemetryV1;
  private readonly observedToolCalls = new Set<string>();
  private readonly observedToolErrors = new Set<string>();
  private readonly observedSubagents = new Set<string>();
  private readonly observedFailedSubagents = new Set<string>();

  constructor(input: {
    existing: AgentRunTelemetryV1 | null;
    run: TaskRun;
    snapshot: RunExecutionSnapshotV2;
  }) {
    if (input.existing !== null) {
      assertAgentRunTelemetryIdentity(input.existing, input.run, input.snapshot);
      this.telemetry = structuredClone(input.existing);
      return;
    }
    this.telemetry = createEmptyTelemetry(input.run, input.snapshot);
  }

  observeEvent(event: ChatRunEvent, elapsedMs: number): void {
    if (event.type === 'assistant_block') {
      this.observeFirstOutput(event.block, elapsedMs);
      this.observeToolBlock(event.block);
      return;
    }
    if (event.type === 'subagent_event') {
      if (event.event.kind === 'started' && !this.observedSubagents.has(event.identity.subagentId)) {
        this.observedSubagents.add(event.identity.subagentId);
        this.telemetry.subagent.count += 1;
      }
      if (event.identity.depth > this.telemetry.subagent.maxDepth) {
        this.telemetry.subagent.maxDepth = event.identity.depth;
      }
      if (event.event.kind === 'failed' && !this.observedFailedSubagents.has(event.identity.subagentId)) {
        this.observedFailedSubagents.add(event.identity.subagentId);
        this.telemetry.subagent.failedCount += 1;
      }
      if (event.event.kind === 'assistant_block') {
        this.observeFirstOutput(event.event.block, elapsedMs);
        this.observeToolBlock(event.event.block);
      }
      if (event.event.kind === 'tool_call') {
        this.observeToolBlock(event.event.block);
      }
      return;
    }
    if (event.type === 'context_maintenance') {
      this.observeContextEvent(event);
    }
  }

  observeModelUsage(usage: AgentModelUsageTelemetry): void {
    this.telemetry.model.callCount += usage.callCount;
    this.telemetry.model.inputTokens = addNullableCount(this.telemetry.model.inputTokens, usage.inputTokens);
    this.telemetry.model.outputTokens = addNullableCount(this.telemetry.model.outputTokens, usage.outputTokens);
    this.telemetry.model.totalTokens = addNullableCount(this.telemetry.model.totalTokens, usage.totalTokens);
    this.telemetry.model.cacheReadTokens = addNullableCount(
      this.telemetry.model.cacheReadTokens,
      usage.cacheReadTokens
    );
    this.telemetry.model.cacheCreationTokens = addNullableCount(
      this.telemetry.model.cacheCreationTokens,
      usage.cacheCreationTokens
    );
  }

  recordRecovery(): void {
    this.telemetry.runtime.recoveryCount += 1;
  }

  updateDuration(durationMs: number): void {
    requireNonNegativeInteger(durationMs, 'agent_run_telemetry_duration_invalid');
    this.telemetry.runtime.totalDurationMs = durationMs;
  }

  markTerminal(input: {
    status: 'cancelled' | 'completed' | 'failed' | 'interrupted';
    durationMs: number;
    errorCode: string | null;
    retryable: boolean | null;
    cancelSource: 'user_cancelled' | null;
  }): void {
    this.updateDuration(input.durationMs);
    this.telemetry.terminal = {
      status: input.status,
      errorCode: input.errorCode,
      retryable: input.retryable,
      cancelSource: input.cancelSource
    };
  }

  snapshot(): AgentRunTelemetryV1 {
    return structuredClone(this.telemetry);
  }

  private observeFirstOutput(block: ChatAssistantBlock, elapsedMs: number): void {
    if (this.telemetry.runtime.firstOutputMs !== null) {
      return;
    }
    if (block.kind === 'tool_call') {
      return;
    }
    if (block.phase !== 'delta' || block.text === undefined || block.text.length === 0) {
      return;
    }
    requireNonNegativeInteger(elapsedMs, 'agent_run_telemetry_first_output_invalid');
    this.telemetry.runtime.firstOutputMs = elapsedMs;
  }

  private observeToolBlock(block: ChatAssistantBlock): void {
    if (block.kind !== 'tool_call') {
      return;
    }
    if (block.phase === 'start' && !this.observedToolCalls.has(block.blockId)) {
      this.observedToolCalls.add(block.blockId);
      this.telemetry.tool.callCount += 1;
    }
    if (block.phase === 'error' && !this.observedToolErrors.has(block.blockId)) {
      this.observedToolErrors.add(block.blockId);
      this.telemetry.tool.errorCount += 1;
    }
  }

  private observeContextEvent(event: Extract<ChatRunEvent, { type: 'context_maintenance' }>): void {
    if (event.event === 'context_compaction_started') {
      this.telemetry.context.compactionCount += 1;
    }
    if (event.event === 'context_summary_completed') {
      this.telemetry.context.summaryCount += 1;
    }
    if (event.event === 'context_tool_result_persisted') {
      this.telemetry.context.artifactCount += 1;
    }
    if (event.event === 'context_compaction_failed') {
      this.telemetry.context.failureCount += 1;
    }
    if (event.estimated === true) {
      this.telemetry.context.estimatedCount += 1;
    }
    if (event.inputTokens !== undefined) {
      this.telemetry.context.inputTokens = event.inputTokens;
    }
    if (event.budgetTokens !== undefined) {
      this.telemetry.context.budgetTokens = event.budgetTokens;
    }
    if (event.removedChars !== undefined) {
      this.telemetry.context.removedChars += event.removedChars;
    }
    if (event.persistedChars !== undefined) {
      this.telemetry.context.persistedChars += event.persistedChars;
    }
  }
}

function createEmptyTelemetry(run: TaskRun, snapshot: RunExecutionSnapshotV2): AgentRunTelemetryV1 {
  return {
    schemaVersion: 1,
    correlation: {
      runId: run.id,
      threadId: run.threadId,
      runOrigin: snapshot.runOrigin,
      dispatchKey: snapshot.dispatchKey,
      snapshotVersion: 2,
      manifestHash: snapshot.capabilityManifest.manifestHash,
      providerId: snapshot.model.providerId,
      modelId: snapshot.model.modelId
    },
    model: {
      callCount: 0,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      reportedCostUsd: null
    },
    tool: {
      callCount: 0,
      errorCount: 0
    },
    subagent: {
      count: 0,
      failedCount: 0,
      maxDepth: 0
    },
    context: {
      compactionCount: 0,
      summaryCount: 0,
      artifactCount: 0,
      failureCount: 0,
      estimatedCount: 0,
      inputTokens: null,
      budgetTokens: null,
      removedChars: 0,
      persistedChars: 0
    },
    runtime: {
      firstOutputMs: null,
      totalDurationMs: 0,
      recoveryCount: 0
    },
    terminal: {
      status: null,
      errorCode: null,
      retryable: null,
      cancelSource: null
    }
  };
}

export function assertAgentRunTelemetryIdentity(
  telemetry: AgentRunTelemetryV1,
  run: TaskRun,
  snapshot: RunExecutionSnapshotV2
): void {
  const correlation = telemetry.correlation;
  if (
    correlation.runId !== run.id ||
    correlation.threadId !== run.threadId ||
    correlation.runOrigin !== snapshot.runOrigin ||
    correlation.dispatchKey !== snapshot.dispatchKey ||
    correlation.manifestHash !== snapshot.capabilityManifest.manifestHash ||
    correlation.providerId !== snapshot.model.providerId ||
    correlation.modelId !== snapshot.model.modelId
  ) {
    throw new Error('agent_run_telemetry_identity_mismatch');
  }
}

export function calculateAgentRunTelemetryDurationMs(startedAt: string, endedAt: string): number {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    throw new Error('agent_run_telemetry_started_at_invalid');
  }
  const endedAtMs = Date.parse(endedAt);
  if (!Number.isFinite(endedAtMs)) {
    throw new Error('agent_run_telemetry_ended_at_invalid');
  }
  const durationMs = endedAtMs - startedAtMs;
  if (durationMs < 0) {
    throw new Error('agent_run_telemetry_clock_invalid');
  }
  return durationMs;
}

function addNullableCount(previous: number | null, next: number | null): number | null {
  if (next === null) {
    return previous;
  }
  if (previous === null) {
    return next;
  }
  return previous + next;
}

function requireNonNegativeInteger(value: number, code: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(code);
  }
}
