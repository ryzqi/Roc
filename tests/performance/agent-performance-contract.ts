import { z } from 'zod';

export const agentPerformanceMetricIds = [
  'agent_build',
  'first_model_token',
  'first_tool_call',
  'tool_roundtrip',
  'simple_completion',
  'restart_resume',
  'iterations_10',
  'iterations_100',
  'subagent_fan_out',
  'event_queue',
  'outbox_projection'
] as const;

const agentPerformanceMetricIdSchema = z.enum(agentPerformanceMetricIds);
const thresholdFailurePrefix = 'agent_performance_threshold_breached:';
const durationSamplesSchema = z.array(z.number().finite().nonnegative()).min(2);
const baselineDurationSamplesSchema = z.array(z.number().finite().positive()).min(2);

const environmentSchema = z
  .object({
    arch: z.string().min(1),
    cpuCount: z.number().int().positive(),
    cpuModel: z.string().min(1),
    nodeVersion: z.string().min(1),
    platform: z.string().min(1)
  })
  .strict();

const fixtureSchema = z
  .object({
    model: z.literal('RocPerformanceFakeModel'),
    network: z.literal('disabled'),
    provider: z.literal('deterministic-local')
  })
  .strict();

const metricEvidenceSchema = z
  .object({
    checkpointCount: z.number().int().nonnegative().nullable(),
    modelInvocationCount: z.number().int().nonnegative().nullable(),
    outboxEventCount: z.number().int().nonnegative().nullable(),
    outboxLastSequence: z.number().int().nonnegative().nullable(),
    priorTurnRecovered: z.boolean().nullable(),
    queueEventCount: z.number().int().nonnegative().nullable(),
    queueHighWaterMark: z.number().int().nonnegative().nullable(),
    subagentCount: z.number().int().nonnegative().nullable(),
    toolExecutionCount: z.number().int().nonnegative().nullable()
  })
  .strict();

const baselineMetricSchema = z
  .object({
    absoluteMaxMs: z.number().finite().positive(),
    id: agentPerformanceMetricIdSchema,
    maxRegressionRatio: z.number().finite().gt(1),
    samplesMs: baselineDurationSamplesSchema
  })
  .strict();

const baselineSchema = z
  .object({
    environment: environmentSchema,
    fixture: fixtureSchema,
    gitRevision: z.string().min(1),
    metrics: z.array(baselineMetricSchema),
    recordedAt: z.iso.datetime(),
    schemaVersion: z.literal(1),
    worktreeDirty: z.boolean()
  })
  .strict();

const metricResultSchema = z
  .object({
    absoluteMaxMs: z.number().finite().positive(),
    baselineP95Ms: z.number().finite().positive(),
    baselineSamplesMs: baselineDurationSamplesSchema,
    currentP95Ms: z.number().finite().nonnegative(),
    currentSamplesMs: durationSamplesSchema,
    evidence: metricEvidenceSchema,
    failedLimits: z.array(z.enum(['relative', 'absolute'])),
    id: agentPerformanceMetricIdSchema,
    maxRegressionRatio: z.number().finite().gt(1),
    observedRegressionRatio: z.number().finite().nonnegative(),
    passed: z.boolean(),
    relativeMaxMs: z.number().finite().positive(),
    unit: z.literal('ms')
  })
  .strict();

const artifactSchema = z
  .object({
    environment: environmentSchema,
    error: z.string().min(1).nullable(),
    fixture: fixtureSchema,
    generatedAt: z.iso.datetime(),
    gitRevision: z.string().min(1),
    metrics: z.array(metricResultSchema),
    passed: z.boolean(),
    schemaVersion: z.literal(1),
    worktreeDirty: z.boolean()
  })
  .strict();

export type AgentPerformanceBaseline = z.infer<typeof baselineSchema>;
export type AgentPerformanceBaselineMetric = z.infer<typeof baselineMetricSchema>;
export type AgentPerformanceEnvironment = z.infer<typeof environmentSchema>;
export type AgentPerformanceFixture = z.infer<typeof fixtureSchema>;
export type AgentPerformanceMetricEvidence = z.infer<typeof metricEvidenceSchema>;
export type AgentPerformanceMetricId = z.infer<typeof agentPerformanceMetricIdSchema>;
export type AgentPerformanceMetricResult = z.infer<typeof metricResultSchema>;
export type AgentPerformanceArtifact = z.infer<typeof artifactSchema>;

