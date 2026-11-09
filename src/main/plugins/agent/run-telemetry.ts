import type { Database as DatabaseConnection } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { ChatAssistantBlock, ChatRunEvent, RunExecutionSnapshot, TaskRun, TokenUsage } from '../../../shared/types';
import {
  contextContractAuditSchema,
  createEmptyContextContractAudit,
  createEmptyTrace,
  runTraceSpanSchema,
  type ContextContractAudit,
  type RunTraceSpan
} from '../../../shared/schemas/run-diagnostics';
import { tokenUsageSchema } from '../../../shared/schemas/token-usage';
import type { ModelInvocationObservation } from '../../services/deep-agent/run-usage-observer';
import {
  TOOL_ADMISSION_RESOURCE_KINDS,
  type ToolAdmissionObservation,
  type ToolAdmissionResourceKind
} from '../../services/deep-agent/tool-resource-coordinator';

const nullableCountSchema = z.number().int().nonnegative().nullable();
const telemetryCountSchema = z.number().int().nonnegative();
const admissionLatencySchema = z.object({
  count: telemetryCountSchema,
  totalMs: telemetryCountSchema,
  maxMs: telemetryCountSchema
}).strict();
const admissionConflictCountsSchema = z.record(z.enum(TOOL_ADMISSION_RESOURCE_KINDS), telemetryCountSchema);
const emptyAdmissionConflictCounts = (): Record<ToolAdmissionResourceKind, number> =>
  Object.fromEntries(TOOL_ADMISSION_RESOURCE_KINDS.map(kind => [kind, 0])) as Record<ToolAdmissionResourceKind, number>;
const createEmptyToolAdmissionSummary = () => ({
  acquisitionCount: 0,
  cancellationCount: 0,
  contendedCount: 0,
  fallbackCount: 0,
  wait: { count: 0, totalMs: 0, maxMs: 0 },
  hold: { count: 0, totalMs: 0, maxMs: 0 },
  conflicts: emptyAdmissionConflictCounts()
});

const traceSchema = z.object({
  spans: z.array(runTraceSpanSchema).max(256),
  droppedSpanCount: telemetryCountSchema
}).strict();

type TraceOperation = RunTraceSpan['operation'];
type TraceStatus = RunTraceSpan['status'];

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
        unknownUsageCallCount: telemetryCountSchema.default(0),
        ...tokenUsageSchema.shape,
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
        capacityTokens: nullableCountSchema,
        lastInputEstimated: z.boolean().nullable().default(null),
        contractAudit: contextContractAuditSchema.default(createEmptyContextContractAudit),
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
    toolAdmission: z.object({
      acquisitionCount: telemetryCountSchema,
      cancellationCount: telemetryCountSchema,
      contendedCount: telemetryCountSchema,
      fallbackCount: telemetryCountSchema,
      wait: admissionLatencySchema,
      hold: admissionLatencySchema,
      conflicts: admissionConflictCountsSchema
    }).strict().default(createEmptyToolAdmissionSummary),
    trace: traceSchema.default(createEmptyTrace),
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

export type AgentModelUsageTelemetry = TokenUsage & {
  callCount: number;
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

  pruneExpired(now: string): number {
    const timestamp = Date.parse(now);
    if (!Number.isFinite(timestamp)) throw new Error('agent_run_telemetry_retention_time_invalid');
    const cutoff = new Date(timestamp - 30 * 24 * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`DELETE FROM agent_run_telemetry
      WHERE updated_at < ? AND json_extract(
        CASE WHEN json_valid(telemetry_json) THEN telemetry_json ELSE '{}' END, '$.terminal.status')
        IN ('completed', 'failed', 'cancelled')`).run(cutoff).changes;
  }
}

export class AgentRunTelemetryAccumulator {
  private readonly telemetry: AgentRunTelemetryV1;
  private readonly observedToolCalls = new Set<string>();
  private readonly observedToolErrors = new Set<string>();
  private readonly observedSubagents = new Set<string>();
  private readonly observedFailedSubagents = new Set<string>();
  private readonly observedEvents = new WeakSet<ChatRunEvent>();
  private observedInvocationUsage = false;
  private readonly activeToolSpans = new Map<string, string>();
  private readonly activeSubagentSpans = new Map<string, string>();
  private readonly activeApprovalSpans = new Map<string, string>();
  private readonly activeCompactionSpans = new Map<string, string>();
  private readonly activeSummarySpans = new Map<string, string>();
  private activeRecoverySpanId: string | null = null;
  private checkpointId: string | null = null;
  private rootSpanId: string | null = null;
  private nextSpanSequence = 0;
  private nextCheckpointSequence = 0;

