import { z } from 'zod';

const countSchema = z.number().int().nonnegative();
const nullableCountSchema = countSchema.nullable();

export const contextCompactionRecordSchema = z.object({
  reason: z.enum(['maintenance', 'context_pressure']),
  sourceMessageCount: countSchema,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  summaryHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  artifactRefs: z.array(z.object({artifactId: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u)}).strict()).max(32),
  risks: z.array(z.enum(['lossy_summary', 'evidence_unverifiable', 'compaction_failed'])).max(3)
}).strict();
export type ContextCompactionRecord = z.infer<typeof contextCompactionRecordSchema>;

export const runTraceOperationSchema = z.enum([
  'run',
  'agent_model',
  'summary_model',
  'context_compaction',
  'context_summary',
  'tool_effect',
  'tool_admission',
  'approval_wait',
  'subagent',
  'recovery',
  'checkpoint_resume'
]);

export const runTraceStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'skipped',
  'blocked'
]);

export const runTraceSpanSchema = z.object({
  spanId: z.string().regex(/^span-\d{1,6}$/u),
  operationId: z.string().regex(/^operation-\d{1,6}$/u),
  parentSpanId: z.string().regex(/^span-\d{1,6}$/u).nullable(),
  checkpointId: z.string().regex(/^checkpoint-\d{1,6}$/u).nullable(),
  operation: runTraceOperationSchema,
  status: runTraceStatusSchema,
  startOffsetMs: countSchema,
  durationMs: nullableCountSchema,
  estimatedInputTokens: nullableCountSchema,
  actualInputTokens: nullableCountSchema,
  actualOutputTokens: nullableCountSchema,
  estimateApproximate: z.boolean().nullable()
}).strict();

export const contextContractAuditSchema = z.object({
  constraintCount: countSchema,
  missingConstraintCount: countSchema,
  acceptanceConditionCount: countSchema,
  missingAcceptanceConditionCount: countSchema,
  pendingEffectCount: countSchema,
  missingPendingEffectCount: countSchema,
  pendingApprovalCount: countSchema,
  missingPendingApprovalCount: countSchema,
  pendingCorrectionCount: countSchema,
  missingPendingCorrectionCount: countSchema,
  evidenceLocatorCount: countSchema,
  missingEvidenceLocatorCount: countSchema.default(0),
  invalidEvidenceLocatorCount: countSchema,
  invalidContractCount: countSchema,
  workspaceVersionPresent: z.boolean()
}).strict();

const admissionLatencySchema = z.object({
  count: countSchema,
  totalMs: countSchema,
  maxMs: countSchema
}).strict();

const admissionConflictCountsSchema = z.object({
  app_run: countSchema,
  background_tasks: countSchema,
  global_config: countSchema,
  global_fallback: countSchema,
  memory: countSchema,
  network: countSchema,
  research: countSchema,
  workspace: countSchema
}).strict();

export const runDiagnosticsRequestSchema = z.object({
  runId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(256)
}).strict();

export const runDiagnosticsSchema = z.object({
  runId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(256),
  providerId: z.string().min(1).max(128),
  modelId: z.string().min(1).max(256),
  totalDurationMs: countSchema,
  model: z.object({
    callCount: countSchema,
    unknownUsageCallCount: countSchema.default(0),
    inputTokens: nullableCountSchema,
    outputTokens: nullableCountSchema,
    totalTokens: nullableCountSchema,
    cacheReadTokens: nullableCountSchema,
    cacheCreationTokens: nullableCountSchema
  }).strict(),
  tool: z.object({
    callCount: countSchema,
    errorCount: countSchema
  }).strict(),
  subagent: z.object({
    count: countSchema,
    failedCount: countSchema,
    maxDepth: countSchema
  }).strict(),
  context: z.object({
    compactionCount: countSchema,
    summaryCount: countSchema,
    artifactCount: countSchema,
    failureCount: countSchema,
    estimatedCount: countSchema,
    inputTokens: nullableCountSchema,
    capacityTokens: nullableCountSchema,
    lastInputEstimated: z.boolean().nullable(),
    removedChars: countSchema,
    persistedChars: countSchema,
    contractAudit: contextContractAuditSchema
  }).strict(),
  toolAdmission: z.object({
    acquisitionCount: countSchema,
    cancellationCount: countSchema,
    contendedCount: countSchema,
    fallbackCount: countSchema,
    wait: admissionLatencySchema,
    hold: admissionLatencySchema,
    conflicts: admissionConflictCountsSchema
  }).strict(),
  trace: z.object({
    spans: z.array(runTraceSpanSchema).max(256),
    droppedSpanCount: countSchema
  }).strict(),
  terminalStatus: z.enum(['cancelled', 'completed', 'failed', 'interrupted']).nullable()
}).strict();

export type RunDiagnosticsRequest = z.infer<typeof runDiagnosticsRequestSchema>;
export type RunDiagnostics = z.infer<typeof runDiagnosticsSchema>;
export type RunTraceSpan = z.infer<typeof runTraceSpanSchema>;
export type ContextContractAudit = z.infer<typeof contextContractAuditSchema>;

export function createEmptyContextContractAudit(): ContextContractAudit {
  return {
    constraintCount: 0,
    missingConstraintCount: 0,
    acceptanceConditionCount: 0,
    missingAcceptanceConditionCount: 0,
    pendingEffectCount: 0,
    missingPendingEffectCount: 0,
    pendingApprovalCount: 0,
    missingPendingApprovalCount: 0,
    pendingCorrectionCount: 0,
    missingPendingCorrectionCount: 0,
    evidenceLocatorCount: 0,
    missingEvidenceLocatorCount: 0,
    invalidEvidenceLocatorCount: 0,
    invalidContractCount: 0,
    workspaceVersionPresent: false
  };
}

export function createEmptyTrace(): { spans: RunTraceSpan[]; droppedSpanCount: number } {
  return { spans: [], droppedSpanCount: 0 };
}
