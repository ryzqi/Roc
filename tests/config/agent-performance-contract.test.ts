import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  agentPerformanceMetricIds,
  assertAgentPerformanceBaselineCompatible,
  buildAgentPerformanceArtifact,
  buildAgentPerformanceMetricResult,
  parseAgentPerformanceArtifact,
  parseAgentPerformanceBaseline
} from '../performance/agent-performance-contract';

describe('agent performance baseline contract', () => {
  it('accepts one strict baseline entry for every required metric', () => {
    const baseline = parseAgentPerformanceBaseline(createBaseline());

    expect(baseline.metrics.map((metric) => metric.id)).toEqual(agentPerformanceMetricIds);
    expect(baseline.fixture).toEqual(performanceFixture());
    expect(baseline.gitRevision).toBe('test-revision');
    expect(baseline.worktreeDirty).toBe(true);
  });

  it('rejects unknown fields and missing metric entries', () => {
    expect(() =>
      parseAgentPerformanceBaseline({
        ...createBaseline(),
        unexpected: true
      })
    ).toThrow('agent_performance_baseline_invalid');

    expect(() =>
      parseAgentPerformanceBaseline({
        ...createBaseline(),
        metrics: createBaseline().metrics.slice(1)
      })
    ).toThrow('agent_performance_baseline_metric_set_invalid');
  });

  it('ships the measured five-run baseline without placeholder gates', async () => {
    const content = await readFile(
      new URL('../performance/datasets/agent-performance-baseline.v1.json', import.meta.url),
      'utf8'
    );
    const baseline = parseAgentPerformanceBaseline(JSON.parse(content) as unknown);

    for (const metric of baseline.metrics) {
      expect(metric.samplesMs).toHaveLength(15);
      expect(metric.absoluteMaxMs).toBeLessThanOrEqual(5000);
      expect(metric.maxRegressionRatio).toBeLessThanOrEqual(5);
    }
  });

  it('rejects a baseline recorded for a different runtime environment', () => {
    const baseline = parseAgentPerformanceBaseline(createBaseline());

    expect(() =>
      assertAgentPerformanceBaselineCompatible(baseline, {
        environment: {
          ...baseline.environment,
          nodeVersion: 'v26.0.0'
        },
        fixture: baseline.fixture
      })
    ).toThrow('agent_performance_baseline_environment_mismatch:nodeVersion');
  });
});