  constructor(input: {
    existing: AgentRunTelemetryV1 | null;
    run: TaskRun;
    snapshot: RunExecutionSnapshot;
  }) {
    if (input.existing !== null) {
      assertAgentRunTelemetryIdentity(input.existing, input.run, input.snapshot);
      this.telemetry = structuredClone(input.existing);
    } else {
      this.telemetry = createEmptyTelemetry(input.run, input.snapshot);
    }
    this.nextSpanSequence = nextGeneratedSequence(this.telemetry.trace.spans.map(span => span.spanId), 'span');
    this.nextCheckpointSequence = nextGeneratedSequence(
      this.telemetry.trace.spans.flatMap(span => span.checkpointId === null ? [] : [span.checkpointId]),
      'checkpoint'
    );
    this.rootSpanId = this.telemetry.trace.spans.find(span => span.operation === 'run' && span.parentSpanId === null)?.spanId ??
      this.createSpan('run', 'running', 0, null);
    if (input.existing !== null && (input.run.status === 'waiting_user' || input.run.status === 'interrupted')) {
      for (const span of this.telemetry.trace.spans) {
        if (span.status === 'running' && span.operation !== 'run' && span.operation !== 'approval_wait') {
          this.finishSpan(span.spanId, 'interrupted', this.telemetry.runtime.totalDurationMs);
        }
      }
    }
    this.activeRecoverySpanId = [...this.telemetry.trace.spans].reverse().find(span =>
      span.operation === 'recovery' && span.status === 'running')?.spanId ?? null;
    this.checkpointId = [...this.telemetry.trace.spans].reverse().find(span => span.checkpointId !== null)?.checkpointId ?? null;
  }

  observeEvent(event: ChatRunEvent, elapsedMs: number): void {
    if (this.observedEvents.has(event)) return;
    this.observedEvents.add(event);
    this.updateDuration(Math.max(this.telemetry.runtime.totalDurationMs, Math.max(0, Math.round(elapsedMs))));
    if (event.type === 'assistant_block') {
      this.observeFirstOutput(event.block, elapsedMs);
      this.observeToolBlock(event.block, elapsedMs, this.rootSpanId);
      return;
    }
    if (event.type === 'subagent_event') {
      const subagentKey = privateKey(event.identity.subagentId);
      if (event.event.kind === 'started' && !this.observedSubagents.has(subagentKey)) {
        rememberBounded(this.observedSubagents, subagentKey);
        this.telemetry.subagent.count += 1;
        const parent = event.identity.parentSubagentId === null ? this.rootSpanId :
          this.activeSubagentSpans.get(privateKey(event.identity.parentSubagentId)) ?? this.rootSpanId;
        this.startMappedSpan(this.activeSubagentSpans, event.identity.subagentId, 'subagent', elapsedMs, parent);
      }
      if (event.identity.depth > this.telemetry.subagent.maxDepth) {
        this.telemetry.subagent.maxDepth = event.identity.depth;
      }
      if (event.event.kind === 'failed' && !this.observedFailedSubagents.has(subagentKey)) {
        rememberBounded(this.observedFailedSubagents, subagentKey);
        this.telemetry.subagent.failedCount += 1;
      }
      if (event.event.kind === 'assistant_block') {
        this.observeFirstOutput(event.event.block, elapsedMs);
        this.observeToolBlock(event.event.block, elapsedMs, this.activeSubagentSpans.get(subagentKey) ?? this.rootSpanId);
      }
      if (event.event.kind === 'tool_call') {
        this.observeToolBlock(event.event.block, elapsedMs, this.activeSubagentSpans.get(subagentKey) ?? this.rootSpanId);
      }
      if (event.event.kind === 'completed' || event.event.kind === 'failed') {
        this.finishMappedSpan(this.activeSubagentSpans, event.identity.subagentId,
          event.event.kind === 'completed' ? 'completed' : 'failed', elapsedMs);
      }
      return;
    }
    if (event.type === 'context_maintenance') {
      this.observeContextEvent(event, elapsedMs);
    }
    if (event.type === 'run_interrupted') {
      this.startMappedSpan(this.activeApprovalSpans, event.interruptId, 'approval_wait', elapsedMs, this.rootSpanId);
    }
    if (event.type === 'run_resumed') {
      if (!this.activeApprovalSpans.has(privateKey(event.interruptId))) {
        // After a process restart raw interrupt identities are deliberately unavailable in traces.
        // Close old anonymous waits as interrupted, never claim a specific approval completed.
        for (const span of this.telemetry.trace.spans) {
          if (span.operation === 'approval_wait' && span.status === 'running') {
            this.finishSpan(span.spanId, 'interrupted', elapsedMs);
          }
        }
      }
      this.finishMappedSpan(this.activeApprovalSpans, event.interruptId, 'completed', elapsedMs);
      this.recordCheckpointResume(elapsedMs);
    }
    if (event.type === 'run_recovering') {
      this.activeRecoverySpanId = this.createSpan('recovery', 'running', elapsedMs, this.rootSpanId);
    }
    if (event.type === 'run_recovered') {
      this.finishSpan(this.activeRecoverySpanId, 'completed', elapsedMs);
      this.activeRecoverySpanId = null;
    }
  }

