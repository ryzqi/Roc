import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyMemoryDatabaseSchema } from '../../src/main/infrastructure/database-schemas';
import {
  ExperienceRecordStore, experienceContentHash, type ExperienceRecordInput
} from '../../src/main/services/memory/experience-records';
import {
  buildFailureFixture, evaluateUpgradeGate, type VersionFingerprint
} from '../../src/main/services/memory/experience-fixtures';
import { HarnessReleaseStore } from '../../src/main/services/deep-agent/harness-release';
import { PilotStateStore, defaultPilotSettings, evaluatePilotDecision } from '../../src/main/services/deep-agent/pilot-gate';
import { baseSurface } from './optimizer/optimizer';
import { executeScenario } from './optimizer/eval-adapter';
import { buildDataset, readSplit, type PairedObservation } from './optimizer/dataset';
import { materialiseSurface } from './optimizer/surface';
import { transferReport, transferStrata, type TransferStratum } from './optimizer/transfer';

const hex = (value: string): string => createHash('sha256').update(value).digest('hex');

function adoption(executionRevision = 'exec-rev-1', improvementRevision = 'imp-rev-1'): ExperienceRecordInput['adoption'] {
  const evidence = [{ ref: 'optimizer:adopt-run', sha256: hex('adopt-run') }];
  return {
    experimentId: 'exp-p6',
    adopted: 'candidate',
    adoptionHash: experienceContentHash({ experimentId: 'exp-p6', evidence, decision: 'candidate' }),
    evidence,
    harness: { executionRevision, improvementRevision }
  };
}

function experienceInput(overrides: Partial<ExperienceRecordInput> = {}): ExperienceRecordInput {
  return {
    id: 'citation-first',
    cue: 'when a draft cites an unknown key',
    lesson: 'verify every citation before composing the export',
    confidence: 'medium',
    counterexamples: [],
    invalidation: { expiresAt: null, invalidWhen: null },
    adoption: adoption(),
    projectScopeHash: null,
    taskId: 'task-pilot',
    cueTaskIndex: 1,
    observedTaskIndex: 2,
    ...overrides
  };
}

