import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { PilotStateStore, defaultPilotSettings, evaluatePilotDecision, pilotAllowance } from '../../src/main/services/deep-agent/pilot-gate';
import { PilotRunCoordinator } from '../../src/main/services/deep-agent/pilot-run';
import { RunBudgetLedger } from '../../src/main/services/deep-agent/run-budget-ledger';
import { toRunFailure } from '../../src/main/services/deep-agent/error-mapping';
import { AgentSessionRepository } from '../../src/main/plugins/agent/session-repository';
import { AgentRunEventLog } from '../../src/main/plugins/agent/run-event-log';
import { AgentPluginRuntime } from '../../src/main/plugins/agent/runtime';
import { EventBus } from '../../src/main/kernel/event-bus';
import {
  derivePilotRequest,
  restrictManifestForPilot
} from '../../src/main/plugins/agent/pilot-profile';
import { createRunCapabilityManifestHash, isRunCapabilityManifestIntegrityValid } from '../../src/main/plugins/agent/run-capability-manifest';
import type {
  RunCapabilityManifestToolV1,
  RunCapabilityManifestV1,
  RunExecutionSnapshot
} from '../../src/shared/schemas/agent';
import { applyAgentDatabaseSchema } from '../../src/main/infrastructure/database-schemas';
import { baseSurface } from './optimizer/optimizer';
import { executeScenario } from './optimizer/eval-adapter';
import { buildDataset, readSplit, type PairedObservation } from './optimizer/dataset';
import { materialiseSurface } from './optimizer/surface';
import { transferReport, transferStrata, type TransferStratum } from './optimizer/transfer';

type RunBudgetLedgerLimits = RunExecutionSnapshot['budget'];

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


/**
 * P6-04 product path: the gate is decided from the frozen manifest, the grant lands in the durable
 * budget ledger, and the breaker reacts to exhaustion instead of the run silently retrying.
 *
 * Fixtures use a hand-written manifest so the grant/effect mapping is asserted directly, and a real
 * `agent` SQLite database with the shipped migrations so the ledger columns are the production ones.
 */