describe('agent performance threshold contract', () => {
  it('records raw samples and passes both relative and absolute limits', () => {
    const result = buildAgentPerformanceMetricResult(
      {
        id: 'agent_build',
        absoluteMaxMs: 30,
        maxRegressionRatio: 2,
        samplesMs: [10, 12, 11]
      },
      [20, 22, 21],
      emptyEvidence()
    );

    expect(result).toMatchObject({
      id: 'agent_build',
      baselineP95Ms: 12,
      currentP95Ms: 22,
      currentSamplesMs: [20, 22, 21],
      passed: true
    });
    expect(result.observedRegressionRatio).toBeCloseTo(22 / 12);
  });

  it('fails when either the relative or absolute limit is breached', () => {
    const relativeBreach = buildAgentPerformanceMetricResult(
      {
        id: 'agent_build',
        absoluteMaxMs: 100,
        maxRegressionRatio: 2,
        samplesMs: [10, 12, 11]
      },
      [20, 25, 22],
      emptyEvidence()
    );
    const absoluteBreach = buildAgentPerformanceMetricResult(
      {
        id: 'agent_build',
        absoluteMaxMs: 20,
        maxRegressionRatio: 4,
        samplesMs: [10, 12, 11]
      },
      [20, 25, 22],
      emptyEvidence()
    );

    expect(relativeBreach.passed).toBe(false);
    expect(relativeBreach.failedLimits).toEqual(['relative']);
    expect(absoluteBreach.passed).toBe(false);
    expect(absoluteBreach.failedLimits).toEqual(['absolute']);
  });

  it('rejects metric evidence that does not prove the measured scenario', () => {
    expect(() =>
      buildAgentPerformanceMetricResult(
        {
          id: 'iterations_10',
          absoluteMaxMs: 100,
          maxRegressionRatio: 2,
          samplesMs: [10, 12, 11]
        },
        [20, 22, 21],
        emptyEvidence()
      )
    ).toThrow('agent_performance_metric_evidence_invalid');

    const validMetric = buildAgentPerformanceMetricResult(
      {
        id: 'iterations_10',
        absoluteMaxMs: 100,
        maxRegressionRatio: 2,
        samplesMs: [10, 12, 11]
      },
      [20, 22, 21],
      {
        ...emptyEvidence(),
        modelInvocationCount: 11,
        toolExecutionCount: 10
      }
    );
    expect(() =>
      parseAgentPerformanceArtifact({
        schemaVersion: 1,
        generatedAt: '2026-07-27T00:00:00.000Z',
        gitRevision: 'test-revision',
        worktreeDirty: true,
        passed: false,
        error: 'fixture failure',
        environment: {
          arch: 'x64',
          cpuCount: 8,
          cpuModel: 'test-cpu',
          nodeVersion: 'v25.0.0',
          platform: 'win32'
        },
        fixture: {
          model: 'RocPerformanceFakeModel',
          network: 'disabled',
          provider: 'deterministic-local'
        },
        metrics: [
          {
            ...validMetric,
            evidence: emptyEvidence()
          }
        ]
      })
    ).toThrow('agent_performance_metric_evidence_invalid');
  });

  it('rejects unknown artifact fields', () => {
    expect(() =>
      parseAgentPerformanceArtifact({
        schemaVersion: 1,
        generatedAt: '2026-07-27T00:00:00.000Z',
        gitRevision: 'test-revision',
        worktreeDirty: true,
        passed: false,
        error: 'fixture failure',
        environment: {
          arch: 'x64',
          cpuCount: 8,
          cpuModel: 'test-cpu',
          nodeVersion: 'v25.0.0',
          platform: 'win32'
        },
        fixture: {
          model: 'RocPerformanceFakeModel',
          network: 'disabled',
          provider: 'deterministic-local'
        },
        metrics: [],
        unexpected: true
      })
    ).toThrow('agent_performance_artifact_invalid');
  });

  it('rejects artifact threshold fields that contradict the raw samples', () => {
    const metric = buildAgentPerformanceMetricResult(
      {
        id: 'agent_build',
        absoluteMaxMs: 30,
        maxRegressionRatio: 2,
        samplesMs: [10, 12, 11]
      },
      [20, 22, 21],
      emptyEvidence()
    );
    const artifact = createFailureArtifact(metric);

    expect(() =>
      parseAgentPerformanceArtifact({
        ...artifact,
        metrics: [{ ...metric, currentP95Ms: 1 }]
      })
    ).toThrow('agent_performance_artifact_metric_result_invalid');
    expect(() =>
      parseAgentPerformanceArtifact({
        ...artifact,
        metrics: [{ ...metric, failedLimits: ['relative'], passed: false }]
      })
    ).toThrow('agent_performance_artifact_metric_result_invalid');
    expect(() =>
      parseAgentPerformanceArtifact({
        ...artifact,
        error: null
      })
    ).toThrow('agent_performance_artifact_failure_reason_missing');

    const failedMetric = buildAgentPerformanceMetricResult(
      {
        id: 'agent_build',
        absoluteMaxMs: 20,
        maxRegressionRatio: 2,
        samplesMs: [10, 12, 11]
      },
      [20, 25, 22],
      emptyEvidence()
    );
    expect(() =>
      parseAgentPerformanceArtifact({
        ...createFailureArtifact(failedMetric),
        error: null
      })
    ).toThrow('agent_performance_artifact_failure_reason_missing');
  });

  it('rejects threshold failure summaries that contradict the failed metrics', () => {
    const failedMetric = buildAgentPerformanceMetricResult(
      {
        id: 'agent_build',
        absoluteMaxMs: 20,
        maxRegressionRatio: 2,
        samplesMs: [10, 12, 11]
      },
      [20, 25, 22],
      emptyEvidence()
    );
    const artifact = createFailureArtifact(failedMetric);
    const completeMetrics = createPassingMetricResults();
    completeMetrics[0] = failedMetric;

    expect(() =>
      parseAgentPerformanceArtifact({
        ...artifact,
        error: 'agent_performance_threshold_breached:first_model_token',
        metrics: completeMetrics
      })
    ).toThrow('agent_performance_artifact_failure_summary_invalid');
    expect(() =>
      parseAgentPerformanceArtifact({
        ...artifact,
        error: 'agent_performance_threshold_breached:agent_build'
      })
    ).toThrow('agent_performance_artifact_metric_set_invalid');

    expect(parseAgentPerformanceArtifact({
      ...artifact,
      error: 'agent_performance_threshold_breached:agent_build',
      metrics: completeMetrics
    }).error).toBe('agent_performance_threshold_breached:agent_build');
    expect(parseAgentPerformanceArtifact(artifact).error).toBe('fixture failure');
  });

  it('builds a failure artifact when deterministic execution observes network access', () => {
    const metric = buildAgentPerformanceMetricResult(
      {
        id: 'agent_build',
        absoluteMaxMs: 30,
        maxRegressionRatio: 2,
        samplesMs: [10, 12, 11]
      },
      [20, 22, 21],
      emptyEvidence()
    );

    const artifact = buildAgentPerformanceArtifact({
      environment: createBaseline().environment,
      fixture: performanceFixture(),
      generatedAt: '2026-07-27T00:00:00.000Z',
      gitRevision: 'test-revision',
      metrics: [metric],
      unexpectedFetches: ['https://example.invalid/'],
      worktreeDirty: true
    });

    expect(artifact.passed).toBe(false);
    expect(artifact.error).toBe('agent_performance_unexpected_fetch:https://example.invalid/');
    expect(artifact.metrics).toEqual([metric]);
  });

  it('builds a passing artifact only when every required metric passes', () => {
    const metrics = createPassingMetricResults();

    const artifact = buildAgentPerformanceArtifact({
      environment: createBaseline().environment,
      fixture: performanceFixture(),
      generatedAt: '2026-07-27T00:00:00.000Z',
      gitRevision: 'test-revision',
      metrics,
      unexpectedFetches: [],
      worktreeDirty: true
    });

    expect(artifact.passed).toBe(true);
    expect(artifact.error).toBeNull();
    expect(artifact.metrics).toEqual(metrics);
  });

  it('builds an ordered threshold summary from the failed metrics', () => {
    const metrics = createPassingMetricResults();
    for (const index of [0, 1]) {
      const baselineMetric = createBaseline().metrics[index];
      if (baselineMetric === undefined) {
        throw new Error('agent_performance_test_baseline_metric_missing');
      }
      metrics[index] = buildAgentPerformanceMetricResult(
        baselineMetric,
        [500, 500, 500],
        evidenceForMetric(baselineMetric.id)
      );
    }

    const artifact = buildAgentPerformanceArtifact({
      environment: createBaseline().environment,
      fixture: performanceFixture(),
      generatedAt: '2026-07-27T00:00:00.000Z',
      gitRevision: 'test-revision',
      metrics,
      unexpectedFetches: [],
      worktreeDirty: true
    });

    expect(artifact.passed).toBe(false);
    expect(artifact.error).toBe(
      'agent_performance_threshold_breached:agent_build,first_model_token'
    );
    expect(artifact.metrics.filter((metric) => !metric.passed).map((metric) => metric.id)).toEqual([
      'agent_build',
      'first_model_token'
    ]);
  });
});