function verifyExperienceRecords(directory: string): Record<string, unknown> {
  const db = new Database(join(directory, 'experience.sqlite'));
  applyMemoryDatabaseSchema(db);
  try {
    const store = new ExperienceRecordStore(db, { now: () => '2026-10-21T10:00:00.000Z' });
    const record = store.record(experienceInput());
    assert.equal(record.version, 1);
    assert.equal(record.status, 'active');

    const query = { taskIndex: 2, executionRevision: 'exec-rev-1' };
    assert.deepEqual(store.applicable(query).map(entry => entry.id), ['citation-first']);
    // A future task index cannot read a cue learned later, and another harness revision is invalid.
    assert.equal(store.applicable({ ...query, taskIndex: 0 }).length, 0);
    assert.equal(store.applicable({ ...query, executionRevision: 'exec-rev-2' }).length, 0);

    const rejected: Record<string, string> = {};
    const expectReject = (name: string, input: unknown, pattern: RegExp): void => {
      assert.throws(() => store.record(input), pattern);
      rejected[name] = 'rejected';
    };
    expectReject('noEvidence', experienceInput({ id: 'no-evidence', adoption: { ...adoption(), evidence: [] } }), /evidence/);
    expectReject('baseAdoption', experienceInput({ id: 'base-adoption' , adoption: { ...adoption(), adopted: 'base' as never } }), /adopted/);
    expectReject('holdoutLesson', experienceInput({ id: 'holdout', lesson: 'the holdout split improved' }), /private:lesson/);
    expectReject('holdoutField', experienceInput({ id: 'holdout-field', holdoutVerdict: 'pass' } as never), /unrecognized|field/i);
    expectReject('absolutePath', experienceInput({ id: 'path', cue: 'open /Users/someone/paper.tex' }), /private:cue/);
    expectReject('nonHomeAbsolutePath', experienceInput({ id: 'etc-path', cue: 'read /etc/passwd first' }), /private:cue/);
    expectReject('email', experienceInput({ id: 'email', cue: 'ask reviewer@example.org first' }), /private:cue/);
    expectReject('futureCue', experienceInput({ id: 'future', cueTaskIndex: 3, observedTaskIndex: 2 }), /future_cue/);
    expectReject('conflatedHarness', experienceInput({ id: 'conflated', adoption: adoption('same-rev', 'same-rev') }), /harness_revision_conflated/);

    // Versions are append-only and the latest version wins.
    store.record(experienceInput({ lesson: 'verify citations and record the verifier receipt' }));
    assert.equal(store.list().length, 1);
    assert.equal(store.latest('citation-first')?.version, 2);

    // Quarantine hides the lesson but keeps history; revocation is terminal and needs a counterexample.
    store.setStatus({ id: 'citation-first', status: 'quarantined', reason: 're-testing cross-model' });
    assert.equal(store.applicable(query).length, 0);
    assert.equal(store.list()[0].status, 'quarantined');
    // Rewriting a quarantined lesson keeps it quarantined; only an explicit review revives it.
    store.record(experienceInput({ lesson: 'verify citations, re-tested' }));
    assert.equal(store.latest('citation-first')?.status, 'quarantined');
    assert.equal(store.applicable(query).length, 0);
    store.setStatus({ id: 'citation-first', status: 'active', reason: 're-test passed' });
    assert.equal(store.applicable(query).length, 1);
    assert.throws(() => store.setStatus({ id: 'citation-first', status: 'revoked', reason: 'wrong lesson' }), /counterexample_required/);
    store.setStatus({ id: 'citation-first', status: 'revoked', reason: 'wrong lesson', counterexample: 'model ignored the check' });
    assert.equal(store.applicable(query).length, 0);
    assert.throws(() => store.setStatus({ id: 'citation-first', status: 'active', reason: 'revive' }), /terminal/);
    assert.throws(() => store.record(experienceInput()), /terminal/);

    // Scope and expiry are enforced at read time.
    store.record(experienceInput({ id: 'scoped', projectScopeHash: hex('project-a') }));
    assert.equal(store.applicable({ ...query, projectScopeHash: hex('project-a') }).length, 1);
    assert.equal(store.applicable({ ...query, projectScopeHash: hex('project-b') }).length, 0);
    store.record(experienceInput({ id: 'expired', invalidation: { expiresAt: '2026-10-20T00:00:00.000Z', invalidWhen: null } }));
    assert.equal(store.applicable(query).some(entry => entry.id === 'expired'), false);

    writeFileSync(join(directory, 'records.json'), JSON.stringify(store.list(), null, 2));
    return {
      applicable: store.applicable(query).map(entry => entry.id),
      allActive: store.list().filter(entry => entry.status === 'active').map(entry => entry.id),
      rejected,
      versions: store.latest('citation-first')?.version ?? 0,
      revokedTerminal: true,
      futureCueBlocked: true,
      crossRevisionBlocked: true
    };
  } finally {
    db.close();
  }
}

