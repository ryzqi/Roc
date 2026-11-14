import { closeSync, existsSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { EvaluationError, fail, fileInventory, hash, readJson, sourceIdentity } from './common.mjs';
import { createRunPlan, durableJson, inspectTrialSeal, loadRunPlan, readEvents, sealTrial, tracePointers, TrialLifecycle, trialStates } from './lifecycle.mjs';
import { openBudgetLedger, validateBudgetLedger } from './budget-ledger.mjs';

export function concurrency(value = 2) {
  const count = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isInteger(count) || count < 1 || count > 8) fail('policy', 'invalid_trial_concurrency');
  return count;
}
export function executionPolicy(config, count = 2) {
  return { schemaVersion: 1, maxConcurrentTrials: concurrency(count),
    recovery: 'verify-existing-before-dispatch-v1', budget: config.budget ?? {},
    taskTimeoutMs: config.taskTimeoutMs ?? 300000 };
}
export function failure(error, signal) {
  const cause = signal?.aborted ? signal.reason : error;
  return { failureClass: cause?.failureClass ?? error?.failureClass ?? (signal?.aborted ? 'operator' : 'infrastructure'),
    reason: String(cause?.message ?? error?.message ?? error).slice(0, 320) };
}
export function cancellation(startedAtMs = Date.now()) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new EvaluationError('operator', 'run_cancelled'));
  let timer;
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  return {
    signal: controller.signal,
    configure(policy) {
      const limit = policy.budget.maxRunDurationMs;
      if (limit === undefined) return;
      const remaining = limit - Math.max(0, Date.now() - startedAtMs);
      if (remaining <= 0) fail('policy', 'budget_max_run_duration');
      timer = setTimeout(() => controller.abort(new EvaluationError('policy', 'budget_max_run_duration')), remaining);
    },
    close() {
      clearTimeout(timer); process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    }
  };
}
export function inspectResumable(path) {
  const root = realpathSync(path), stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('state', 'resume_run_not_regular_directory');
  if (existsSync(join(root, 'seal.json'))) fail('policy', 'resume_requires_unsealed_run');
  const manifest = regularJson(join(root, 'manifest.json')), events = readEvents(join(root, 'events.jsonl'));
  if (events.some(event => event.type === 'run_finished')
    || ['trials.json', 'summary.json', 'report.md'].some(name => existsSync(join(root, name)))) {
    fail('state', 'resume_finalized_run_requires_reconciliation');
  }
  if (sourceIdentity().sourceHash !== manifest.source?.sourceHash) fail('state', 'resume_source_changed');
  const plan = loadRunPlan(root, manifest, events);
  new TrialLifecycle(plan, () => fail('state', 'resume_validation_is_readonly'), events);
  if (manifest.executionPolicy?.schemaVersion !== 1
    || manifest.executionPolicy.maxConcurrentTrials !== plan.maxConcurrentTrials
    || hash(manifest.executionPolicy.budget) !== hash(manifest.provider?.budget ?? manifest.executionPolicy.budget)) {
    fail('state', 'resume_budget_policy_changed');
  }
  validateBudgetLedger(root, manifest.executionPolicy.budget, events);
  const owners = events.filter(event => ['run_owner', 'run_resumed'].includes(event.type));
  if (!owners.length || owners.at(-1).ownerHash !== hash(regularJson(join(root, 'execution-owner.json')))) fail('state', 'resume_owner_changed');
  assertOwnerGone(root);
  return { root, manifest, events, plan };
}
function regularJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('state', 'resume_artifact_not_regular');
  return readJson(path);
}
function assertOwnerGone(root) {
  const owner = regularJson(join(root, 'execution-owner.json'));
  if (owner.schemaVersion !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || typeof owner.claimId !== 'string' || !/^[a-f0-9-]{36}$/u.test(owner.claimId)) fail('state', 'resume_owner_invalid');
  try { process.kill(owner.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return; throw error; }
  fail('state', 'resume_owner_still_running');
}
function claimOwner(root, append, previousEvents) {
  const path = join(root, 'execution-owner.json');
  const owner = { schemaVersion: 1, pid: process.pid, claimedAtMs: Date.now(), claimId: randomUUID() };
  if (!previousEvents) { durableJson(path, owner); append({ type: 'run_owner', ownerHash: hash(owner) }); return; }
  const previousOwner = regularJson(path), previousOwnerHash = hash(previousOwner);
  const lastOwner = previousEvents.findLast(event => ['run_owner', 'run_resumed'].includes(event.type));
  if (lastOwner?.ownerHash !== previousOwnerHash
    || hash(readEvents(join(root, 'events.jsonl'))) !== hash(previousEvents)) fail('state', 'resume_changed_before_claim');
  assertOwnerGone(root);
  const claim = join(root, `resume-claim-${previousOwner.claimId}.json`);
  // Every predecessor admits exactly one resumer. Preserve the claim as evidence
  // even if that resumer crashes before its new owner event reaches the journal.
  try { durableJson(claim, { schemaVersion: 1, previousOwnerHash, ownerHash: hash(owner), owner }); }
  catch (error) { if (error.code === 'EEXIST') fail('state', 'resume_owner_already_claimed'); throw error; }
  if (hash(regularJson(path)) !== previousOwnerHash
    || hash(readEvents(join(root, 'events.jsonl'))) !== hash(previousEvents)) fail('state', 'resume_changed_during_claim');
  const temporary = join(root, `.execution-owner-${owner.claimId}.json`);
  durableJson(temporary, owner);
  try {
    renameSync(temporary, path);
    const parent = openSync(root, 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  append({ type: 'run_resumed', previousOwnerHash, ownerHash: hash(owner) });
}
export function openExecution(root, manifest, journal, previousEvents = null) {
  const plan = previousEvents ? loadRunPlan(root, manifest, previousEvents)
    : createRunPlan(root, manifest, manifest.executionPolicy.maxConcurrentTrials);
  const byId = new Map(plan.trials.map(trial => [trial.trialId, trial]));
  const append = event => {
    const trial = byId.get(event.trialId);
    if (event.trialId && !trial) fail('state', 'event_trial_not_in_plan');
    return journal.append({ ...event, ...(trial ?? {}) });
  };
  if (!previousEvents) append({ type: 'run_plan', planHash: hash(plan) });
  claimOwner(root, append, previousEvents);
  const lifecycle = new TrialLifecycle(plan, append, previousEvents ?? []);
  lifecycle.initialize(plan.trials);
  // Budget events have their own exact, durable payload contract. Their trialId
  // binds back to the plan; arbitrary event enrichment would break recovery.
  const budget = openBudgetLedger(root, manifest.executionPolicy.budget, event => journal.append(event),
    { previousEvents: previousEvents ? readEvents(join(root, 'events.jsonl')) : null });
  return { root, plan, lifecycle, budget, append, policy: manifest.executionPolicy };
}
export function advance(lifecycle, trial, target, detail = {}) {
  const current = trialStates.indexOf(lifecycle.state(trial.trialId)), end = trialStates.indexOf(target);
  if (current > end) fail('state', 'trial_state_would_rewind');
  for (let index = current + 1; index <= end; index++) lifecycle.transition(trial, trialStates[index],
    { recovered: true, ...(index === end ? detail : {}) });
}
export async function withinTrial(execution, trial, signal, execute) {
  const { lifecycle, budget } = execution;
  if (lifecycle.state(trial.trialId) === 'pending') lifecycle.transition(trial, 'admitted', { startedAtMs: Date.now() });
  const admission = lifecycle.events(trial.trialId).find(event => event.type === 'trial_state' && event.to === 'admitted');
  const startedAtMs = admission?.startedAtMs;
  if (!Number.isSafeInteger(startedAtMs)) fail('state', 'trial_admission_time_missing');
  const duration = Math.min(execution.policy.taskTimeoutMs, execution.policy.budget.maxTaskDurationMs ?? Infinity);
  const remaining = duration - Math.max(0, Date.now() - startedAtMs);
  budget.checkRunDuration({ trialId: trial.trialId });
  if (remaining <= 0) fail('policy', 'budget_max_task_duration');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new EvaluationError('policy', 'budget_max_task_duration')), remaining);
  const taskSignal = AbortSignal.any([signal, controller.signal]);
  try {
    taskSignal.throwIfAborted();
    const result = await execute(taskSignal, startedAtMs);
    taskSignal.throwIfAborted();
    return result;
  } catch (error) { if (taskSignal.aborted) throw taskSignal.reason; throw error; }
  finally { clearTimeout(timer); }
}
export function storeGrade(root, execution, trial, grade, startedAtMs) {
  const directory = join(root, trial.trialId);
  for (const key of ['trialId', 'taskId', 'clusterId', 'repeat', 'traceId']) {
    if (grade[key] !== undefined && grade[key] !== trial[key]) fail('state', 'grade_trial_identity_invalid');
  }
  let result = { ...grade, ...trial, latencyMs: Date.now() - startedAtMs,
    usage: execution.budget.snapshot({ trialId: trial.trialId }),
    traces: { traceId: trial.traceId, artifacts: tracePointers(root, directory) } };
  const path = join(directory, 'grade.json');
  if (existsSync(path)) {
    // A crash can leave a complete grade before its graded journal event. Reuse
    // it only after independently regrading the verified raw result and matching
    // its host-accounted usage; a saved file alone never authorizes replay.
    if (execution.lifecycle.state(trial.trialId) !== 'verified') fail('state', 'resume_uncommitted_grade_state_invalid');
    const saved = regularJson(path);
    const { latencyMs, usage, traces, ...scored } = saved;
    const { latencyMs: _latency, usage: currentUsage, traces: _traces, ...expected } = result;
    const comparableUsage = value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const { capturedAtMs: _captured, nextRequestNumber: _number, ...accounting } = value;
      return accounting;
    };
    const inventory = new Map(fileInventory(directory).map(file => [join(trial.trialId, file.path), file.sha256]));
    if (hash(scored) !== hash(expected) || !Number.isSafeInteger(latencyMs) || latencyMs < 0
      || latencyMs > Math.max(0, Date.now() - startedAtMs)
      || hash(comparableUsage(usage)) !== hash(comparableUsage(currentUsage))
      || traces?.traceId !== trial.traceId || !Array.isArray(traces.artifacts)
      || traces.artifacts.some(pointer => inventory.get(pointer.artifact) !== pointer.sha256)) {
      fail('state', 'resume_uncommitted_grade_changed');
    }
    result = saved;
  } else durableJson(path, result);
  const trialEvidenceHash = sealTrial(directory);
  execution.lifecycle.transition(trial, 'graded', { gradeHash: hash(result), trialEvidenceHash });
  execution.lifecycle.record(trial, { type: 'trial_finished', status: result.status, gradeHash: hash(result), trialEvidenceHash });
  return result;
}
export function readGrade(root, execution, trial) {
  const directory = join(root, trial.trialId), events = execution.lifecycle.events(trial.trialId);
  const graded = events.find(event => event.type === 'trial_state' && event.to === 'graded');
  if (!graded) return null;
  inspectTrialSeal(directory, 'trial-evidence.json', graded.trialEvidenceHash);
  const result = readJson(join(directory, 'grade.json'));
  if (hash(result) !== graded.gradeHash || result.trialId !== trial.trialId
    || result.taskId !== trial.taskId || result.clusterId !== trial.clusterId
    || result.repeat !== trial.repeat || result.traceId !== trial.traceId) fail('state', 'resume_grade_changed');
  return result;
}
export function recordFailure(root, execution, trial, error, signal, startedAtMs = Date.now()) {
  const grade = { ...trial, status: 'invalid', metrics: null, ...failure(error, signal),
    latencyMs: Math.max(0, Date.now() - startedAtMs), usage: execution.budget.snapshot({ trialId: trial.trialId }),
    traces: { traceId: trial.traceId } };
  durableJson(join(root, trial.trialId, 'grade.json'), grade);
  execution.lifecycle.record(trial, { type: 'trial_failed', ...grade });
  return grade;
}
export function verifiedSeal(directory, lifecycle, trial) {
  const evidenceSealHash = sealTrial(directory, 'verified-evidence.json');
  if (lifecycle.state(trial.trialId) === 'completed') lifecycle.transition(trial, 'verified', { evidenceSealHash });
  else advance(lifecycle, trial, 'verified', { evidenceSealHash });
  return evidenceSealHash;
}
export function validateVerifiedSeal(root, lifecycle, trial) {
  const verified = lifecycle.events(trial.trialId).find(event => event.type === 'trial_state' && event.to === 'verified');
  inspectTrialSeal(join(root, trial.trialId), 'verified-evidence.json', verified?.evidenceSealHash);
}
export function applicationArtifact(root, manifest) {
  const artifact = regularJson(join(root, 'worker.json'));
  if (artifact.sha256 !== manifest.workerHash || hash(artifact.manifests[manifest.suite]) !== hash(manifest.toolManifest)) {
    fail('state', 'resume_worker_manifest_changed');
  }
  return artifact;
}
export function runStartedAt(events) {
  const started = events.find(event => event.type === 'run_started'), at = started?.startedAtMs ?? Date.parse(started?.at);
  if (!Number.isSafeInteger(at) || at < 0) fail('state', 'run_start_time_invalid');
  return at;
}
