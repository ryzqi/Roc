import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  ablationReport, buildDataset, freezeDataset, pairedClusterSummary, readSplit, verifyDatasetShape,
  type DatasetReader, type OptimizerScenario, type PairedObservation
} from './dataset';
import { executeScenario, type ScenarioOutcome } from './eval-adapter';
import { OptimizerCostLedger, type CallReservation } from './cost-ledger';
import { ExperimentManifestStore, manifestStages, type ExperimentManifest } from './manifest';
import {
  contentHash, materialiseSurface, normalizeTrajectory, serializeTrajectory, surfaceHash,
  type HarnessSurface, type SurfaceProposal
} from './surface';

/** P5-01: the fixture exposes exactly one editable component set. */
export function baseSurface(): HarnessSurface {
  // Sorted like every composed surface, so the base revision can be recomputed from its content.
  const components = [
    { id: 'prompt.role', kind: 'prompt' as const, value: 'terse-answer' },
    { id: 'prompt.constraint', kind: 'prompt' as const, value: 'rewrite-user-text' },
    { id: 'guidance.citation-check', kind: 'guidance' as const, value: 'verify-citations-strict' },
    { id: 'guidance.evidence', kind: 'guidance' as const, value: 'write-artifact' },
    { id: 'context.sources', kind: 'context' as const, value: 'attach-workspace' },
    { id: 'skill.flow', kind: 'skill' as const, value: 'search-evidence-compose' }
  ].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const hash = surfaceHash({ schemaVersion: 1, revision: 'base', components });
  return { schemaVersion: 1, revision: `rev-${hash.slice(0, 16)}`, components };
}

const improvedEdits: SurfaceProposal['edits'] = [
  { path: 'components.prompt.constraint', value: 'preserve-user-text' },
  { path: 'components.guidance.evidence', value: 'assert-numbers' }
];

function proposal(id: string, edits: SurfaceProposal['edits'], rationale = 'fixture proposal'): SurfaceProposal {
  return { id, rationale, edits };
}

function materialise(base: HarnessSurface, edits: SurfaceProposal['edits'], id: string): HarnessSurface {
  return materialiseSurface(base, proposal(id, edits)).surface;
}

type CredentialScope = { id: string; workspace: string; externalProviders: string[] };

type SurfaceProbe = {
  label: string;
  surfaceHash: string;
  workspace: string;
  databasePath: string;
  credentialScope: CredentialScope;
  outcomes: ScenarioOutcome[];
  timings: Record<string, number>;
  durationMs: number;
  totals: ReturnType<OptimizerCostLedger['totals']>;
};

/**
 * Each probe owns its directory, SQLite ledger, workspace and credential scope. Nothing is shared
 * with the other side of the comparison, so a candidate cannot observe or mutate the base.
 */
function probeSurface(input: {
  root: string;
  experimentId: string;
  label: string;
  stage: string;
  surface: HarnessSurface;
  scenarios: readonly OptimizerScenario[];
  maxMicrousd?: number | null;
}): SurfaceProbe {
  const dir = join(input.root, input.label);
  mkdirSync(dir, { recursive: true });
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const databasePath = join(dir, 'optimizer.sqlite');
  const revision = surfaceHash(input.surface);
  const started = performance.now();
  const db = new Database(databasePath);
  try {
    const ledger = new OptimizerCostLedger(db);
    ledger.createExperiment(input.experimentId, contentHash({ experimentId: input.experimentId, label: input.label, revision }));
    const outcomes: ScenarioOutcome[] = [];
    const timings: Record<string, number> = {};
    for (const scenario of input.scenarios) {
      ledger.record({
        experimentId: input.experimentId, stage: input.stage, callId: `${scenario.id}:model`, kind: 'model',
        tokens: 80, inputHash: contentHash({ scenario: scenario.id, revision }),
        maxMicrousd: input.maxMicrousd ?? null, actualTokens: 80
      });
      const scenarioStarted = performance.now();
      const outcome = executeScenario(input.surface, scenario, { workspace, allowExternalEffects: false });
      timings[scenario.id] = performance.now() - scenarioStarted;
      outcomes.push(outcome);
      ledger.record({
        experimentId: input.experimentId, stage: input.stage, callId: `${scenario.id}:tool`, kind: 'tool',
        parentCallId: `${scenario.id}:model`, tokens: Math.max(0, outcome.tokens - 80),
        inputHash: contentHash({ scenario: scenario.id, revision, artifact: outcome.artifactRefs }),
        actualTokens: Math.max(0, outcome.tokens - 80)
      });
    }
    return {
      label: input.label, surfaceHash: revision, workspace, databasePath,
      credentialScope: {
        id: `fixture-credential:${contentHash({ experimentId: input.experimentId, label: input.label }).slice(0, 16)}`,
        workspace, externalProviders: []
      },
      outcomes, timings, durationMs: performance.now() - started, totals: ledger.totals(input.experimentId)
    };
  } finally {
    db.close();
  }
}