function verifyPilotProductPath(directory: string): Record<string, unknown> {
  const tool = (input: {
    identity: string;
    name: string;
    scope: RunCapabilityManifestToolV1['resourceScope'];
    effectClass: RunCapabilityManifestToolV1['effectClass'];
  }): RunCapabilityManifestToolV1 => ({
    canonicalIdentity: input.identity,
    modelVisibleName: input.name,
    provenance: { kind: 'builtin', source: 'roc' },
    executionScopes: ['main'],
    riskLevel: 'low',
    effectClass: input.effectClass,
    approvalPolicy: { kind: 'none' },
    idempotencyStrategy: input.effectClass === 'none' ? 'none' : 'tool_call',
    reconcileStrategy: 'none',
    resourceScope: input.scope
  });
  const manifestOf = (tools: RunCapabilityManifestToolV1[]): RunCapabilityManifestV1 => {
    const withoutHash = {
      schemaVersion: 1 as const,
      requestedCapabilities: { mcpServers: [], skills: [] },
      resolvedCapabilities: { mcpServers: [], skills: [] },
      skippedCapabilities: [],
      tools,
      skills: [],
      mcpServers: [],
      untrustedContextPolicy: 'external_content_reference_only' as const
    };
    return { ...withoutHash, manifestHash: createRunCapabilityManifestHash(withoutHash) };
  };

  const full = manifestOf([
    tool({ identity: 'builtin:read_file', name: 'read_file', scope: 'workspace', effectClass: 'none' }),
    tool({ identity: 'builtin:delete_file', name: 'delete_file', scope: 'workspace', effectClass: 'workspace_mutation' }),
    tool({ identity: 'builtin:run_shell_command', name: 'run_shell_command', scope: 'workspace', effectClass: 'host_execution' }),
    tool({ identity: 'builtin:web_read', name: 'web_read', scope: 'network', effectClass: 'network_read' }),
    tool({ identity: 'research:research_overview', name: 'research_overview', scope: 'app', effectClass: 'none' })
  ]);
  assert.equal(isRunCapabilityManifestIntegrityValid(full), true);

  // The request is derived from the manifest: the model call itself plus every bound tool's grant.
  const derived = derivePilotRequest(full, 'task-hash');
  assert.deepEqual(derived.grants, ['network.read', 'provider.model', 'research.read', 'workspace.read', 'workspace.write']);
  assert.deepEqual(derived.effectClasses, ['host_execution', 'network_read', 'workspace_mutation']);

  const readOnly = restrictManifestForPilot(full, 'read-only');
  assert.deepEqual(readOnly.removedTools, ['delete_file', 'run_shell_command', 'web_read']);
  assert.notEqual(readOnly.manifest.manifestHash, full.manifestHash);
  assert.equal(isRunCapabilityManifestIntegrityValid(readOnly.manifest), true);
  // A restricted manifest no longer requests anything its profile denies, so the decision is coherent.
  const revisited = derivePilotRequest(readOnly.manifest, 'task-hash');
  assert.deepEqual(revisited.grants, ['provider.model', 'research.read', 'workspace.read']);
  assert.deepEqual(revisited.effectClasses, []);

  const lowSideEffect = restrictManifestForPilot(full, 'low-side-effect');
  assert.deepEqual(lowSideEffect.removedTools, ['run_shell_command', 'web_read']);
  assert.equal(isRunCapabilityManifestIntegrityValid(lowSideEffect.manifest), true);

  // Nothing to remove keeps the exact object, so a non-pilot run's previewed hash cannot drift.
  const readOnlyManifest = readOnly.manifest;
  const unchanged = restrictManifestForPilot(readOnlyManifest, 'read-only');
  assert.equal(unchanged.manifest, readOnlyManifest);
  assert.deepEqual(unchanged.removedTools, []);

  const db = new Database(join(directory, 'pilot-agent.sqlite'));
  applyAgentDatabaseSchema(db);
  try {
    const now = new Date().toISOString();
    const runIds = ['run-ordinary', 'run-model', 'run-tool', 'run-token', 'run-done'] as const;
    for (const runId of runIds) {
      const threadId = `thread-${runId}`;
      db.prepare(`INSERT INTO agent_threads (id,kind,title,goal,status,created_at,updated_at)
        VALUES (?, 'chat', 'pilot fixture', 'pilot fixture', 'active', ?, ?)`).run(threadId, now, now);
      db.prepare(`INSERT INTO agent_runs (id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json)
        VALUES (?, ?, 1, 'pilot fixture', 'running', ?, '{}')`).run(runId, threadId, now);
    }
    const ledger = new RunBudgetLedger(db);
    const limits = (overrides: Partial<RunBudgetLedgerLimits> = {}): RunBudgetLedgerLimits => ({
      contextWindowTokens: 1000, maxTotalTokens: null, maxCostUsd: null, maxModelCalls: 1, maxToolCalls: 1,
      maxChildTasks: 1, maxConcurrentChildTasks: 1, maxConcurrentModelCalls: 4, maxConcurrentToolCalls: 4,
      deadlineAt: null, ...overrides
    });
    const reserve = (runId: string, id: string, kind: 'model' | 'tool', tokens: number, budget = limits()): void => {
      ledger.reserve(runId, budget, { id, kind, tokens, inputHash: hex(`${runId}:${id}`), envelope: { id } });
    };

    // Ordinary request: no pilot row, and the base limit throws exactly as before.
    assert.equal(ledger.latestPilotRun(), null);
    reserve('run-ordinary', 'model-1', 'model', 100);
    assert.throws(() => reserve('run-ordinary', 'model-2', 'model', 100), /run_model_call_budget_exhausted/);
    reserve('run-ordinary', 'tool-1', 'tool', 0);
    assert.throws(() => reserve('run-ordinary', 'tool-2', 'tool', 0), /run_tool_call_budget_exhausted/);
    assert.equal(ledger.readPilotRun('run-ordinary'), null);

    const store = new PilotStateStore({ directory: join(directory, 'pilot-state'), now: () => '2026-10-21T13:00:00.000Z' });
    const coordinator = new PilotRunCoordinator({ store, ledger });
    // Default-off: the gate refuses, nothing is attached, and the status says why.
    assert.equal(coordinator.plan(derived).start, false);
    assert.equal(coordinator.status().lastRun, null);
    // `costState` is a schema literal; the substantive claim is that no USD figure exists anywhere.
    assert.equal(coordinator.status().costState, 'unknown_without_price_table');
    assert.equal(coordinator.status().settings.spentMicrousd, 0);

    // The unrestricted manifest is refused: deciding on it would refuse almost every real run.
    store.enable({ profile: 'low-side-effect', rolloutPercent: 100, extraBudgetMicrousd: 500, budgetAcknowledged: true });
    const unrestricted = coordinator.plan(derived);
    assert.equal(unrestricted.start, false);
    assert.equal((unrestricted as { reason: string }).reason, 'pilot_profile_denied:network.read');

    // The product path narrows the manifest to the profile first, then decides on that surface.
    const lowSideEffectStart = coordinator.plan(derivePilotRequest(lowSideEffect.manifest, 'task-hash'));
    const started = lowSideEffectStart;
    assert.equal(started.start, true);
    if (!started.start) throw new Error('pilot_fixture_not_started');
    assert.equal(started.reason, 'pilot_started');
    assert.equal(started.costState, 'unknown_without_price_table');
    // The decision carries the documented constant; the ledger row below is what governs behaviour.
    assert.deepEqual(started.allowance, pilotAllowance);

    // Model allowance: 1 base call + the granted extra calls, then the breaker error.
    coordinator.attach({ runId: 'run-model', taskId: 'task-hash', decision: started });
    reserve('run-model', 'model-1', 'model', 100);
    reserve('run-model', 'model-2', 'model', 100);
    reserve('run-model', 'model-3', 'model', 100);
    let exhaustionError: unknown = null;
    try {
      reserve('run-model', 'model-4', 'model', 100);
    } catch (error) {
      exhaustionError = error;
    }
    assert.match(String(exhaustionError), /run_pilot_allowance_exhausted/);
    // The run's error code is produced by the production mapper, not by this fixture. Without the
    // allowlist entry this became provider_execution_failed and the breaker never saw the reason.
    const mapped = toRunFailure(exhaustionError);
    assert.equal(mapped.code, 'run_pilot_allowance_exhausted');
    const exhausted = ledger.readPilotRun('run-model');
    assert.equal(exhausted?.state, 'exhausted');
    assert.equal(exhausted?.spent.modelCalls, pilotAllowance.modelCalls);
    assert.equal(exhausted?.extraBudgetMicrousd, 500);
    // The disclosure the user saw at opt-in time is stored with the run, not just computed.
    assert.match(exhausted?.disclosure ?? '', /500 microusd/u);
    assert.match(exhausted?.disclosure ?? '', /cost unknown without a price table/u);
    assert.match(exhausted?.disclosure ?? '', /24000 tokens/u);

    // Exhaustion trips the breaker, and the reason survives into the status the surface renders.
    coordinator.recordOutcome({ runId: 'run-model', status: 'failed', errorCode: mapped.code });
    assert.equal(store.read().circuitOpen, true);
    assert.equal(store.read().breakerReason, 'pilot_allowance_exhausted');
    const trippedStatus = coordinator.status();
    assert.equal(trippedStatus.lastRun?.runId, 'run-model');
    assert.equal(trippedStatus.lastRun?.state, 'exhausted');
    assert.equal(trippedStatus.settings.circuitOpen, true);

    // A fresh opt-in clears the breaker; tool and token allowances meter independently.
    store.enable({ profile: 'low-side-effect', rolloutPercent: 100, extraBudgetMicrousd: 500, budgetAcknowledged: true });
    const restarted = coordinator.plan(derivePilotRequest(lowSideEffect.manifest, 'task-hash'));
    assert.equal(restarted.start, true);
    if (!restarted.start) throw new Error('pilot_fixture_not_restarted');
    coordinator.attach({ runId: 'run-tool', taskId: 'task-hash', decision: restarted });
    reserve('run-tool', 'tool-1', 'tool', 0);
    reserve('run-tool', 'tool-2', 'tool', 0);
    assert.equal(ledger.readPilotRun('run-tool')?.spent.toolCalls, 1);
    coordinator.attach({ runId: 'run-token', taskId: 'task-hash-token', decision: restarted });
    // Model calls stay within the base allowance here, so only the token allowance is metered.
    const tokenLimits = limits({ maxTotalTokens: 100, maxModelCalls: 5 });
    reserve('run-token', 'model-1', 'model', 200, tokenLimits);
    reserve('run-token', 'model-2', 'model', 200, tokenLimits);
    const tokenRun = ledger.readPilotRun('run-token');
    // Both reservations are above the frozen token budget, so both consume the token allowance.
    assert.equal(tokenRun?.spent.totalTokens, 400);
    assert.equal(tokenRun?.spent.modelCalls, 0);

    // Completion closes the grant without changing the failure streak.
    coordinator.attach({ runId: 'run-done', taskId: 'task-hash-done', decision: restarted });
    coordinator.recordOutcome({ runId: 'run-done', status: 'completed', errorCode: null });
    assert.equal(ledger.readPilotRun('run-done')?.state, 'finished');
    assert.equal(store.read().failureStreak, 0);
    assert.equal(store.read().circuitOpen, false);

    // Rollback is user-facing and keeps the breaker open until a fresh opt-in.
    const rolledBack = coordinator.rollback();
    assert.equal(rolledBack.settings.enabled, false);
    assert.equal(rolledBack.settings.circuitOpen, true);
    assert.equal(rolledBack.settings.breakerReason, 'user_rollback');
    assert.equal(coordinator.plan(derivePilotRequest(lowSideEffect.manifest, 'task-hash')).start, false);

    return {
      derivedGrants: derived.grants,
      unrestrictedRefusal: (unrestricted as { reason: string }).reason,
      readOnlyRemoved: readOnly.removedTools,
      lowSideEffectRemoved: lowSideEffect.removedTools,
      ordinaryRunHasNoGrant: ledger.readPilotRun('run-ordinary') === null,
      modelAllowance: exhausted?.allowance,
      breaker: { open: trippedStatus.settings.circuitOpen, reason: trippedStatus.settings.breakerReason },
      costState: trippedStatus.costState,
      mappedExhaustionCode: mapped.code,
      rollback: rolledBack.settings
    };
  } finally {
    db.close();
  }
}


