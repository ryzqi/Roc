import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fail, fileInventory, hash, readJson, sha256 } from './common.mjs';

export const trialStates = ['pending', 'admitted', 'dispatched', 'completed', 'verified', 'graded'];
export function durableJson(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  const parent = openSync(dirname(path), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
export function readEvents(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 * 1024) fail('state', 'run_journal_invalid');
  const text = readFileSync(path, 'utf8');
  if (text && !text.endsWith('\n')) fail('state', 'run_journal_torn_write');
  let events;
  try { events = text.trim() ? text.trimEnd().split('\n').map(JSON.parse) : []; }
  catch { fail('state', 'run_journal_invalid'); }
  if (events.some((event, index) => event.sequence !== index + 1 || typeof event.at !== 'string')) fail('state', 'run_journal_sequence_invalid');
  return events;
}
export function planTrials(manifest, runId) {
  return manifest.selection.flatMap(task => Array.from({ length: manifest.repeats }, (_, repeat) => ({
    trialId: manifest.suite === 'roc-harness' ? `trial-${task.id}-${repeat}` : `trial-${hash(task.id).slice(0, 16)}-${repeat}`,
    taskId: task.id, clusterId: task.clusterId, repeat,
    traceId: hash({ runId, taskId: task.id, repeat }).slice(0, 32)
  })));
}
export function createRunPlan(root, manifest, maxConcurrentTrials = 2) {
  if (!Number.isInteger(maxConcurrentTrials) || maxConcurrentTrials < 1 || maxConcurrentTrials > 8) fail('policy', 'invalid_trial_concurrency');
  const trials = planTrials(manifest, basename(root));
  if (trials.some(trial => !/^trial-[a-zA-Z0-9_-]+-\d+$/u.test(trial.trialId))
    || new Set(trials.map(trial => trial.trialId)).size !== trials.length) fail('state', 'invalid_trial_plan');
  const plan = { schemaVersion: 1, runId: basename(root), manifestHash: hash(manifest),
    maxConcurrentTrials, trials };
  durableJson(join(root, 'run-plan.json'), plan);
  return plan;
}
export function loadRunPlan(root, manifest, events) {
  const path = join(root, 'run-plan.json'), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('state', 'run_plan_not_regular');
  const plan = readJson(path);
  if (plan.schemaVersion !== 1 || plan.runId !== basename(root) || plan.manifestHash !== hash(manifest)
    || hash(plan.trials) !== hash(planTrials(manifest, plan.runId))
    || !Number.isInteger(plan.maxConcurrentTrials) || plan.maxConcurrentTrials < 1 || plan.maxConcurrentTrials > 8
    || plan.maxConcurrentTrials !== manifest.executionPolicy?.maxConcurrentTrials
    || events.filter(e => e.type === 'run_plan').length !== 1
    || events.find(e => e.type === 'run_plan').planHash !== hash(plan)) fail('state', 'run_plan_changed');
  return plan;
}

export class TrialLifecycle {
  #plan;
  #states = new Map();
  #record;
  #events;
  constructor(plan, record, events = []) {
    this.#plan = new Map(plan.trials.map(trial => [trial.trialId, trial]));
    if (this.#plan.size !== plan.trials.length) fail('state', 'duplicate_trial_plan');
    this.#record = record;
    this.#events = [...events];
    for (const event of events.filter(event => event.type === 'trial_state')) this.#apply(event);
  }
  #apply(event) {
    const trial = this.#plan.get(event.trialId);
    const previous = this.#states.get(event.trialId) ?? null;
    if (!trial || event.taskId !== trial.taskId || event.clusterId !== trial.clusterId
      || event.repeat !== trial.repeat || event.traceId !== trial.traceId
      || event.from !== previous || trialStates.indexOf(event.to) !== trialStates.indexOf(previous) + 1) fail('state', 'trial_lifecycle_invalid');
    this.#states.set(event.trialId, event.to);
  }
  state(trialId) { return this.#states.get(trialId) ?? null; }
  events(trialId) { return this.#events.filter(event => event.trialId === trialId); }
  record(trial, event) {
    if (!this.#plan.has(trial.trialId)) fail('state', 'trial_not_in_plan');
    const bound = { ...event, ...trial };
    this.#record(bound);
    this.#events.push(bound);
  }
  transition(trial, to, detail = {}) {
    const event = { type: 'trial_state', from: this.state(trial.trialId), to, ...detail, ...trial };
    if (trialStates.indexOf(to) !== trialStates.indexOf(event.from) + 1) fail('state', 'trial_lifecycle_invalid');
    this.#record(event);
    this.#apply(event);
    this.#events.push(event);
  }
  initialize(trials) {
    for (const trial of trials) if (this.state(trial.trialId) === null) this.transition(trial, 'pending');
  }
  recovery(trial) {
    const state = this.state(trial.trialId), events = this.events(trial.trialId);
    const dispatched = events.some(event => ['worker_started', 'model_request', 'execution_requested', 'budget_dispatched'].includes(event.type));
    if (['pending', 'admitted'].includes(state) && !dispatched) return 'never-dispatched';
    if (state === 'graded' || state === 'verified' || state === 'completed' || state === 'dispatched') return 'verify-existing';
    fail('state', 'resume_trial_requires_reconciliation');
  }
}

// A partial staging directory may be discarded only if the durable plan proves
// that neither its worker nor any external request was dispatched.
export function discardUndispatched(root, trial, lifecycle) {
  if (lifecycle.recovery(trial) !== 'never-dispatched') fail('state', 'resume_dispatched_replay_blocked');
  const path = join(root, trial.trialId);
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || dirname(realpathSync(path)) !== realpathSync(root)) fail('state', 'unsafe_trial_staging_path');
  const inventoryHash = hash(fileInventory(path));
  lifecycle.record(trial, { type: 'undispatched_staging_discarded', inventoryHash });
  rmSync(path, { recursive: true });
}
export function sealTrial(directory, name = 'trial-evidence.json') {
  const path = join(directory, name);
  if (existsSync(path)) return inspectTrialSeal(directory, name);
  const files = fileInventory(directory).filter(file => file.path !== name);
  for (const file of files) {
    const fd = openSync(join(directory, file.path), 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  durableJson(path, { schemaVersion: 1, files, inventoryHash: hash(files) });
  return sha256(readFileSync(path));
}
export function inspectTrialSeal(directory, name = 'trial-evidence.json', expectedHash) {
  const path = join(directory, name), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('state', 'trial_seal_invalid');
  const bytes = readFileSync(path), seal = JSON.parse(bytes);
  const files = fileInventory(directory).filter(file => file.path !== name
    && !(name === 'verified-evidence.json' && (['grade.json', 'trial-evidence.json'].includes(file.path)
      || file.path.startsWith('grading/'))));
  if (seal.schemaVersion !== 1 || hash(seal.files) !== seal.inventoryHash || hash(files) !== seal.inventoryHash
    || expectedHash !== undefined && sha256(bytes) !== expectedHash) fail('state', 'trial_evidence_changed');
  return sha256(bytes);
}
export function assertProcessGone(directory) {
  const processPath = join(directory, 'process.json');
  if (!existsSync(processPath)) fail('state', 'resume_worker_cleanup_unconfirmed');
  const process = readJson(processPath), cleanup = readJson(join(directory, 'cleanup.json'));
  if (!cleanup.processGroupGone || !cleanup.dependencyLinkRemoved || !Number.isSafeInteger(process.pid) || process.pid <= 0) fail('state', 'resume_worker_cleanup_unconfirmed');
  try { globalThis.process.kill(-process.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return; throw error; }
  fail('state', 'resume_worker_process_group_remaining');
}
export async function scheduleTrials(trials, { maxConcurrentTrials = 2, signal, execute, stopOnError = true }) {
  if (!Number.isInteger(maxConcurrentTrials) || maxConcurrentTrials < 1 || maxConcurrentTrials > 8) fail('policy', 'invalid_trial_concurrency');
  let cursor = 0, firstError;
  const results = new Map();
  await Promise.all(Array.from({ length: Math.min(maxConcurrentTrials, trials.length) }, async () => {
    while (cursor < trials.length && !(stopOnError && firstError)) {
      if (signal.aborted) { firstError ??= signal.reason; break; }
      const trial = trials[cursor++];
      try { results.set(trial.trialId, await execute(trial)); }
      catch (error) { firstError ??= error; }
    }
  }));
  if (firstError && stopOnError) throw firstError;
  return { results, error: firstError ?? null };
}
export function tracePointers(root, directory) {
  return fileInventory(directory).filter(file => /(?:verification|receipts|index|schema|answer|phases|state|responses|transcript|executions|output|grade|evidence|checkpoint|sqlite|artifacts)/u.test(file.path))
    .map(file => ({ artifact: relative(root, join(directory, file.path)), sha256: file.sha256 }));
}