type AdoptRecord = {
  experimentId: string;
  adopted: 'base' | 'candidate';
  reason: string;
  rationale: string;
  selectorInput: 'anonymous-A/B-stats';
  finalsOnlyDelivery: false;
  baseSurfaceHash: string;
  candidateSurfaceHash: string;
  evidence: {
    qualityBasis: 'fixture-rubric';
    comparison: 'paired-dev' | 'not_run';
    baseMean: number | null; candidateMean: number | null; meanDifference: number | null;
    ciLow: number | null; ciHigh: number | null;
    intervalMethod: 'cluster-bootstrap-percentile' | null;
    clusters: number; scenarios: number;
    baseCostMicrousd: number; candidateCostMicrousd: number;
    candidateVerifierFailures: number; candidateArtifacts: number;
    selectorWinner: 'A' | 'B' | null;
  };
};

type AnonStats = { mean: number | null; costMicrousd: number; verifierFailures: number; artifacts: number };

/** Anonymous selector: it sees only A/B statistics, never which side is base or candidate. */
function selectAnonymous(entries: { A: AnonStats; B: AnonStats }): 'A' | 'B' | null {
  if (entries.A.mean === null || entries.B.mean === null) return null;
  if (entries.A.mean > entries.B.mean) return 'A';
  if (entries.B.mean > entries.A.mean) return 'B';
  return null;
}

/**
 * P5-03: adopt only on a strict, verifier-backed gain. The base surface is always the fallback and
 * every retained/upgraded decision records its reason and evidence.
 */
function adoptCandidate(input: {
  experimentId: string;
  base: SurfaceProbe;
  candidate: SurfaceProbe;
  observations: PairedObservation[];
  costBudgetMicrousd: number;
  budgetStopped?: boolean;
}): AdoptRecord {
  const comparisonRan = input.observations.length > 0 && input.budgetStopped !== true;
  const summary = comparisonRan
    ? pairedClusterSummary(input.observations, { seed: Number.parseInt(input.experimentId.replace(/\D/gu, '').slice(0, 8) || '1', 10) })
    : null;
  const candidateArtifacts = input.candidate.outcomes.reduce((total, outcome) => total + outcome.artifactRefs.length, 0);
  const candidateVerifierFailures = input.candidate.outcomes.filter(outcome => !outcome.verifier.ok).length;
  const baseCost = input.base.totals.costMicrousd;
  const candidateCost = input.candidate.totals.costMicrousd;
  let winner: 'A' | 'B' | null = null;
  let candidateWon = false;
  if (summary !== null) {
    // Anonymise before selection: labels A/B are assigned by content hash, and the selector only
    // receives the statistics. The direction is re-attached afterwards.
    const swap = Number.parseInt(contentHash(input.candidate.surfaceHash).slice(0, 2), 16) % 2 === 1;
    const candidateStats: AnonStats = { mean: summary.candidateMean, costMicrousd: candidateCost,
      verifierFailures: candidateVerifierFailures, artifacts: candidateArtifacts };
    const baseStats: AnonStats = { mean: summary.baseMean, costMicrousd: baseCost,
      verifierFailures: input.base.outcomes.filter(outcome => !outcome.verifier.ok).length,
      artifacts: input.base.outcomes.reduce((total, outcome) => total + outcome.artifactRefs.length, 0) };
    const anonymised = swap ? { A: candidateStats, B: baseStats } : { A: baseStats, B: candidateStats };
    winner = selectAnonymous(anonymised);
    candidateWon = winner !== null && anonymised[winner].mean === summary.candidateMean
      && anonymised[winner].costMicrousd === candidateCost;
  }

  const record = (adopted: 'base' | 'candidate', reason: string, rationale: string): AdoptRecord => ({
    experimentId: input.experimentId, adopted, reason, rationale, selectorInput: 'anonymous-A/B-stats',
    finalsOnlyDelivery: false, baseSurfaceHash: input.base.surfaceHash,
    candidateSurfaceHash: input.candidate.surfaceHash,
    evidence: {
      qualityBasis: 'fixture-rubric', comparison: summary === null ? 'not_run' : 'paired-dev',
      baseMean: summary?.baseMean ?? null, candidateMean: summary?.candidateMean ?? null,
      meanDifference: summary?.meanDifference ?? null, ciLow: summary?.ciLow ?? null, ciHigh: summary?.ciHigh ?? null,
      intervalMethod: summary === null ? null : summary.intervalMethod,
      clusters: summary?.clusters ?? 0, scenarios: summary?.scenarios ?? 0,
      baseCostMicrousd: baseCost, candidateCostMicrousd: candidateCost,
      candidateVerifierFailures, candidateArtifacts, selectorWinner: winner
    }
  });
  if (input.budgetStopped === true || candidateCost > input.costBudgetMicrousd) {
    return record('base', 'candidate_cost_over_budget', 'Candidate probe exceeded the experiment cost budget before a paired comparison.');
  }
  if (candidateArtifacts === 0) {
    return record('base', 'candidate_missing_artifact', 'Candidate produced no artifact; the base surface is retained.');
  }
  if (candidateVerifierFailures > 0) {
    return record('base', 'candidate_verifier_failed', 'Existing research verifier rejected candidate output.');
  }
  if (!candidateWon || summary === null || summary.ciLow <= 0) {
    return record('base', 'selector_inconclusive', 'Anonymous selector found no cluster-level evidence of gain on the fixture rubric.');
  }
  return record('candidate', 'candidate_quality_gain', 'Anonymous paired fixture-rubric comparison with cluster-bootstrap CI above zero.');
}