/**
 * P6-04 dispatch: drives the real `AgentPluginRuntime.startRun`, not a copy of its sequence.
 *
 * This is the case that catches the class of bug the ledger+gate fixture cannot see: the frozen
 * snapshot must carry the *narrowed* manifest (the repository rejects a preview/snapshot hash
 * mismatch), the ordinary request must stay byte-identical with no pilot row, and cancellation must
 * land in its own terminal state.
 */
async function verifyPilotDispatch(directory: string): Promise<Record<string, unknown>> {
  const tool = (input: {
    identity: string;
    name: string;
    scope: RunCapabilityManifestToolV1['resourceScope'];
    effectClass: RunCapabilityManifestToolV1['effectClass'];
  }): RunCapabilityManifestToolV1 => ({
    canonicalIdentity: input.identity,
    modelVisibleName: input.name,
    provenance: { kind: 'builtin', source: 'roc' },
    executionScopes: ['main'],
    riskLevel: 'low',
    effectClass: input.effectClass,
    approvalPolicy: { kind: 'none' },
    idempotencyStrategy: input.effectClass === 'none' ? 'none' : 'tool_call',
    reconcileStrategy: 'none',
    resourceScope: input.scope
  });
  const withoutHash = {
    schemaVersion: 1 as const,
    requestedCapabilities: { mcpServers: [], skills: [] },
    resolvedCapabilities: { mcpServers: [], skills: [] },
    skippedCapabilities: [],
    tools: [
      tool({ identity: 'builtin:read_file', name: 'read_file', scope: 'workspace', effectClass: 'none' }),
      tool({ identity: 'builtin:delete_file', name: 'delete_file', scope: 'workspace', effectClass: 'workspace_mutation' }),
      tool({ identity: 'builtin:run_shell_command', name: 'run_shell_command', scope: 'workspace', effectClass: 'host_execution' }),
      tool({ identity: 'builtin:web_read', name: 'web_read', scope: 'network', effectClass: 'network_read' })
    ],
    skills: [],
    mcpServers: [],
    untrustedContextPolicy: 'external_content_reference_only' as const
  };
  const manifest: RunCapabilityManifestV1 = {
    ...withoutHash,
    manifestHash: createRunCapabilityManifestHash(withoutHash)
  };
  const preview = {
    runnable: false as const,
    modelId: 'pilot-fixture-model',
    builtInTools: [],
    toolCards: [],
    skillCards: [],
    subagents: [],
    interruptOn: {},
    manifest,
    reason: 'pilot fixture preview'
  };

  const db = new Database(join(directory, 'dispatch.sqlite'));
  applyAgentDatabaseSchema(db);
  const workspacePath = join(directory, 'workspace');
  mkdirSync(workspacePath, { recursive: true });
  const store = new PilotStateStore({ directory: join(directory, 'pilot-state') });
  const ledger = new RunBudgetLedger(db);
  const coordinator = new PilotRunCoordinator({ store, ledger });
  const eventBus = new EventBus({ error: () => {} });
  const started: { manifestHash: string | null }[] = [];
  eventBus.subscribe('agent.run.started', (event) => {
    const payload = event.payload as { capabilityPreview?: { manifest?: { manifestHash?: string } } };
    started.push({ manifestHash: payload.capabilityPreview?.manifest?.manifestHash ?? null });
  });
  const repository = new AgentSessionRepository(db, { runEventLog: new AgentRunEventLog(db) });
  const runtime = new AgentPluginRuntime({
    repository,
    eventBus,
    modelFactory: {
      createDefaultModelHandle: async () => ({ providerId: 'pilot-fixture', modelId: 'pilot-fixture-model' }),
      createModelHandleByProviderAndModel: async () => ({ providerId: 'pilot-fixture', modelId: 'pilot-fixture-model' })
    },
    capabilityPreviewProvider: async () => preview,
    pilot: coordinator,
    workspaceProvider: async () => ({
      id: 'pilot-workspace',
      path: workspacePath,
      displayName: 'pilot workspace',
      lastOpenedAt: new Date().toISOString(),
      trustState: 'trusted'
    })
  });
  // No workspacePath: main injects it from the current workspace, and a renderer-supplied path is
  // rejected unless the run source is the workbench/background scheduler.
  const request = (input: string) => ({
    input,
    mode: 'chat' as const,
    enabledCapabilities: { mcpServers: [], skills: [] }
  });
  try {
    // Ordinary request: accepted, frozen on the untouched manifest, and no pilot row.
    const plain = await runtime.startRun(request('pilot dispatch fixture: ordinary request'));
    const plainSnapshot = repository.getRunExecutionSnapshot(plain.runId);
    assert.equal(plainSnapshot.capabilityManifest.manifestHash, manifest.manifestHash);
    assert.equal(ledger.readPilotRun(plain.runId), null);
    assert.equal(started.at(-1)?.manifestHash, manifest.manifestHash);
    await runtime.cancelRun({ runId: plain.runId });

    // Pilot request: the frozen snapshot itself carries the narrowed manifest, and the preview the
    // event advertises is the same one.
    store.enable({ profile: 'low-side-effect', rolloutPercent: 100, extraBudgetMicrousd: 500, budgetAcknowledged: true });
    const piloted = await runtime.startRun(request('pilot dispatch fixture: piloted request'));
    const restricted = restrictManifestForPilot(manifest, 'low-side-effect');
    const pilotedSnapshot = repository.getRunExecutionSnapshot(piloted.runId);
    assert.equal(pilotedSnapshot.capabilityManifest.manifestHash, restricted.manifest.manifestHash);
    assert.notEqual(pilotedSnapshot.capabilityManifest.manifestHash, manifest.manifestHash);
    const boundTools = pilotedSnapshot.capabilityManifest.tools.map((entry) => entry.modelVisibleName).sort();
    assert.deepEqual(boundTools, ['delete_file', 'read_file']);
    assert.equal(started.at(-1)?.manifestHash, restricted.manifest.manifestHash);
    const pilotRow = ledger.readPilotRun(piloted.runId);
    assert.equal(pilotRow?.profile, 'low-side-effect');
    assert.equal(pilotRow?.extraBudgetMicrousd, 500);
    assert.match(pilotRow?.disclosure ?? '', /500 microusd/u);

    // Cancelling the piloted run is its own terminal state, not "finished".
    const cancellation = await runtime.cancelRun({ runId: piloted.runId });
    if (cancellation.cancelled) {
      assert.equal(ledger.readPilotRun(piloted.runId)?.state, 'cancelled');
      assert.equal(store.read().failureStreak, 0);
    }
    return {
      ordinaryManifestUnchanged: true,
      ordinaryHasNoPilotRow: true,
      pilotedSnapshotNarrowed: true,
      boundTools,
      pilotedPreviewMatchesSnapshot: started.at(-1)?.manifestHash === restricted.manifest.manifestHash,
      pilotRunState: ledger.readPilotRun(piloted.runId)?.state ?? null
    };
  } finally {
    await runtime.shutdown();
    db.close();
  }
}

export async function verifyP6(name: string, directory: string): Promise<Record<string, unknown>> {
  const cases: Record<string, (target: string) => Record<string, unknown> | Promise<Record<string, unknown>>> = {
    'experience-records': verifyExperienceRecords,
    'experience-transfer': verifyExperienceTransfer,
    'experience-retention': verifyExperienceRetention,
    'harness-release': verifyHarnessRelease,
    'pilot-gate': verifyPilotGate,
    'pilot-product-path': verifyPilotProductPath,
    'pilot-dispatch': verifyPilotDispatch
  };
  const run = cases[name];
  if (run === undefined) throw new Error(`unsupported_p6_case:${name}`);
  return await run(directory);
}