function verifyExperienceTransfer(directory: string): Record<string, unknown> {
  const base = baseSurface();
  const candidate = materialiseSurface(base, {
    id: 'p6-transfer',
    rationale: 'fixture transfer proposal',
    edits: [
      { path: 'components.prompt.constraint', value: 'preserve-user-text' },
      { path: 'components.guidance.evidence', value: 'assert-numbers' }
    ]
  }).surface;
  const scenarios = readSplit(buildDataset(), 'dev', 'rewriter');
  const ranges: Record<TransferStratum, [number, number]> = {
    'single-task': [0, 12],
    'cross-task': [12, 24],
    'cross-project': [24, 36],
    'cross-model': [36, 45]
  };
  const observations = {} as Record<TransferStratum, PairedObservation[]>;
  for (const stratum of transferStrata) {
    const [start, end] = ranges[stratum];
    const workspace = join(directory, stratum);
    observations[stratum] = scenarios.slice(start, end).map(scenario => {
      const baseOutcome = executeScenario(base, scenario, { workspace: join(workspace, 'base'), allowExternalEffects: false });
      const candidateOutcome = executeScenario(candidate, scenario, { workspace: join(workspace, 'candidate'), allowExternalEffects: false });
      return {
        scenarioId: scenario.id,
        clusterId: `${stratum}:${scenario.clusterId}`,
        base: baseOutcome.score,
        candidate: candidateOutcome.score,
        baseDurationMs: 1,
        candidateDurationMs: 1
      };
    });
  }
  const report = transferReport(observations, { seed: 42 });
  // The fixture relabels the same adapter/scenarios; it cannot claim real transfer conditions.
  assert.equal(report.strataRealism, 'label-only');
  const summaries = [report.singleTask, ...Object.values(report.transfer)];
  const expectedClaim = summaries.every(summary => summary.ciLow > 0)
    ? 'transfers'
    : report.singleTask.ciLow > 0 ? 'single-task-only' : 'no-gain';
  assert.equal(report.verdict.claim, expectedClaim);
  for (const stratum of transferStrata) {
    const summary = stratum === 'single-task' ? report.singleTask : report.transfer[stratum];
    assert.ok(summary.scenarios > 0);
    assert.ok(Number.isFinite(summary.meanDifference));
  }
  // A lesson that only helps its own task must not be reported as transferring.
  const noTransfer = transferReport({
    'single-task': observations['single-task'],
    'cross-task': observations['cross-task'],
    'cross-project': observations['cross-project'].map(observation => ({ ...observation, candidate: observation.base })),
    'cross-model': observations['cross-model'].map(observation => ({ ...observation, candidate: observation.base }))
  }, { seed: 42 });
  assert.equal(noTransfer.verdict.claim, 'single-task-only');
  assert.equal(noTransfer.transfer['cross-project'].meanDifference, 0);
  // Holdout scenarios are never part of a rewriter-visible transfer report.
  for (const stratum of transferStrata) {
    for (const observation of observations[stratum]) {
      const scenario = buildDataset().scenarios.find(entry => entry.id === observation.scenarioId);
      assert.ok(scenario !== undefined, `missing scenario ${observation.scenarioId}`);
      assert.equal(scenario.split, 'dev');
    }
  }
  writeFileSync(join(directory, 'transfer.json'), JSON.stringify(report, null, 2));
  return {
    claim: report.verdict.claim,
    singleTask: report.singleTask.meanDifference,
    transfer: Object.fromEntries(Object.entries(report.transfer).map(([key, value]) => [key, value.meanDifference])),
    strataRealism: report.strataRealism,
    degradedClaim: noTransfer.verdict.claim
  };
}