function workspaceFingerprint(path: string): string {
  try {
    const files = readdirSync(path, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => `${entry.parentPath.split('/').slice(-2).join('/')}/${entry.name}`);
    return contentHash(files.sort());
  } catch { return contentHash([]); }
}

function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name));
}

function readTotals(databasePath: string, experimentId: string): ReturnType<OptimizerCostLedger['totals']> {
  const db = new Database(databasePath, { readonly: true });
  try { return new OptimizerCostLedger(db).totals(experimentId); } finally { db.close(); }
}

const devScenarios = (limit?: number): OptimizerScenario[] => {
  const scenarios = readSplit(buildDataset(), 'dev', 'rewriter');
  return limit === undefined ? scenarios : scenarios.slice(0, limit);
};

function observations(base: SurfaceProbe, candidate: SurfaceProbe): PairedObservation[] {
  const byId = new Map(candidate.outcomes.map(outcome => [outcome.scenarioId, outcome]));
  return base.outcomes.map(outcome => {
    const other = byId.get(outcome.scenarioId);
    assert.ok(other !== undefined, `missing paired outcome ${outcome.scenarioId}`);
    return {
      scenarioId: outcome.scenarioId, clusterId: outcome.clusterId, base: outcome.score, candidate: other.score,
      baseDurationMs: base.timings[outcome.scenarioId] ?? 0,
      candidateDurationMs: candidate.timings[outcome.scenarioId] ?? 0
    };
  });
}

export async function verifyOptimizer(name: string, directory: string): Promise<Record<string, unknown>> {
  const base = baseSurface();
  const cases: Record<string, () => Record<string, unknown> | Promise<Record<string, unknown>>> = {
    'optimizer-surface': () => verifySurface(base, directory),
    'optimizer-isolation': () => verifyIsolation(base, directory),
    'optimizer-adopt': () => verifyAdopt(base, directory),
    'optimizer-dataset': () => verifyDataset(base, directory),
    'optimizer-cost-manifest': () => verifyCostManifest(directory)
  };
  const run = cases[name];
  if (run === undefined) throw new Error(`unsupported_optimizer_case:${name}`);
  return run();
}