  observeModelInvocation(observation: ModelInvocationObservation, elapsedMs: number): void {
    if (this.telemetry.terminal.status !== null && this.telemetry.terminal.status !== 'interrupted') return;
    this.observedInvocationUsage = true;
    if (observation.status !== 'blocked') {
      this.accumulateModelUsage({
        callCount: 1, inputTokens: observation.actualInputTokens, outputTokens: observation.actualOutputTokens,
        totalTokens: observation.actualInputTokens === null || observation.actualOutputTokens === null ? null :
          observation.actualInputTokens + observation.actualOutputTokens,
        cacheReadTokens: observation.actualCacheReadTokens ?? null,
        cacheCreationTokens: observation.actualCacheCreationTokens ?? null
      });
    }
    const contextParent = observation.contextCycleId === undefined ? null :
      this.activeCompactionSpans.get(privateKey(observation.contextCycleId)) ?? null;
    const id = this.createSpan(observation.purpose === 'summary' ? 'summary_model' : 'agent_model',
      observation.status, Math.max(0, elapsedMs - observation.durationMs),
      contextParent ?? this.activeRecoverySpanId ?? this.rootSpanId);
    const span = this.span(id);
    if (span === undefined) return;
    span.durationMs = observation.durationMs;
    span.estimatedInputTokens = observation.estimatedInputTokens;
    span.actualInputTokens = observation.actualInputTokens;
    span.actualOutputTokens = observation.actualOutputTokens;
    span.estimateApproximate = observation.estimateApproximate;
  }

  observeModelUsage(usage: AgentModelUsageTelemetry): void {
    if (!this.observedInvocationUsage) this.accumulateModelUsage(usage);
  }