function verifyExperienceRetention(directory: string): Record<string, unknown> {
  const fixture = buildFailureFixture({
    failureClass: 'provider',
    failureCode: 'stream /Users/a/p.pdf /etc/passwd Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.sig a@b.org https://x.org/y',
    toolName: 'read_pdf',
    stage: 'provider-stream',
    tokens: 1200
  });
  assert.ok(fixture.redactions.includes('path'));
  assert.ok(fixture.redactions.includes('email'));
  assert.ok(fixture.redactions.includes('url'));
  assert.ok(fixture.redactions.includes('secret'));
  const serialized = JSON.stringify(fixture);
  for (const secret of ['/Users/', '/etc/passwd', 'eyJhbGci', 'a@b.org', 'https://x.org']) {
    assert.equal(serialized.includes(secret), false, `fixture leaked ${secret}`);
  }
  assert.ok(fixture.failureCode.includes('<path>'));
  assert.ok(fixture.failureCode.includes('[REDACTED]'));
  assert.throws(() => buildFailureFixture({ failureClass: 'provider', failureCode: 'x', toolName: null, stage: 's', tokens: null, transcript: 'raw' }), /field_rejected/);
  assert.throws(() => buildFailureFixture({ failureClass: 'provider', failureCode: 'holdout check', toolName: null, stage: 's', tokens: null }), /holdout_forbidden/);
  assert.throws(() => buildFailureFixture({ failureClass: 'client', failureCode: 'x', toolName: null, stage: 's', tokens: null }), /field_rejected/);

  const baseline: VersionFingerprint = { providerId: 'openai', modelId: 'gpt-x', framework: { langchain: '1.0.0' }, harnessImplementation: hex('impl-1') };
  const next: VersionFingerprint = { ...baseline, framework: { langchain: '1.1.0' } };
  assert.equal(evaluateUpgradeGate({ recorded: null, current: baseline, retest: null }).allowed, true);
  assert.equal(evaluateUpgradeGate({ recorded: baseline, current: baseline, retest: null }).reason, 'versions_unchanged');
  assert.equal(evaluateUpgradeGate({ recorded: baseline, current: next, retest: null }).reason, 'upgrade_retest_required');
  assert.equal(evaluateUpgradeGate({ recorded: baseline, current: next,
    retest: { passed: true, receiptHash: hex('receipt'), versions: baseline } }).reason, 'upgrade_retest_mismatch');
  assert.equal(evaluateUpgradeGate({ recorded: baseline, current: next,
    retest: { passed: false, receiptHash: hex('receipt'), versions: next } }).reason, 'upgrade_retest_failed');
  assert.equal(evaluateUpgradeGate({ recorded: baseline, current: next,
    retest: { passed: true, receiptHash: hex('receipt'), versions: next } }).allowed, true);
  assert.equal(evaluateUpgradeGate({ recorded: baseline, current: next,
    retest: { passed: true, receiptHash: hex('receipt'), versions: next } }, { knownReceipts: new Set([hex('other')]) }).reason,
  'upgrade_retest_receipt_unknown');

  const db = new Database(join(directory, 'retention.sqlite'));
  applyMemoryDatabaseSchema(db);
  try {
    const store = new ExperienceRecordStore(db, { now: () => '2026-10-21T10:00:00.000Z' });
    store.record(experienceInput({ id: 'delete-me' }));
    store.record(experienceInput({ id: 'keep-me' }));
    assert.equal(store.eventCount(), 2);
    const deleted = store.deleteById('delete-me');
    assert.equal(deleted.records, 1);
    assert.equal(deleted.events, 1);
    assert.equal(store.latest('delete-me'), null);
    assert.deepEqual(store.list().map(entry => entry.id), ['keep-me']);
    const purged = store.deleteAll();
    assert.ok(purged.records >= 1);
    assert.equal(store.list().length, 0);
    assert.equal(store.eventCount(), 0);
    return { fixture, gate: 'enforced', purge: purged };
  } finally {
    db.close();
  }
}

function releaseSurface() {
  return baseSurface();
}

function validReview() {
  return {
    datasetHash: hex('holdout-dataset'),
    comparison: 'paired-holdout' as const,
    intervalMethod: 'cluster-bootstrap-percentile' as const,
    ciLow: 0.25,
    ciHigh: 0.6,
    scenarios: 45,
    clusters: 9,
    verifierFailures: 0
  };
}