function verifySurface(base: HarnessSurface, directory: string): Record<string, unknown> {
  const candidate = proposal('candidate-role', [
    { path: 'components.prompt.role', value: 'evidence-rich' }
  ]);
  const first = materialiseSurface(base, candidate);
  const second = materialiseSurface(base, candidate);
  assert.equal(first.hash, second.hash);
  assert.equal(first.surface.revision, second.surface.revision);
  assert.deepEqual(first.changedIds, ['prompt.role']);
  assert.equal(surfaceHash(base), surfaceHash(baseSurface()));
  assert.notEqual(first.hash, surfaceHash(base));

  const rejected: { proposal: unknown; pattern: RegExp }[] = [
    { proposal: proposal('forbidden-permission', [{ path: 'components.permissions.tools', value: 'all' }]), pattern: /forbidden_surface/u },
    { proposal: proposal('forbidden-budget', [{ path: 'components.budget.maxTokens', value: '1' }]), pattern: /forbidden_surface/u },
    { proposal: proposal('forbidden-scorer', [{ path: 'components.scorer.rubric', value: 'x' }]), pattern: /forbidden_surface/u },
    { proposal: proposal('forbidden-verifier', [{ path: 'components.verifier.strict', value: 'x' }]), pattern: /forbidden_surface/u },
    { proposal: proposal('absolute-path', [{ path: 'components.prompt.role', value: '/etc/passwd' }]), pattern: /unsafe_value/u },
    { proposal: proposal('traversal', [{ path: 'components.prompt.role', value: '../../secrets.txt' }]), pattern: /unsafe_value/u },
    { proposal: proposal('holdout-leak', [{ path: 'components.prompt.role', value: 'read holdout-01' }]), pattern: /holdout_protected/u },
    { proposal: proposal('unknown-component', [{ path: 'components.prompt.missing', value: 'x' }]), pattern: /unknown_component/u },
    { proposal: proposal('duplicate', [{ path: 'components.prompt.role', value: 'a' }, { path: 'components.prompt.role', value: 'b' }]), pattern: /duplicate_edit/u },
    { proposal: proposal('deep-path', [{ path: 'components.prompt.role.extra', value: 'x' }]), pattern: /not_editable/u },
    { proposal: { ...candidate, allowTools: true }, pattern: /invalid_shape/u },
    { proposal: { id: 'no-edits', rationale: 'x', edits: [] }, pattern: /invalid_shape/u }
  ];
  const observed: string[] = [];
  for (const entry of rejected) {
    try { materialiseSurface(base, entry.proposal); }
    catch (error) { assert.match(String(error), entry.pattern); observed.push(String(error)); }
  }
  assert.equal(observed.length, rejected.length, 'every out-of-surface proposal must be rejected');

  const scenario = devScenarios(1)[0];
  const workspaceA = join(directory, 'trajectory-a');
  const workspaceB = join(directory, 'trajectory-b');
  const left = executeScenario(first.surface, scenario, { workspace: workspaceA, allowExternalEffects: false });
  const right = executeScenario(first.surface, scenario, { workspace: workspaceB, allowExternalEffects: false });
  assert.equal(serializeTrajectory(left.trajectory), serializeTrajectory(right.trajectory));
  assert.throws(() => normalizeTrajectory({ ...left.trajectory, steps: left.trajectory.steps.map(step => ({ ...step, index: 7 })) }),
    /non_sequential_index/u);
  assert.throws(() => executeScenario(first.surface, scenario, { workspace: workspaceA, allowExternalEffects: true }),
    /optimizer_adapter_egress_forbidden/u);
  writeFileSync(join(directory, 'surface.json'), JSON.stringify({ base: surfaceHash(base), candidate: first.hash, rejected: observed.length }));
  return { baseHash: surfaceHash(base), candidateHash: first.hash, revision: first.surface.revision,
    changedIds: first.changedIds, rejected: observed.length, trajectoryStable: true };
}

function verifyIsolation(base: HarnessSurface, directory: string): Record<string, unknown> {
  const root = join(directory, 'candidates');
  const experimentId = 'isolation';
  const scenarios = devScenarios(4);
  const candidateSurface = materialise(base, improvedEdits, 'isolation-candidate');
  const outside = join(directory, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'sentinel.txt'), 'outside fixture');
  const outsideBefore = contentHash(listFiles(outside).map(file => readFileSync(file, 'utf8')));
  const baseProbe = probeSurface({ root, experimentId, label: 'base', stage: 'probe-base', surface: base, scenarios });
  const baseFingerprint = workspaceFingerprint(baseProbe.workspace);
  const candidateProbe = probeSurface({ root, experimentId, label: 'candidate', stage: 'probe-candidate',
    surface: candidateSurface, scenarios });
  assert.notEqual(baseProbe.workspace, candidateProbe.workspace);
  assert.notEqual(baseProbe.databasePath, candidateProbe.databasePath);
  assert.notEqual(baseProbe.credentialScope.id, candidateProbe.credentialScope.id);
  assert.equal(candidateProbe.credentialScope.workspace, candidateProbe.workspace);
  assert.deepEqual(candidateProbe.credentialScope.externalProviders, []);
  assert.equal(workspaceFingerprint(baseProbe.workspace), baseFingerprint, 'candidate probe must not touch the base workspace');
  const drafts = readdirSync(candidateProbe.workspace).filter(file => file.startsWith('draft-'));
  assert.equal(drafts.length, scenarios.length);
  const baseDraft = readFileSync(join(baseProbe.workspace, drafts[0]), 'utf8');
  const candidateDraft = readFileSync(join(candidateProbe.workspace, drafts[0]), 'utf8');
  assert.notEqual(baseDraft, candidateDraft, 'candidate behavior must be produced in its own workspace');
  // Measured write scope: every created file stays under this case's root, and the outside
  // sentinel is byte-identical afterwards.
  const created = listFiles(directory).filter(file => file !== join(directory, 'isolation.json'));
  const unexpectedWrites = created.filter(file => !file.startsWith(root) && file !== join(outside, 'sentinel.txt'));
  assert.deepEqual(unexpectedWrites, [], 'every created file must stay inside a candidate directory');
  assert.equal(contentHash(listFiles(outside).map(file => readFileSync(file, 'utf8'))), outsideBefore);
  // Each ledger only contains its own stage; the split is real, not just a token comparison.
  const baseStages = new Set(new OptimizerCostLedger(new Database(baseProbe.databasePath, { readonly: true }))
    .report(experimentId).map(row => row.stage));
  const candidateStages = new Set(new OptimizerCostLedger(new Database(candidateProbe.databasePath, { readonly: true }))
    .report(experimentId).map(row => row.stage));
  assert.deepEqual([...baseStages], ['probe-base']);
  assert.deepEqual([...candidateStages], ['probe-candidate']);

  // An invalid proposal is retried at most once with a budgeted call, then falls back to base.
  const retryRoot = join(directory, 'retry');
  mkdirSync(retryRoot, { recursive: true });
  const db = new Database(join(retryRoot, 'optimizer.sqlite'));
  try {
    const ledger = new OptimizerCostLedger(db);
    ledger.createExperiment('retry', contentHash('retry'));
    const rejected: string[] = [];
    let adopted = base;
    const attempted = proposal('invalid-attempt', [{ path: 'components.budget.maxTokens', value: '1' }]);
    for (let attempt = 0; attempt < 2; attempt++) {
      ledger.record({
        experimentId: 'retry', stage: 'propose', callId: `propose-${attempt + 1}`,
        kind: attempt === 0 ? 'model' : 'retry', tokens: 40,
        inputHash: contentHash({ attempt, proposal: attempted.id }), actualTokens: 40
      });
      try { adopted = materialiseSurface(base, attempted).surface; }
      catch (error) { rejected.push(String(error)); }
    }
    assert.equal(rejected.length, 2);
    assert.equal(surfaceHash(adopted), surfaceHash(base));
    const totals = ledger.totals('retry');
    assert.equal(totals.byKind.retry, 1);
    assert.equal(totals.byKind.model, 1);
    return { baseWorkspace: baseProbe.workspace, candidateWorkspace: candidateProbe.workspace,
      baseDatabase: baseProbe.databasePath, candidateDatabase: candidateProbe.databasePath,
      externalWrites: unexpectedWrites.length, outsideSentinelUnchanged: true, isolated: true,
      retries: totals.byKind.retry, fallbackToBase: true, rejected: rejected.length,
      candidateCalls: candidateProbe.totals.calls, baseCalls: baseProbe.totals.calls };
  } finally { db.close(); }
}

