import {z} from 'zod';
import {researchTaskRequestSchema, researchExecutionKindSchema} from './research-tasks';
import {runTraceSpanSchema} from './run-diagnostics';
import {researchProcessResourceUsageSchema} from './research-process-resources';
const count = z.number().int().nonnegative();
const id = z.string().min(1).max(256);
export const taskCallDiagnosticsSchema = z.strictObject({
  sequence: count, runId: id, callId: id, kind: z.enum(['model', 'tool', 'child']),
  state: z.enum(['reserved', 'settled', 'unknown']), reservedTokens: count, actualTokens: count.nullable(),
  reservedCostMicrousd: count.nullable(), actualCostMicrousd: count.nullable(), pricingVersion: id.nullable(),
  createdAt: z.string(), settledAt: z.string().nullable(),
  invocation: z.strictObject({startedAt: z.iso.datetime(), durationMs: count, status: z.enum(['completed','failed'])}).nullable()
});
export const taskCallsPageSchema = z.strictObject({calls: taskCallDiagnosticsSchema.array().max(100), nextSequence: count, hasMore: z.boolean()});
export const taskTelemetrySchema = z.strictObject({
  firstOutputMs: count.nullable(), toolCalls: count, toolErrors: count,
  admission: z.strictObject({acquisitions: count, cancellations: count, waitMs: count, holdMs: count}),
  trace: z.strictObject({spans: runTraceSpanSchema.array().max(256), droppedSpanCount: count})
});
export const taskResourceDiagnosticsSchema = z.strictObject({
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/u), outcome: z.enum(['not_dispatched', 'returned', 'rejected']), recordedAt: z.iso.datetime(),
  usage: researchProcessResourceUsageSchema.nullable(),
  admission: z.strictObject({waitMs: count, holdMs: count}).nullable(),
  probes: z.strictObject({phase: z.enum(['preparation','verification']), kind: z.enum(['runtime_version','environment']),
    outcome: z.enum(['returned','rejected']), usage: researchProcessResourceUsageSchema.nullable(),
    admission: z.strictObject({waitMs: count, holdMs: count}).nullable()}).array().max(4)
});
export const taskExecutionDiagnosticsRequestSchema = researchTaskRequestSchema.extend({
  executionKind: researchExecutionKindSchema, executionId: id,
  afterCallSequence: count, afterEventSequence: count, limit: z.number().int().min(1).max(100)
}).strict();
export const taskReplayDiagnosticsSchema = z.strictObject({
  events: z.strictObject({sequence: count, type: id, createdAt: z.string(),
    toolCallId: id.nullable(), status: id.nullable(), failed: z.boolean()}).array().max(100),
  nextSequence: count, hasMore: z.boolean(),
  gap: z.strictObject({throughSequence: count, historyComplete: z.boolean()}).nullable()
});
export const taskExecutionObservationsSchema = z.strictObject({
  calls: taskCallsPageSchema, replay: taskReplayDiagnosticsSchema.nullable(), resources: taskResourceDiagnosticsSchema.nullable(),
  telemetry: taskTelemetrySchema.nullable()
});
export const taskDiagnosticsExportSchema = z.strictObject({
  path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u), size: count,
  createdAt: z.iso.datetime(), redacted: z.literal(true), externalTrace: z.literal('not_exported')
});
export type TaskExecutionDiagnosticsRequest = z.infer<typeof taskExecutionDiagnosticsRequestSchema>;
export type TaskExecutionObservations = z.infer<typeof taskExecutionObservationsSchema>;
export type TaskDiagnosticsExport = z.infer<typeof taskDiagnosticsExportSchema>;