export function parseAgentPerformanceBaseline(input: unknown): AgentPerformanceBaseline {
  const parsed = baselineSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('agent_performance_baseline_invalid', { cause: parsed.error });
  }
  assertExactMetricSet(
    parsed.data.metrics.map((metric) => metric.id),
    'agent_performance_baseline_metric_set_invalid'
  );
  return parsed.data;
}

export function parseAgentPerformanceArtifact(input: unknown): AgentPerformanceArtifact {
  const parsed = artifactSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('agent_performance_artifact_invalid', { cause: parsed.error });
  }
  const metricIds = parsed.data.metrics.map((metric) => metric.id);
  assertUniqueMetricIds(metricIds, 'agent_performance_artifact_metric_set_invalid');
  for (const metric of parsed.data.metrics) {
    assertMetricEvidence(metric.id, metric.evidence);
    assertMetricResultConsistency(metric);
  }
  if (parsed.data.passed) {
    if (parsed.data.error !== null) {
      throw new Error('agent_performance_artifact_pass_error_invalid');
    }
    assertExactMetricSet(metricIds, 'agent_performance_artifact_metric_set_invalid');
    if (parsed.data.metrics.some((metric) => !metric.passed)) {
      throw new Error('agent_performance_artifact_pass_metrics_invalid');
    }
  }
  if (!parsed.data.passed) {
    if (parsed.data.error === null) {
      throw new Error('agent_performance_artifact_failure_reason_missing');
    }
    if (parsed.data.error.startsWith(thresholdFailurePrefix)) {
      assertExactMetricSet(metricIds, 'agent_performance_artifact_metric_set_invalid');
      const failedMetricIds = parsed.data.metrics
        .filter((metric) => !metric.passed)
        .map((metric) => metric.id);
      const expectedError = `${thresholdFailurePrefix}${failedMetricIds.join(',')}`;
      if (failedMetricIds.length === 0 || parsed.data.error !== expectedError) {
        throw new Error('agent_performance_artifact_failure_summary_invalid');
      }
    }
  }
  return parsed.data;
}

export function assertAgentPerformanceBaselineCompatible(
  baseline: AgentPerformanceBaseline,
  current: {
    environment: AgentPerformanceEnvironment;
    fixture: AgentPerformanceFixture;
  }
): void {
  const environmentKeys = [
    'arch',
    'cpuCount',
    'cpuModel',
    'nodeVersion',
    'platform'
  ] as const;
  for (const key of environmentKeys) {
    if (baseline.environment[key] !== current.environment[key]) {
      throw new Error(`agent_performance_baseline_environment_mismatch:${key}`);
    }
  }
  const fixtureKeys = ['model', 'network', 'provider'] as const;
  for (const key of fixtureKeys) {
    if (baseline.fixture[key] !== current.fixture[key]) {
      throw new Error(`agent_performance_baseline_fixture_mismatch:${key}`);
    }
  }
}

export function buildAgentPerformanceArtifact(input: {
  environment: AgentPerformanceEnvironment;
  fixture: AgentPerformanceFixture;
  generatedAt: string;
  gitRevision: string;
  metrics: readonly AgentPerformanceMetricResult[];
  unexpectedFetches: readonly string[];
  worktreeDirty: boolean;
}): AgentPerformanceArtifact {
  const failedMetricIds = input.metrics
    .filter((metric) => !metric.passed)
    .map((metric) => metric.id);
  const error = input.unexpectedFetches.length > 0
    ? `agent_performance_unexpected_fetch:${input.unexpectedFetches.join(',')}`
    : failedMetricIds.length > 0
      ? `${thresholdFailurePrefix}${failedMetricIds.join(',')}`
      : null;
  return parseAgentPerformanceArtifact({
    environment: input.environment,
    error,
    fixture: input.fixture,
    generatedAt: input.generatedAt,
    gitRevision: input.gitRevision,
    metrics: [...input.metrics],
    passed: error === null,
    schemaVersion: 1,
    worktreeDirty: input.worktreeDirty
  });
}