function verifyAdopt(base: HarnessSurface, directory: string): Record<string, unknown> {
  const scenarios = devScenarios();
  const budget = 100_000;
  const improved = materialise(base, improvedEdits, 'improved');
  const regression = materialise(base, [{ path: 'components.guidance.citation-check', value: 'skip-citations' }], 'regression');
  const missingArtifact = materialise(base, [{ path: 'components.guidance.evidence', value: 'skip-artifact' }], 'no-artifact');
  const neutral = materialise(base, [{ path: 'components.skill.flow', value: 'search-evidence-compose-v2' }], 'neutral');

  const runPair = (experimentId: string, candidate: HarnessSurface, options: { candidateBudget?: number } = {}) => {
    const root = join(directory, experimentId);
    const baseProbe = probeSurface({ root, experimentId, label: 'base', stage: 'probe-base', surface: base, scenarios });
    let candidateProbe: SurfaceProbe | null = null;
    let budgetStopped = false;
    try {
      candidateProbe = probeSurface({ root, experimentId, label: 'candidate', stage: 'probe-candidate',
        surface: candidate, scenarios, maxMicrousd: options.candidateBudget ?? null });
    } catch (error) {
      assert.match(String(error), /optimizer_budget_exhausted/u);
      budgetStopped = true;
    }
    const resolved = candidateProbe ?? {
      label: 'candidate', surfaceHash: surfaceHash(candidate),
      workspace: join(root, 'candidate', 'workspace'), databasePath: join(root, 'candidate', 'optimizer.sqlite'),
      credentialScope: { id: 'fixture-credential:stopped', workspace: join(root, 'candidate', 'workspace'), externalProviders: [] },
      outcomes: [], timings: {}, durationMs: 0, totals: readTotals(join(root, 'candidate', 'optimizer.sqlite'), experimentId)
    };
    const paired = candidateProbe === null ? [] : observations(baseProbe, candidateProbe);
    return { record: adoptCandidate({ experimentId, base: baseProbe, candidate: resolved, observations: paired,
      costBudgetMicrousd: budget, budgetStopped }), baseProbe, candidateProbe: resolved };
  };

  const gain = runPair('adopt-gain', improved);
  assert.equal(gain.record.adopted, 'candidate');
  assert.equal(gain.record.reason, 'candidate_quality_gain');
  assert.ok(gain.record.evidence.ciLow !== null && gain.record.evidence.ciLow > 0);
  assert.equal(gain.record.evidence.qualityBasis, 'fixture-rubric');
  assert.equal(gain.record.evidence.comparison, 'paired-dev');
  assert.equal(gain.record.finalsOnlyDelivery, false);

  const failed = runPair('adopt-verifier', regression);
  assert.equal(failed.record.adopted, 'base');
  assert.equal(failed.record.reason, 'candidate_verifier_failed');

  const empty = runPair('adopt-artifact', missingArtifact);
  assert.equal(empty.record.adopted, 'base');
  assert.equal(empty.record.reason, 'candidate_missing_artifact');

  const expensive = runPair('adopt-cost', improved, { candidateBudget: 100 });
  assert.equal(expensive.record.adopted, 'base');
  assert.equal(expensive.record.reason, 'candidate_cost_over_budget');
  assert.equal(expensive.record.evidence.comparison, 'not_run');
  assert.equal(expensive.record.evidence.baseMean, null);
  assert.equal(expensive.record.evidence.ciLow, null);

  const tie = runPair('adopt-tie', neutral);
  assert.equal(tie.record.adopted, 'base');
  assert.equal(tie.record.reason, 'selector_inconclusive');

  for (const result of [gain, failed, empty, expensive, tie]) {
    assert.ok(result.record.rationale.length > 0);
    assert.equal(result.record.baseSurfaceHash, surfaceHash(base));
  }
  writeFileSync(join(directory, 'adopt-records.json'), JSON.stringify([gain, failed, empty, expensive, tie]
    .map(result => result.record), null, 2));
  return {
    adopted: gain.record.adopted,
    reasons: [gain, failed, empty, expensive, tie].map(result => result.record.reason),
    selector: 'anonymous-A/B-stats', finalsOnlyDelivery: false,
    evidence: gain.record.evidence
  };
}

