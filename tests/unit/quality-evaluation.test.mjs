import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { build } from 'esbuild';

const repositoryRoot = process.cwd();
const bundleDirectory = mkdtempSync(join(tmpdir(), 'roc-quality-eval-'));
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

const qualityBundle = join(bundleDirectory, 'quality-evaluation.mjs');
const optimizerBundle = join(bundleDirectory, 'optimizer-dataset.mjs');
await Promise.all([
  build({
    entryPoints: [join(repositoryRoot, 'scripts/harness-eval/quality-evaluation/index.ts')],
    outfile: qualityBundle,
    bundle: true,
    platform: 'node',
    format: 'esm'
  }),
  build({
    entryPoints: [join(repositoryRoot, 'scripts/harness-eval/optimizer/dataset.ts')],
    outfile: optimizerBundle,
    bundle: true,
    platform: 'node',
    format: 'esm'
  })
]);
const quality = await import(pathToFileURL(qualityBundle).href);
const optimizer = await import(pathToFileURL(optimizerBundle).href);

function validOutput(task) {
  switch (task.validator.kind) {
    case 'paper-facts':
      return {
        studies: task.validator.studies.map(study => ({ doi: study.doi, facts: { ...study.facts } })),
        citations: task.validator.studies.map(study => study.doi)
      };
    case 'memory':
      return { summary: task.validator.requiredPhrases.join('; '), citations: [...task.validator.citations] };
    case 'csv-report': {
      const content = task.validator.rows.join('\n');
      return { filename: task.validator.filename, content, sha256: createHash('sha256').update(content).digest('hex') };
    }
    case 'experiment-script': {
      const divisor = task.validator.operation === 'mean' ? ' / values.length' : '';
      const script = `function ${task.validator.functionName}(values: number[]): number { return values.reduce((sum, value) => sum + value, 0)${divisor}; }`;
      const results = Object.fromEntries(Object.entries(task.validator.inputValues).map(([key, values]) => {
        const sum = values.reduce((total, value) => total + value, 0);
        return [key, task.validator.operation === 'mean' ? sum / values.length : sum];
      }));
      return { script, results };
    }
    case 'mcp-recovery':
      return { status: task.validator.expectedStatus, events: [...task.validator.expectedEvents], externalEffects: task.validator.expectedExternalEffects, receiptPresent: true };
    case 'permission-boundary':
      return { decision: 'blocked', blockedAction: task.validator.blockedAction, executedActions: [...task.validator.expectedExecutedActions] };
    case 'cancel-crash-recovery':
      return {
        status: task.validator.expectedStatus,
        reconciliationRequired: task.validator.reconciliationRequired,
        retryDispatched: task.validator.retryDispatched,
        duplicateEffects: task.validator.duplicateEffects
      };
    default:
      throw new Error(`unhandled test validator: ${task.validator.kind}`);
  }
}

test('pilot data is immutable, reproducibly hashed, and hides evaluator-only fields', () => {
  assert.equal(quality.QUALITY_TASKS.length, 16);
  assert.equal(new Set(quality.QUALITY_FAMILIES).size, 8);
  assert.equal(quality.QUALITY_SOURCES.length, 3);
  assert.match(quality.qualityDatasetHash(), /^[a-f0-9]{64}$/u);
  assert.ok(Object.isFrozen(quality.QUALITY_TASKS));
  assert.ok(Object.isFrozen(quality.QUALITY_TASKS[0].validator));
  assert.ok(quality.QUALITY_SOURCES.every(source => source.license === 'CC BY' && source.attribution.length > 20 && source.locator.length > 0));

  for (const task of quality.QUALITY_TASKS) {
    const publicTask = quality.toAgentTaskView(task);
    assert.deepEqual(Object.keys(publicTask).sort(), ['difficulty', 'family', 'id', 'outputFormat', 'prompt'].concat(publicTask.conversationTurns ? ['conversationTurns'] : []).sort());
    for (const hiddenKey of ['validator', 'sourceIds', 'clusterId', 'split', 'provenance']) {
      assert.equal(Object.hasOwn(publicTask, hiddenKey), false, `${task.id} exposes ${hiddenKey}`);
    }
  }
});