function verifyHarnessRelease(directory: string): Record<string, unknown> {
  const secret = hex('pilot-release-secret');
  const baselinePermissions = ['workspace.read', 'provider.model'];
  const store = new HarnessReleaseStore({ directory, secret, baselinePermissions, now: () => '2026-10-21T11:00:00.000Z' });
  const input = {
    surface: releaseSurface(),
    review: validReview(),
    permissions: ['workspace.read', 'provider.model'],
    basePermissions: ['workspace.read', 'provider.model'],
    harness: { executionRevision: 'exec-rev-1', improvementRevision: 'imp-rev-1' }
  };
  const first = store.create(input);
  assert.equal(store.verify(first.releaseId).releaseId, first.releaseId);
  assert.deepEqual(store.list(), [first.releaseId]);
  // Same inputs produce the same signed package under a fixed clock.
  const repeat = new HarnessReleaseStore({ directory: join(directory, 'repeat'), secret, baselinePermissions, now: () => '2026-10-21T11:00:00.000Z' }).create(input);
  assert.equal(repeat.releaseId, first.releaseId);
  assert.equal(repeat.bodyHash, first.bodyHash);

  const rejected: Record<string, string> = {};
  const expectReject = (name: string, value: unknown, pattern: RegExp): void => {
    assert.throws(() => store.create(value), pattern);
    rejected[name] = 'rejected';
  };
  expectReject('expandedPermission', { ...input, permissions: [...input.permissions, 'workspace.write'] }, /permissions_expanded/);
  expectReject('widenedBaseline', { ...input, basePermissions: [...input.basePermissions, 'workspace.write'] }, /baseline_mismatch/);
  expectReject('badInterval', { ...input, review: { ...input.review, ciHigh: 0.1 } }, /interval_invalid/);
  expectReject('verifierFailures', { ...input, review: { ...input.review, verifierFailures: 1 } }, /verifier_failures/);
  expectReject('noGain', { ...input, review: { ...input.review, ciLow: 0 } }, /no_holdout_gain/);
  expectReject('revisionMismatch', { ...input, surface: { ...input.surface, revision: 'rev-forged' } }, /revision_mismatch/);
  expectReject('conflatedHarness', { ...input, harness: { executionRevision: 'same', improvementRevision: 'same' } }, /harness_revision_conflated/);

  // Tampering with the stored package breaks integrity even before the signature is checked.
  const stored = readFileSync(join(directory, `${first.releaseId}.json`), 'utf8');
  let tampered: Record<string, unknown>;
  try {
    tampered = JSON.parse(stored) as Record<string, unknown>;
  } catch {
    throw new Error('release_fixture_corrupt');
  }
  (tampered.review as Record<string, unknown>).ciLow = 0.9;
  writeFileSync(join(directory, 'rel-0000000000000000.json'), JSON.stringify(tampered));
  assert.throws(() => store.verify('rel-0000000000000000'), /integrity/);

  // A forged body with a stale signature must fail the signature check itself.
  const wrongSecret = new HarnessReleaseStore({ directory, secret: hex('other-secret'), baselinePermissions, now: () => '2026-10-21T11:00:00.000Z' });
  assert.throws(() => wrongSecret.verify(first.releaseId), /release_signature/);

  // The stored review report is re-read on verify; editing it alone is detected.
  const reviewPath = join(directory, `review-${first.releaseId}.json`);
  const reviewBytes = readFileSync(reviewPath, 'utf8');
  let review: Record<string, unknown>;
  try {
    review = JSON.parse(reviewBytes) as Record<string, unknown>;
  } catch {
    throw new Error('release_review_fixture_corrupt');
  }
  review.ciLow = 0.4;
  writeFileSync(reviewPath, JSON.stringify(review));
  assert.throws(() => store.verify(first.releaseId), /review_mismatch/);
  writeFileSync(reviewPath, reviewBytes);
  assert.equal(store.verify(first.releaseId).releaseId, first.releaseId);

  store.activate(first.releaseId);
  const pinned = store.pinForRun('run-old');
  assert.equal(pinned, first.releaseId);

  const improved = materialiseSurface(baseSurface(), {
    id: 'p6-release',
    rationale: 'fixture release candidate',
    edits: [{ path: 'components.guidance.evidence', value: 'assert-numbers' }]
  }).surface;
  const second = store.create({ ...input, surface: improved });
  store.activate(second.releaseId);
  assert.equal(store.active().activeReleaseId, second.releaseId);
  // Old runs keep the release they pinned, even while a newer release is active.
  assert.equal(store.resolveForRun('run-old').releaseId, first.releaseId);
  const rolledBack = store.rollback();
  assert.equal(rolledBack.activeReleaseId, first.releaseId);
  assert.throws(() => store.resolveForRun('run-unpinned'), /run_unpinned/);

  writeFileSync(join(directory, 'release-report.json'), JSON.stringify({ active: store.active(), releases: store.list() }, null, 2));
  return {
    releaseId: first.releaseId,
    rejected,
    integrityTamperRejected: true,
    signatureTamperRejected: true,
    reviewTamperRejected: true,
    pinnedOldRun: store.resolveForRun('run-old').releaseId,
    rollbackTarget: rolledBack.activeReleaseId
  };
}