function verifyDataset(base: HarnessSurface, directory: string): Record<string, unknown> {
  const dataset = buildDataset();
  assert.equal(contentHash(buildDataset()), contentHash(buildDataset()));
  const shape = verifyDatasetShape(dataset);
  assert.equal(shape.scenarios, 240);
  assert.equal(shape.clusters, 48);
  const splits = shape.splits as Record<string, { scenarios: number; clusters: number }>;
  assert.equal(splits.holdout.scenarios, 75);
  const readerRejections: string[] = [];
  for (const reader of ['rewriter', 'selector'] as DatasetReader[]) {
    try { readSplit(dataset, 'holdout', reader); }
    catch (error) { readerRejections.push(String(error)); }
  }
  assert.equal(readerRejections.length, 2);
  assert.throws(() => readSplit(dataset, 'holdout', 'holdout-evaluator'), /not_frozen/u);
  const frozen = freezeDataset(dataset);
  // Holding the dataset is not enough: a key forged from the public hash is rejected.
  assert.throws(() => readSplit(frozen.dataset, 'holdout', 'holdout-evaluator',
    { datasetHash: frozen.dataset.frozen ?? '', secret: frozen.dataset.frozen ?? '' }), /key_mismatch/u);
  const holdout = readSplit(frozen.dataset, 'holdout', 'holdout-evaluator', frozen.key);
  assert.equal(holdout.length, 75);
  const snapshot = frozen.dataset.scenarios[0].payload.draft;
  frozen.dataset.scenarios[0].payload.draft += ' mutation';
  assert.throws(() => readSplit(frozen.dataset, 'holdout', 'holdout-evaluator', frozen.key), /mutated/u);
  frozen.dataset.scenarios[0].payload.draft = snapshot;

  const scenarios = readSplit(frozen.dataset, 'dev', 'rewriter');
  const root = join(directory, 'dev');
  const baseProbe = probeSurface({ root, experimentId: 'dataset', label: 'base', stage: 'probe-base', surface: base, scenarios });
  const fullProbe = probeSurface({ root, experimentId: 'dataset', label: 'full', stage: 'probe-variant',
    surface: materialise(base, improvedEdits, 'full'), scenarios });
  const constraintProbe = probeSurface({ root, experimentId: 'dataset', label: 'constraint', stage: 'probe-variant',
    surface: materialise(base, [improvedEdits[0]], 'constraint-only'), scenarios });
  const numbersProbe = probeSurface({ root, experimentId: 'dataset', label: 'numbers', stage: 'probe-variant',
    surface: materialise(base, [improvedEdits[1]], 'numbers-only'), scenarios });
  const noCitationsProbe = probeSurface({ root, experimentId: 'dataset', label: 'no-citations', stage: 'probe-variant',
    surface: materialise(base, [{ path: 'components.guidance.citation-check', value: 'skip-citations' }], 'no-citation-check'), scenarios });
  const regressionProbe = probeSurface({ root, experimentId: 'dataset', label: 'regression', stage: 'probe-variant',
    surface: materialise(base, [{ path: 'components.guidance.evidence', value: 'skip-artifact' }], 'regression'), scenarios });

  const gain = pairedClusterSummary(observations(baseProbe, fullProbe), { seed: 7 });
  const loss = pairedClusterSummary(observations(baseProbe, regressionProbe), { seed: 7 });
  const ablations = ablationReport('dev', observations(baseProbe, fullProbe), [
    { id: 'constraint-only', observations: observations(baseProbe, constraintProbe) },
    { id: 'numbers-only', observations: observations(baseProbe, numbersProbe) },
    { id: 'no-citation-check', observations: observations(baseProbe, noCitationsProbe) }
  ]);
  assert.equal(gain.scenarios, scenarios.length);
  assert.equal(gain.clusters, splits.dev.clusters);
  assert.equal(gain.failuresIncluded, true);
  assert.equal(gain.intervalMethod, 'cluster-bootstrap-percentile');
  assert.ok(gain.meanDifference !== 0);
  assert.ok(gain.ciLow > 0 && gain.ciHigh >= gain.ciLow);
  assert.ok(gain.baseDurationMs > 0 && gain.candidateDurationMs > 0, 'timing must be measured');
  assert.equal(loss.scenarios, scenarios.length, 'failures stay in the denominator');
  assert.ok(loss.candidateMean < loss.baseMean);
  assert.ok(loss.basePassRateInterval.low <= loss.basePassRate && loss.basePassRate <= loss.basePassRateInterval.high);
  assert.equal(ablations.length, 4);
  assert.deepEqual(ablations.map(entry => entry.id),
    ['dev:full', 'dev:constraint-only', 'dev:numbers-only', 'dev:no-citation-check']);
  // Each ablation is attributable to its own edit, and the combined candidate beats either alone.
  for (const single of [ablations[1], ablations[2]]) {
    assert.ok(single.summary.meanDifference > 0);
    assert.ok(single.summary.meanDifference < ablations[0].summary.meanDifference);
  }
  assert.ok(ablations[3].summary.meanDifference < 0, 'removing the passing citation check must lose quality');

  // Holdout is scored once, after the candidate is frozen, and only through the evaluator key.
  const holdoutProbe = probeSurface({ root: join(directory, 'holdout'), experimentId: 'holdout',
    label: 'candidate', stage: 'probe-holdout', surface: materialise(base, improvedEdits, 'holdout'),
    scenarios: holdout });
  const holdoutPassRate = holdoutProbe.outcomes.filter(outcome => outcome.passed).length / holdoutProbe.outcomes.length;
  writeFileSync(join(directory, 'stats.json'), JSON.stringify({ gain, loss, ablations,
    holdout: { scenarios: holdout.length, passRate: holdoutPassRate } }, null, 2));
  return { shape, holdoutProtected: readerRejections.length, holdoutKeyForgeryRejected: true,
    holdoutMutationRejected: true, holdoutScenarios: holdout.length, holdoutPassRate,
    repetitionsPerScenario: 1, gain, loss, ablations: ablations.length };
}