test('independent validators accept every known answer and reject unsupported or unsafe output', () => {
  for (const task of quality.QUALITY_TASKS) {
    const result = quality.validateQualityTaskOutput(task, JSON.stringify(validOutput(task)));
    assert.equal(result.passed, true, `${task.id}: ${result.failures.join(', ')}`);
    assert.equal(result.score, 1, task.id);
  }

  const paperTask = quality.QUALITY_TASKS.find(task => task.id === 'literature-release-windows');
  const unsupportedPaper = validOutput(paperTask);
  unsupportedPaper.studies[0].facts.unsupported_claim = 'unverified';
  assert.equal(quality.validateQualityTaskOutput(paperTask, JSON.stringify(unsupportedPaper)).passed, false);

  const scriptTask = quality.QUALITY_TASKS.find(task => task.id === 'experiment-script-fatigue-mean');
  const unsafeScript = validOutput(scriptTask);
  unsafeScript.script += '\nfetch("https://example.invalid");';
  assert.equal(quality.validateQualityTaskOutput(scriptTask, JSON.stringify(unsafeScript)).passed, false);
  assert.deepEqual(quality.validateQualityTaskOutput(scriptTask, 'x'.repeat(65 * 1024)).failures, ['output_too_large']);
});

test('paired quality statistics keep the pilot uncertain and reject malformed pair records', () => {
  const trials = quality.QUALITY_TASKS.flatMap(task => Array.from({ length: 3 }, (_, repeatIndex) => ({
    taskId: task.id,
    family: task.family,
    clusterId: task.clusterId,
    repeatIndex,
    baseline: { status: 'success', score: 0.6, latencyMs: 100, costUsd: null },
    candidate: { status: 'success', score: 0.8, latencyMs: 120, costUsd: null }
  })));
  const summary = quality.summarizePairedQualityTrials(trials);
  assert.equal(summary.taskCount, 16);
  assert.equal(summary.evidenceStatus, 'insufficient');
  assert.equal(summary.conclusion, 'uncertain');
  assert.equal(summary.stopReason, 'target_case_count_not_met');
  assert.equal(summary.costStatus, 'unknown');
  assert.equal(summary.familyComparisons, 'exploratory-unadjusted');
  assert.throws(() => quality.summarizePairedQualityTrials([...trials, trials[0]]), /quality_trial_duplicate_pair/u);
  assert.throws(() => quality.summarizePairedQualityTrials(trials.map((trial, index) => index === 0
    ? { ...trial, baseline: { ...trial.baseline, score: 1.01 } } : trial)), /quality_trial_score_invalid/u);
  assert.throws(() => quality.summarizePairedQualityTrials(trials.map((trial, index) => index === 0
    ? { ...trial, candidate: { ...trial.candidate, latencyMs: Number.NaN } } : trial)), /quality_trial_latency_invalid/u);
});

function buildFullTrials(candidateScoreForFamily = () => 0.8) {
  const counts = quality.QUALITY_TARGETS;
  return quality.QUALITY_FAMILIES.flatMap(family => {
    const taskCount = counts[family];
    return Array.from({ length: taskCount }, (_, taskIndex) => {
      const clusterIndex = Math.floor(taskIndex * 5 / taskCount);
      const taskId = `${family}-task-${taskIndex}`;
      const clusterId = `${family}-cluster-${clusterIndex}`;
      return Array.from({ length: 3 }, (_, repeatIndex) => ({
        taskId,
        family,
        clusterId,
        repeatIndex,
        baseline: { status: 'success', score: 0.5, latencyMs: 100 + repeatIndex, costUsd: 0 },
        candidate: { status: 'success', score: candidateScoreForFamily(family), latencyMs: 90 + repeatIndex, costUsd: 0 }
      }));
    }).flat();
  });
}

test('full paired statistics honor family quotas and block a family regression', () => {
  const gain = quality.summarizePairedQualityTrials(buildFullTrials(), { bootstrapIterations: 200 });
  assert.equal(gain.taskCount, 200);
  assert.equal(gain.evidenceStatus, 'sufficient');
  assert.equal(gain.conclusion, 'candidate-gain-supported');
  assert.equal(gain.costStatus, 'known');
  assert.equal(gain.baselineCostUsd, 0);

  const regression = quality.summarizePairedQualityTrials(
    buildFullTrials(family => family === 'long-memory' ? 0.4 : 0.8),
    { bootstrapIterations: 200 }
  );
  assert.equal(regression.familyStatistics['long-memory'].candidateRegression, true);
  assert.equal(regression.conclusion, 'candidate-regression');
});