function createFailureArtifact(metric: ReturnType<typeof buildAgentPerformanceMetricResult>) {
  return {
    schemaVersion: 1 as const,
    generatedAt: '2026-07-27T00:00:00.000Z',
    gitRevision: 'test-revision',
    worktreeDirty: true,
    passed: false,
    error: 'fixture failure',
    environment: {
      arch: 'x64',
      cpuCount: 8,
      cpuModel: 'test-cpu',
      nodeVersion: 'v25.0.0',
      platform: 'win32'
    },
    fixture: {
      model: 'RocPerformanceFakeModel' as const,
      network: 'disabled' as const,
      provider: 'deterministic-local' as const
    },
    metrics: [metric]
  };
}

function createBaseline() {
  return {
    schemaVersion: 1,
    recordedAt: '2026-07-27T00:00:00.000Z',
    environment: {
      arch: 'x64',
      cpuCount: 8,
      cpuModel: 'test-cpu',
      nodeVersion: 'v25.0.0',
      platform: 'win32'
    },
    fixture: performanceFixture(),
    gitRevision: 'test-revision',
    metrics: agentPerformanceMetricIds.map((id) => ({
      id,
      absoluteMaxMs: 100,
      maxRegressionRatio: 4,
      samplesMs: [10, 12, 11]
    })),
    worktreeDirty: true
  };
}

function createPassingMetricResults() {
  return createBaseline().metrics.map((metric) =>
    buildAgentPerformanceMetricResult(
      metric,
      [10, 11, 12],
      evidenceForMetric(metric.id)
    )
  );
}

function evidenceForMetric(id: (typeof agentPerformanceMetricIds)[number]) {
  const evidence = emptyEvidence();
  switch (id) {
    case 'agent_build':
      return evidence;
    case 'first_model_token':
      return { ...evidence, modelInvocationCount: 1 };
    case 'first_tool_call':
    case 'tool_roundtrip':
      return { ...evidence, modelInvocationCount: 2, toolExecutionCount: 1 };
    case 'simple_completion':
      return { ...evidence, modelInvocationCount: 1, toolExecutionCount: 0 };
    case 'restart_resume':
      return {
        ...evidence,
        checkpointCount: 1,
        modelInvocationCount: 2,
        priorTurnRecovered: true
      };
    case 'iterations_10':
      return { ...evidence, modelInvocationCount: 11, toolExecutionCount: 10 };
    case 'iterations_100':
      return { ...evidence, modelInvocationCount: 101, toolExecutionCount: 100 };
    case 'subagent_fan_out':
      return { ...evidence, subagentCount: 3 };
    case 'event_queue':
      return { ...evidence, queueEventCount: 1, queueHighWaterMark: 1 };
    case 'outbox_projection':
      return { ...evidence, outboxEventCount: 1, outboxLastSequence: 1 };
  }
}

function performanceFixture() {
  return {
    model: 'RocPerformanceFakeModel' as const,
    network: 'disabled' as const,
    provider: 'deterministic-local' as const
  };
}

function emptyEvidence() {
  return {
    checkpointCount: null,
    modelInvocationCount: null,
    outboxEventCount: null,
    outboxLastSequence: null,
    priorTurnRecovered: null,
    queueEventCount: null,
    queueHighWaterMark: null,
    subagentCount: null,
    toolExecutionCount: null
  };
}