async function verifyCostManifest(directory: string): Promise<Record<string, unknown>> {
  const root = join(directory, 'manifest');
  mkdirSync(root, { recursive: true });
  const manifestPath = join(root, 'manifest.json');
  const databasePath = join(root, 'optimizer.sqlite');
  const experimentId = 'cost-manifest';
  const dataset = freezeDataset(buildDataset()).dataset;
  const effects: Record<string, number> = {};
  const touch = (stage: string): void => { effects[stage] = (effects[stage] ?? 0) + 1; };

  const store = new ExperimentManifestStore(manifestPath);
  let db = new Database(databasePath);
  let ledger = new OptimizerCostLedger(db);
  const manifest = store.create({ experimentId, datasetHash: contentHash(dataset.scenarios),
    baseSurfaceHash: surfaceHash(baseSurface()) });
  ledger.createExperiment(experimentId, contentHash(manifest));
  await store.runStage('dataset', () => { touch('dataset'); return { scenarios: dataset.scenarios.length }; });
  await store.runStage('propose', () => { touch('propose'); return { proposalId: 'cost-manifest' }; });
  await store.runStage('validate', () => { touch('validate'); return { valid: true }; });
  db.close();

  // Simulated interruption: reopen both stores and resume. Completed stages must not repeat.
  db = new Database(databasePath);
  ledger = new OptimizerCostLedger(db);
  const reopened = new ExperimentManifestStore(manifestPath);
  const pending = reopened.pending(reopened.read() as ExperimentManifest);
  assert.deepEqual(pending, ['probe-base', 'probe-candidate', 'compose', 'adopt']);
  await reopened.runStage('dataset', () => { touch('dataset'); return 'must-not-run'; });
  await reopened.runStage('probe-candidate', () => { touch('probe-candidate'); return { artifacts: 1 }; });
  assert.equal(effects.dataset, 1);
  assert.equal(effects.propose, 1);
  assert.equal(effects.validate, 1);
  assert.equal(effects['probe-candidate'], 1);

  const call = (input: Omit<CallReservation, 'experimentId'> & { actualTokens: number }) =>
    ledger.record({ experimentId, ...input });
  call({ stage: 'probe-base', callId: 'model-1', kind: 'model', tokens: 120, inputHash: contentHash('m1'), actualTokens: 120 });
  call({ stage: 'probe-base', callId: 'model-retry', kind: 'retry', attempt: 1, tokens: 60, inputHash: contentHash('retry-1'), actualTokens: 60 });
  call({ stage: 'probe-base', callId: 'model-retry', kind: 'retry', attempt: 2, tokens: 60, inputHash: contentHash('retry-2'), actualTokens: 60 });
  call({ stage: 'probe-base', callId: 'summary-1', kind: 'summary', tokens: 30, inputHash: contentHash('summary'), actualTokens: 30 });
  call({ stage: 'probe-candidate', callId: 'child-1', kind: 'child', parentCallId: 'model-1', tokens: 50, inputHash: contentHash('child'), actualTokens: 50 });
  call({ stage: 'compose', callId: 'selection-1', kind: 'selection', tokens: 10, inputHash: contentHash('selection'), actualTokens: 10 });
  call({ stage: 'compose', callId: 'reflection-1', kind: 'reflection', tokens: 10, inputHash: contentHash('reflection'), actualTokens: 10 });
  call({ stage: 'adopt', callId: 'judge-1', kind: 'judge', tokens: 10, inputHash: contentHash('judge'), actualTokens: 10 });
  const beforeResume = ledger.totals(experimentId);

  // Repeated reservation of a settled call must reuse the row rather than charge again.
  const reused = ledger.reserve({ experimentId, stage: 'probe-base', callId: 'model-1', kind: 'model', tokens: 120,
    inputHash: contentHash('m1') });
  assert.equal(reused.reused, true);
  assert.equal(reused.state, 'settled');
  assert.deepEqual(ledger.totals(experimentId), beforeResume);
  assert.throws(() => ledger.reserve({ experimentId, stage: 'probe-base', callId: 'model-1', kind: 'model',
    tokens: 999, inputHash: contentHash('m1') }), /input_drift/u);

  // A budget stop is recorded, so accounting is never silently short.
  assert.throws(() => ledger.reserve({ experimentId, stage: 'probe-base', callId: 'over-budget', kind: 'model',
    tokens: 10_000, inputHash: contentHash('over'), maxMicrousd: beforeResume.costMicrousd + 1 }),
  /optimizer_budget_exhausted/u);
  const stopped = ledger.totals(experimentId);
  assert.ok(stopped.tokens > beforeResume.tokens, 'the stopped call must still be accounted');
  assert.ok(ledger.report(experimentId).some(row => row.state === 'budget_stopped'));
  const stoppedHash = ledger.reportHash(experimentId);

  const report = ledger.report(experimentId);
  assert.equal(report.length, stopped.calls);
  const child = report.find(row => row.call_id === 'child-1');
  assert.equal(child?.parent_call_id, 'model-1');
  assert.equal(report.filter(row => row.kind === 'retry').length, 2);
  assert.equal(stopped.byKind.retry, 2);
  assert.equal(stopped.byKind.summary, 1);
  assert.equal(stopped.byKind.child, 1);
  assert.equal(stopped.byKind.selection, 1);
  assert.equal(stopped.byKind.reflection, 1);
  assert.equal(stopped.byKind.judge, 1);
  assert.ok(stopped.byStage['probe-base'] >= 4);

  // Resume again: the manifest skips completed stages and the ledger totals stay identical.
  await reopened.runStage('probe-candidate', () => { touch('probe-candidate'); return 'must-not-run'; });
  assert.equal(effects['probe-candidate'], 1);
  assert.deepEqual(ledger.totals(experimentId), stopped);
  assert.equal(ledger.reportHash(experimentId), stoppedHash, 'resume must not change the call table');
  const finalManifest = reopened.read() as ExperimentManifest;
  assert.deepEqual(reopened.pending(finalManifest), ['probe-base', 'compose', 'adopt']);
  assert.deepEqual(Object.keys(finalManifest.stages).filter(stage => !manifestStages.includes(stage as never)), []);
  db.close();
  writeFileSync(join(directory, 'cost-report.json'), JSON.stringify({ totals: stopped, report }, null, 2));
  return { stagesCompleted: Object.keys(finalManifest.stages), resumeSkipped: true,
    totals: stopped, calls: report.length, reportHash: stoppedHash, effects };
}