test('locked protocol binds model and budget conditions, rejects incomplete data, and requires L3 rollback', () => {
  const draft = quality.createQualityProtocolDraft();
  const input = {
    executionMode: 'pilot',
    authorizationLevel: 'L2',
    providerId: 'provider-test',
    baselineModelId: 'baseline-v1',
    candidateModelId: 'candidate-v1',
    baselineCommitSha: '3'.repeat(40),
    candidateCommitSha: '4'.repeat(40),
    toolManifestHash: 'a'.repeat(64),
    promptSetHash: 'b'.repeat(64),
    environmentHash: 'c'.repeat(64),
    taskTimeoutMs: 10000,
    maxTotalCostUsd: 1,
    maxPerTaskCostUsd: 0.01,
    userAuthorized: true,
    approvalReference: 'approval-test-001'
  };
  const locked = quality.lockQualityProtocol(draft, input);
  assert.equal(locked.status, 'locked');
  assert.match(locked.lockHash, /^[a-f0-9]{64}$/u);
  assert.doesNotThrow(() => quality.assertQualityProtocolAuthorized(locked));
  assert.throws(() => quality.assertQualityProtocolAuthorized({ ...locked, lock: { ...locked.lock, maxTotalCostUsd: 2 } }), /quality_protocol_lock_tampered/u);
  assert.throws(() => quality.lockQualityProtocol(draft, { ...input, userAuthorized: false }), /quality_protocol_user_authorization_required/u);
  assert.throws(() => quality.lockQualityProtocol(draft, { ...input, authorizationLevel: 'L3' }), /quality_protocol_l3_approval_or_rollback_required/u);
  assert.throws(() => quality.lockQualityProtocol(draft, { ...input, maxPerTaskCostUsd: 2 }), /quality_protocol_budget_or_timeout_invalid/u);
  assert.throws(() => quality.lockQualityProtocol(draft, { ...input, executionMode: 'full' }), /quality_protocol_full_dataset_incomplete/u);

  const lockedL3 = quality.lockQualityProtocol(draft, {
    ...input,
    authorizationLevel: 'L3',
    explicitL3Approval: true,
    rollbackPlanReference: 'rollback-plan-001'
  });
  assert.doesNotThrow(() => quality.assertQualityProtocolAuthorized(lockedL3));
});

test('existing optimizer pair summary rejects unpaired, invalid, and underclustered inputs', () => {
  const observations = [
    { scenarioId: 'one', clusterId: 'cluster-a', base: 0.5, candidate: 1 },
    { scenarioId: 'two', clusterId: 'cluster-b', base: null, candidate: 0.5 }
  ];
  const summary = optimizer.pairedClusterSummary(observations, { iterations: 100, seed: 4 });
  assert.equal(summary.failuresIncluded, true);
  assert.equal(summary.clusters, 2);
  assert.throws(() => optimizer.pairedClusterSummary([observations[0], observations[0]]), /optimizer_pair_duplicate/u);
  assert.throws(() => optimizer.pairedClusterSummary([{ ...observations[0], candidate: 1.1 }, observations[1]]), /optimizer_pair_score_invalid/u);
  assert.throws(() => optimizer.pairedClusterSummary(observations, { iterations: 99 }), /optimizer_bootstrap_iterations_invalid/u);
  assert.throws(() => optimizer.wilsonInterval(3, 2), /optimizer_interval_invalid/u);
  assert.throws(() => optimizer.pairedClusterSummary([observations[0], { ...observations[1], clusterId: 'cluster-a' }]), /optimizer_pairs_need_two_clusters/u);
});

test('L1 contract stays explicit about fixture-only evidence and no external calls', () => {
  const report = quality.verifyQualityEvaluation();
  assert.equal(report.evidence, 'deterministic-fixture-contract-only');
  assert.equal(report.modelCalls, 0);
  assert.equal(report.externalCalls, 0);
  assert.equal(report.costUsd, null);
  assert.equal(report.qualityClaim, 'contract-only; no model-quality or provider-cost inference');
});