  private accumulateModelUsage(usage: AgentModelUsageTelemetry): void {
    this.telemetry.model.callCount += usage.callCount;
    if (usage.inputTokens === null || usage.outputTokens === null) {
      this.telemetry.model.unknownUsageCallCount += usage.callCount;
    }
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

  observeToolAdmission(observation: ToolAdmissionObservation): void {
    requireNonNegativeInteger(observation.waitMs, 'agent_run_telemetry_admission_wait_invalid');
    if (observation.status === 'cancelled' && observation.holdMs !== null ||
      observation.status === 'released' && observation.holdMs === null) {
      throw new Error('agent_run_telemetry_admission_hold_invalid');
    }
    if (observation.holdMs !== null) requireNonNegativeInteger(observation.holdMs, 'agent_run_telemetry_admission_hold_invalid');
    this.telemetry.toolAdmission.wait = addDurationSample(this.telemetry.toolAdmission.wait, observation.waitMs);
    const duration = observation.waitMs + (observation.holdMs ?? 0);
    const endOffset = Math.max(this.telemetry.runtime.totalDurationMs, observation.endOffsetMs ?? 0);
    const parent = observation.toolCallId === undefined ? this.rootSpanId :
      this.activeToolSpans.get(privateKey(observation.toolCallId)) ?? this.rootSpanId;
    const span = this.span(this.createSpan('tool_admission',
      observation.status === 'cancelled' ? 'cancelled' : 'completed',
      Math.max(0, endOffset - duration), parent));
    if (span !== undefined) span.durationMs = duration;
    if (observation.conflictKinds.length > 0) this.telemetry.toolAdmission.contendedCount += 1;
    for (const kind of new Set(observation.conflictKinds)) {
      this.telemetry.toolAdmission.conflicts[kind] += 1;
    }
    if (observation.status === 'cancelled') {
      this.telemetry.toolAdmission.cancellationCount += 1;
      return;
    }
    if (observation.holdMs === null) throw new Error('agent_run_telemetry_admission_hold_invalid');
    this.telemetry.toolAdmission.acquisitionCount += 1;
    this.telemetry.toolAdmission.hold = addDurationSample(this.telemetry.toolAdmission.hold, observation.holdMs);
    if (observation.resourceKinds.includes('global_fallback')) this.telemetry.toolAdmission.fallbackCount += 1;
  }

  recordRecovery(): void {
    this.telemetry.runtime.recoveryCount += 1;
  }

  resumeAfterInterruption(): void {
    if (this.telemetry.terminal.status !== 'interrupted') throw new Error('agent_run_telemetry_not_interrupted');
    this.telemetry.terminal = { status: null, errorCode: null, retryable: null, cancelSource: null };
    this.recordRecovery();
    const elapsed = this.telemetry.runtime.totalDurationMs;
    this.recordCheckpointResume(elapsed);
    const root = this.span(this.rootSpanId);
    if (root !== undefined) { root.status = 'running'; root.durationMs = null; }
    for (const pending of this.telemetry.trace.spans.filter(item => item.operation === 'approval_wait' && item.status === 'running')) {
      this.finishSpan(pending.spanId, 'completed', elapsed);
    }
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
    for (const span of this.telemetry.trace.spans) {
      if (span.status !== 'running') continue;
      if (input.status === 'interrupted' && span.operation === 'approval_wait') continue;
      this.finishSpan(span.spanId, input.status, input.durationMs);
    }
    this.activeToolSpans.clear();
    this.activeSubagentSpans.clear();
    this.activeCompactionSpans.clear();
    this.activeSummarySpans.clear();
    if (input.status !== 'interrupted') this.activeApprovalSpans.clear();
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

  private observeToolBlock(block: ChatAssistantBlock, elapsedMs: number, parent: string | null): void {
    if (block.kind !== 'tool_call') {
      return;
    }
    const blockKey = privateKey(block.blockId);
    if (block.phase === 'start' && !this.observedToolCalls.has(blockKey)) {
      rememberBounded(this.observedToolCalls, blockKey);
      this.telemetry.tool.callCount += 1;
      this.startMappedSpan(this.activeToolSpans, block.callId, 'tool_effect', elapsedMs, parent);
    }
    if (block.phase === 'error' && !this.observedToolErrors.has(blockKey)) {
      rememberBounded(this.observedToolErrors, blockKey);
      this.telemetry.tool.errorCount += 1;
    }
    if (block.phase === 'end' || block.phase === 'error') {
      this.finishMappedSpan(this.activeToolSpans, block.callId, block.phase === 'end' ? 'completed' : 'failed', elapsedMs);
    }
  }

  private observeContextEvent(event: Extract<ChatRunEvent, { type: 'context_maintenance' }>, elapsedMs: number): void {
    const key = event.cycleId ?? 'legacy';
    if (event.event === 'context_compaction_started') {
      this.telemetry.context.compactionCount += 1;
      this.startMappedSpan(this.activeCompactionSpans, key, 'context_compaction', elapsedMs, this.rootSpanId);
    }
    if (event.event === 'context_summary_started') {
      this.startMappedSpan(this.activeSummarySpans, key, 'context_summary', elapsedMs,
        this.activeCompactionSpans.get(privateKey(key)) ?? this.rootSpanId);
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
    if (event.event === 'context_summary_completed' || event.event === 'context_summary_skipped' ||
      event.event === 'context_compaction_failed') {
      const status = event.event === 'context_compaction_failed' ? 'failed' :
        event.event === 'context_summary_skipped' ? 'skipped' : 'completed';
      this.finishMappedSpan(this.activeSummarySpans, key, status, elapsedMs);
      this.finishMappedSpan(this.activeCompactionSpans, key,
        status === 'skipped' ? 'completed' : status, elapsedMs);
    }
    if (event.contractAudit !== undefined) this.observeContractAudit(event.contractAudit);
    if (event.estimated === true) {
      this.telemetry.context.estimatedCount += 1;
    }
    if (event.inputTokens !== undefined) {
      this.telemetry.context.inputTokens = event.inputTokens;
      this.telemetry.context.lastInputEstimated = event.estimated ?? null;
    }
    if (event.capacityTokens !== undefined) {
      this.telemetry.context.capacityTokens = event.capacityTokens;
    }
    if (event.removedChars !== undefined) {
      this.telemetry.context.removedChars += event.removedChars;
    }
    if (event.persistedChars !== undefined) {
      this.telemetry.context.persistedChars += event.persistedChars;
    }
  }

  private observeContractAudit(audit: ContextContractAudit): void {
    this.telemetry.context.contractAudit = contextContractAuditSchema.parse(audit);
  }

  private recordCheckpointResume(elapsedMs: number): void {
    // Opaque checkpoint aliases never contain LangGraph checkpoint namespaces or provider data.
    this.checkpointId = this.nextCheckpointSequence >= 999999 ? null : `checkpoint-${++this.nextCheckpointSequence}`;
    const span = this.span(this.createSpan('checkpoint_resume', 'completed', elapsedMs, this.rootSpanId));
    if (span !== undefined) span.durationMs = 0;
  }

  private span(id: string | null): RunTraceSpan | undefined {
    return id === null ? undefined : this.telemetry.trace.spans.find(item => item.spanId === id);
  }

  private createSpan(operation: TraceOperation, status: TraceStatus, startOffsetMs: number, parentSpanId: string | null): string | null {
    if (this.telemetry.trace.spans.length >= 256 || this.nextSpanSequence >= 999999) {
      this.telemetry.trace.droppedSpanCount += 1;
      return null;
    }
    const sequence = ++this.nextSpanSequence;
    const span = runTraceSpanSchema.parse({
      spanId: `span-${sequence}`, operationId: `operation-${sequence}`, parentSpanId,
      checkpointId: this.checkpointId, operation, status, startOffsetMs: Math.max(0, Math.round(startOffsetMs)),
      durationMs: null, estimatedInputTokens: null, actualInputTokens: null, actualOutputTokens: null,
      estimateApproximate: null
    });
    this.telemetry.trace.spans.push(span);
    return span.spanId;
  }

  private startMappedSpan(map: Map<string, string>, key: string, operation: TraceOperation, elapsedMs: number, parent: string | null): void {
    const alias = privateKey(key);
    if (map.has(alias)) return;
    const id = this.createSpan(operation, 'running', elapsedMs, parent);
    if (id !== null) map.set(alias, id);
  }

  private finishMappedSpan(map: Map<string, string>, key: string, status: TraceStatus, elapsedMs: number): void {
    const alias = privateKey(key);
    this.finishSpan(map.get(alias) ?? null, status, elapsedMs);
    map.delete(alias);
  }

  private finishSpan(id: string | null, status: TraceStatus, elapsedMs: number): void {
    const span = this.span(id);
    if (span === undefined) return;
    span.status = status;
    span.durationMs = Math.max(0, Math.round(elapsedMs) - span.startOffsetMs);
  }
}

function nextGeneratedSequence(ids: readonly string[], prefix: string): number {
  return Math.max(0, ...ids.map(id => Number(id.slice(prefix.length + 1))));
}

function privateKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function rememberBounded(values: Set<string>, key: string): void {
  if (values.size >= 1024) values.delete(values.values().next().value!);
  values.add(key);
}

function createEmptyTelemetry(run: TaskRun, snapshot: RunExecutionSnapshot): AgentRunTelemetryV1 {
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
      unknownUsageCallCount: 0,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
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
      capacityTokens: null,
      lastInputEstimated: null,
      contractAudit: createEmptyContextContractAudit(),
      removedChars: 0,
      persistedChars: 0
    },
    runtime: {
      firstOutputMs: null,
      totalDurationMs: 0,
      recoveryCount: 0
    },
    toolAdmission: createEmptyToolAdmissionSummary(),
    trace: createEmptyTrace(),
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
  snapshot: RunExecutionSnapshot
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

function addDurationSample(
  aggregate: AgentRunTelemetryV1['toolAdmission']['wait'],
  durationMs: number
): AgentRunTelemetryV1['toolAdmission']['wait'] {
  return {
    count: aggregate.count + 1,
    totalMs: aggregate.totalMs + durationMs,
    maxMs: Math.max(aggregate.maxMs, durationMs)
  };
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