export function buildAgentPerformanceMetricResult(
  baselineInput: AgentPerformanceBaselineMetric,
  samplesInput: readonly number[],
  evidenceInput: AgentPerformanceMetricEvidence
): AgentPerformanceMetricResult {
  const baseline = baselineMetricSchema.parse(baselineInput);
  const samples = durationSamplesSchema.parse(samplesInput);
  const evidence = metricEvidenceSchema.parse(evidenceInput);
  assertMetricEvidence(baseline.id, evidence);
  const baselineP95Ms = calculatePercentile95(baseline.samplesMs);
  const currentP95Ms = calculatePercentile95(samples);
  const relativeMaxMs = baselineP95Ms * baseline.maxRegressionRatio;
  const failedLimits: Array<'relative' | 'absolute'> = [];
  if (currentP95Ms > relativeMaxMs) {
    failedLimits.push('relative');
  }
  if (currentP95Ms > baseline.absoluteMaxMs) {
    failedLimits.push('absolute');
  }
  return metricResultSchema.parse({
    absoluteMaxMs: baseline.absoluteMaxMs,
    baselineP95Ms,
    baselineSamplesMs: [...baseline.samplesMs],
    currentP95Ms,
    currentSamplesMs: [...samples],
    evidence,
    failedLimits,
    id: baseline.id,
    maxRegressionRatio: baseline.maxRegressionRatio,
    observedRegressionRatio: currentP95Ms / baselineP95Ms,
    passed: failedLimits.length === 0,
    relativeMaxMs,
    unit: 'ms'
  });
}

export function calculatePercentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  const value = sorted[index];
  if (value === undefined) {
    throw new Error('agent_performance_samples_missing');
  }
  return value;
}

function assertMetricResultConsistency(metric: AgentPerformanceMetricResult): void {
  const expected = buildAgentPerformanceMetricResult(
    {
      absoluteMaxMs: metric.absoluteMaxMs,
      id: metric.id,
      maxRegressionRatio: metric.maxRegressionRatio,
      samplesMs: metric.baselineSamplesMs
    },
    metric.currentSamplesMs,
    metric.evidence
  );
  if (
    metric.baselineP95Ms !== expected.baselineP95Ms ||
    metric.currentP95Ms !== expected.currentP95Ms ||
    metric.relativeMaxMs !== expected.relativeMaxMs ||
    metric.observedRegressionRatio !== expected.observedRegressionRatio ||
    metric.passed !== expected.passed ||
    metric.failedLimits.length !== expected.failedLimits.length ||
    metric.failedLimits.some((limit, index) => limit !== expected.failedLimits[index])
  ) {
    throw new Error('agent_performance_artifact_metric_result_invalid');
  }
}

function assertExactMetricSet(
  metricIds: readonly AgentPerformanceMetricId[],
  errorCode: string
): void {
  if (metricIds.length !== agentPerformanceMetricIds.length) {
    throw new Error(errorCode);
  }
  for (let index = 0; index < agentPerformanceMetricIds.length; index += 1) {
    if (metricIds[index] !== agentPerformanceMetricIds[index]) {
      throw new Error(errorCode);
    }
  }
}

function assertUniqueMetricIds(
  metricIds: readonly AgentPerformanceMetricId[],
  errorCode: string
): void {
  if (new Set(metricIds).size !== metricIds.length) {
    throw new Error(errorCode);
  }
}

function assertMetricEvidence(id: AgentPerformanceMetricId, evidence: AgentPerformanceMetricEvidence): void {
  const invalid = (): never => {
    throw new Error('agent_performance_metric_evidence_invalid');
  };
  switch (id) {
    case 'agent_build':
      return;
    case 'first_model_token':
      if (evidence.modelInvocationCount !== 1) {
        invalid();
      }
      return;
    case 'first_tool_call':
    case 'tool_roundtrip':
      if (evidence.modelInvocationCount !== 2 || evidence.toolExecutionCount !== 1) {
        invalid();
      }
      return;
    case 'simple_completion':
      if (evidence.modelInvocationCount !== 1 || evidence.toolExecutionCount !== 0) {
        invalid();
      }
      return;
    case 'restart_resume':
      if (
        evidence.checkpointCount === null ||
        evidence.checkpointCount <= 0 ||
        evidence.modelInvocationCount !== 2 ||
        evidence.priorTurnRecovered !== true
      ) {
        invalid();
      }
      return;
    case 'iterations_10':
      if (evidence.modelInvocationCount !== 11 || evidence.toolExecutionCount !== 10) {
        invalid();
      }
      return;
    case 'iterations_100':
      if (evidence.modelInvocationCount !== 101 || evidence.toolExecutionCount !== 100) {
        invalid();
      }
      return;
    case 'subagent_fan_out':
      if (evidence.subagentCount !== 3) {
        invalid();
      }
      return;
    case 'event_queue':
      if (
        evidence.queueEventCount === null ||
        evidence.queueEventCount <= 0 ||
        evidence.queueHighWaterMark !== evidence.queueEventCount
      ) {
        invalid();
      }
      return;
    case 'outbox_projection':
      if (
        evidence.outboxEventCount === null ||
        evidence.outboxEventCount <= 0 ||
        evidence.outboxLastSequence !== evidence.outboxEventCount
      ) {
        invalid();
      }
      return;
  }
}