function verifyPilotGate(directory: string): Record<string, unknown> {
  const store = new PilotStateStore({ directory, now: () => '2026-10-21T12:00:00.000Z' });
  // Default normal requests never start a candidate search.
  assert.equal(defaultPilotSettings.enabled, false);
  assert.equal(store.read().enabled, false);
  assert.equal(store.decide({ taskId: 'task-1', grants: ['workspace.read'], effectClasses: [] }).start, false);
  assert.throws(() => store.enable({ profile: 'read-only', rolloutPercent: 100, extraBudgetMicrousd: 500, budgetAcknowledged: false }), /budget_not_acknowledged/);

  const enabled = store.enable({ profile: 'read-only', rolloutPercent: 100, extraBudgetMicrousd: 500, budgetAcknowledged: true });
  assert.equal(enabled.enabled, true);
  const decision = store.decide({ taskId: 'task-1', grants: ['workspace.read', 'provider.model'], effectClasses: [] });
  assert.equal(decision.start, true);
  if (decision.start) assert.match(decision.disclosure, /500 microusd/);
  // A task outside the deterministic bucket never starts, and the bucket is stable.
  store.enable({ profile: 'read-only', rolloutPercent: 1, extraBudgetMicrousd: 500, budgetAcknowledged: true });
  const excluded = store.decide({ taskId: 'task-2', grants: ['workspace.read'], effectClasses: [] });
  assert.equal(excluded.start, false);
  assert.equal(store.decide({ taskId: 'task-2', grants: ['workspace.read'], effectClasses: [] }).start, false);

  store.enable({ profile: 'read-only', rolloutPercent: 100, extraBudgetMicrousd: 500, budgetAcknowledged: true });
  assert.equal(store.decide({ taskId: 'task-1', grants: ['workspace.write'], effectClasses: [] }).start, false);
  assert.equal(store.decide({ taskId: 'task-1', grants: ['workspace.read'], effectClasses: ['host_execution'] }).start, false);

  store.enable({ profile: 'low-side-effect', rolloutPercent: 100, extraBudgetMicrousd: 500, budgetAcknowledged: true });
  assert.equal(store.decide({ taskId: 'task-1', grants: ['workspace.write'], effectClasses: ['workspace_mutation'] }).start, true);
  assert.equal(store.decide({ taskId: 'task-1', grants: ['workspace.write'], effectClasses: ['external_call'] }).start, false);
  assert.equal(store.decide({ taskId: 'task-1', grants: ['network.read'], effectClasses: [] }).start, false);

  const spent = store.recordSpend(500);
  assert.equal(spent.circuitOpen, true);
  assert.equal(store.decide({ taskId: 'task-1', grants: ['workspace.write'], effectClasses: [] }).start, false);

  store.enable({ profile: 'read-only', rolloutPercent: 100, extraBudgetMicrousd: 500, budgetAcknowledged: true });
  store.recordFailure();
  store.recordFailure();
  assert.equal(store.read().circuitOpen, true);
  assert.equal(store.decide({ taskId: 'task-1', grants: ['workspace.read'], effectClasses: [] }).reason, 'pilot_circuit_open');

  const rolledBack = store.rollback();
  assert.equal(rolledBack.enabled, false);
  assert.equal(rolledBack.circuitOpen, true);
  assert.equal(store.decide({ taskId: 'task-1', grants: ['workspace.read'], effectClasses: [] }).reason, 'pilot_not_opted_in');
  writeFileSync(join(directory, 'pilot-state.json'), JSON.stringify(store.read(), null, 2));
  // Observed reasons rather than literals, so a regression changes the evidence.
  const deniedReasons = [
    'pilot_profile_denied:workspace.write',
    'pilot_effect_denied:host_execution',
    'pilot_bucket_excluded',
    // Reaching the budget also opens the breaker, which wins over the budget reason.
    'pilot_circuit_open',
    'pilot_circuit_open'
  ];
  const observed: string[] = [];
  const fresh = new PilotStateStore({ directory: join(directory, 'observed'), now: () => '2026-10-21T12:00:00.000Z' });
  fresh.enable({ profile: 'read-only', rolloutPercent: 100, extraBudgetMicrousd: 10, budgetAcknowledged: true });
  observed.push(String((fresh.decide({ taskId: 'o1', grants: ['workspace.write'], effectClasses: [] }) as { reason: string }).reason));
  observed.push(String((fresh.decide({ taskId: 'o2', grants: ['workspace.read'], effectClasses: ['host_execution'] }) as { reason: string }).reason));
  fresh.enable({ profile: 'read-only', rolloutPercent: 1, extraBudgetMicrousd: 10, budgetAcknowledged: true });
  observed.push(String((fresh.decide({ taskId: 'o3', grants: ['workspace.read'], effectClasses: [] }) as { reason: string }).reason));
  fresh.enable({ profile: 'read-only', rolloutPercent: 100, extraBudgetMicrousd: 10, budgetAcknowledged: true });
  fresh.recordSpend(10);
  observed.push(String((fresh.decide({ taskId: 'o4', grants: ['workspace.read'], effectClasses: [] }) as { reason: string }).reason));
  fresh.enable({ profile: 'read-only', rolloutPercent: 100, extraBudgetMicrousd: 10, budgetAcknowledged: true });
  fresh.recordFailure();
  fresh.recordFailure();
  observed.push(String((fresh.decide({ taskId: 'o5', grants: ['workspace.read'], effectClasses: [] }) as { reason: string }).reason));
  assert.deepEqual(observed, deniedReasons);
  const budgetOnly = evaluatePilotDecision({ ...defaultPilotSettings, enabled: true, rolloutPercent: 100,
    extraBudgetMicrousd: 10, budgetAcknowledgedAt: '2026-10-21T00:00:00.000Z', spentMicrousd: 10 },
  { taskId: 'o6', grants: ['workspace.read'], effectClasses: [] });
  assert.equal(budgetOnly.start, false);
  assert.equal((budgetOnly as { reason: string }).reason, 'pilot_budget_exhausted');
  return {
    defaultOff: store.read().enabled === false,
    denied: observed,
    rollback: rolledBack,
    deterministicBucket: true
  };
}

export function verifyP6(name: string, directory: string): Record<string, unknown> {
  const cases: Record<string, (target: string) => Record<string, unknown>> = {
    'experience-records': verifyExperienceRecords,
    'experience-transfer': verifyExperienceTransfer,
    'experience-retention': verifyExperienceRetention,
    'harness-release': verifyHarnessRelease,
    'pilot-gate': verifyPilotGate
  };
  const run = cases[name];
  if (run === undefined) throw new Error(`unsupported_p6_case:${name}`);
  return run(directory);
}
