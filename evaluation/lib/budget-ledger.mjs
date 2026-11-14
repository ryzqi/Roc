import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, readdirSync,
  renameSync, writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { BudgetController, budgetOptionsSchema } from './budget.mjs';
import { fail, hash } from './common.mjs';

const stateName = 'budget-state.json';
const journalName = 'events.jsonl';
const mutations = new Set(['budget_reserved', 'budget_dispatched', 'budget_settled', 'budget_unknown']);
const controls = new Set(['budget_initialized', 'budget_restored', 'budget_rejected']);
const reservationFields = [
  'requestId', 'trialId', 'requestHash', 'kind', 'providerId', 'model', 'requestNumber',
  'state', 'reserved', 'measured', 'createdAtMs', 'updatedAtMs', 'dispatchedAtMs',
  'reason', 'accounted', 'pricingRevision'
];
const immutableFields = [
  'requestId', 'trialId', 'requestHash', 'kind', 'providerId', 'model',
  'requestNumber', 'reserved', 'createdAtMs'
];
const count = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const same = (a, b) => a === undefined || b === undefined ? a === b : hash(a) === hash(b);

function policyOptions(policy) {
  const parsed = budgetOptionsSchema.safeParse(policy);
  if (!parsed.success) fail('policy', 'budget_policy_invalid');
  return parsed.data;
}

function statOrNull(path) {
  try { return lstatSync(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('state', 'budget_ledger_io_failed');
  }
}

function writableRoot(root) {
  if (typeof root !== 'string' || !root) fail('state', 'budget_root_invalid');
  const directory = resolve(root), stat = statOrNull(directory);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('state', 'budget_root_invalid');
  // lstat also rejects a dangling seal symlink, without opening the seal or its target.
  if (statOrNull(join(directory, 'seal.json'))) fail('state', 'budget_run_sealed');
  if (readdirSync(directory).some(name => name.startsWith(`${stateName}.`) && name.endsWith('.tmp'))) {
    fail('state', 'budget_snapshot_partial');
  }
  return directory;
}

function readText(path, maxBytes, missingCode) {
  const stat = statOrNull(path);
  if (!stat) {
    if (missingCode) fail('state', missingCode);
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) fail('state', 'budget_ledger_file_invalid');
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd));
  } catch { fail('state', 'budget_ledger_file_invalid'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function validEvent(event) {
  return object(event) && count(event.sequence) && event.sequence > 0
    && typeof event.type === 'string' && event.type.length > 0
    && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at));
}

function history(root, previousEvents, required = false) {
  const text = readText(join(root, journalName), 512 * 1024 * 1024, required ? 'budget_journal_missing' : null);
  let events = [];
  if (text !== null) {
    if (text && !text.endsWith('\n')) fail('state', 'budget_journal_torn_write');
    try { events = text ? text.slice(0, -1).split('\n').map(line => JSON.parse(line)) : []; }
    catch { fail('state', 'budget_journal_invalid'); }
  }
  if (previousEvents !== null && previousEvents !== undefined) {
    if (!Array.isArray(previousEvents)) fail('state', 'budget_journal_invalid');
    if (text !== null && !same(events, previousEvents)) fail('state', 'budget_journal_changed');
    events = structuredClone(previousEvents);
  }
  for (const [index, event] of events.entries()) {
    if (!validEvent(event) || event.sequence !== index + 1) fail('state', 'budget_journal_sequence_invalid');
  }
  return events;
}

function snapshotOnly(saved) {
  const { stateHash, anchorSequence, anchorHash, ...snapshot } = saved;
  return snapshot;
}

// Use the controller's own pricing/accounting validation without performing any transport or
// recording anything. Undo only restore's dispatched->unknown presentation changes for comparison.
function validateSnapshot(snapshot, policy) {
  let normalized;
  try {
    const checker = new BudgetController(policy, () => {}, { now: () => snapshot.capturedAtMs });
    normalized = checker.restore(snapshot);
    normalized.reservations = normalized.reservations.map((value, index) => {
      const original = snapshot.reservations[index];
      return original.state === 'dispatched'
        ? { ...value, state: 'dispatched', updatedAtMs: original.updatedAtMs, reason: original.reason }
        : value;
    });
    normalized.pendingRequests = snapshot.reservations.filter(value => ['reserved', 'dispatched'].includes(value.state)).length;
    normalized.unknownRequests = snapshot.reservations.filter(value => value.state === 'unknown').length;
    normalized.usageState = normalized.unknownRequests ? 'unknown' : normalized.pendingRequests ? 'pending' : 'measured';
  } catch { fail('state', 'budget_snapshot_invalid'); }
  if (!same(normalized, snapshot)) fail('state', 'budget_snapshot_invalid');
}

function applyMutation(event, reservations) {
  if (reservationFields.some(key => !Object.hasOwn(event, key))
    || !count(event.atMs) || event.updatedAtMs !== event.atMs
    || typeof event.requestId !== 'string' || !object(event.reserved)
    || !object(event.measured) || !object(event.accounted)) fail('state', 'budget_reservation_event_invalid');
  const value = pick(event, reservationFields), previous = reservations.get(value.requestId);
  if (event.type === 'budget_reserved') {
    if (previous || value.state !== 'reserved' || value.requestNumber !== reservations.size + 1
      || value.createdAtMs !== value.updatedAtMs || value.dispatchedAtMs !== null || value.reason !== null) {
      fail('state', 'budget_reservation_event_invalid');
    }
  } else {
    if (!previous || !same(pick(previous, immutableFields), pick(value, immutableFields))
      || value.updatedAtMs < previous.updatedAtMs
      || event.type !== 'budget_dispatched' && value.dispatchedAtMs !== previous.dispatchedAtMs) {
      fail('state', 'budget_reservation_event_invalid');
    }
    if (event.type === 'budget_dispatched') {
      if (previous.state !== 'reserved' || value.state !== 'dispatched'
        || value.dispatchedAtMs !== value.updatedAtMs || !same(value.measured, previous.measured) || value.reason !== null) {
        fail('state', 'budget_reservation_event_invalid');
      }
    } else {
      if (!['dispatched', 'unknown'].includes(previous.state)
        || previous.state === 'unknown' && event.type === 'budget_settled' && event.reconciled !== true
        || value.state !== (event.type === 'budget_settled' ? 'settled' : 'unknown')) {
        fail('state', 'budget_reservation_event_invalid');
      }
      if (event.reconciled === true) {
        for (const key of ['inputTokens', 'outputTokens']) {
          if (previous.measured[key] !== null && value.measured[key] !== previous.measured[key]) {
            fail('state', 'budget_reservation_event_invalid');
          }
        }
      } else if (!Object.hasOwn(event, 'reconciled') && !same(value.measured, previous.measured)) {
        fail('state', 'budget_reservation_event_invalid');
      }
    }
  }
  reservations.set(value.requestId, value);
}

/**
 * Read-only admission check for resume. Returns the saved, flat BudgetController snapshot plus
 * stateHash/anchorSequence/anchorHash; BudgetController.restore accepts those metadata fields.
 * previousEvents must be the complete journal, not just its budget subset.
 */
export function validateBudgetLedger(root, policy, previousEvents = null) {
  const options = policyOptions(policy), policyHash = hash(options), directory = writableRoot(root);
  const text = readText(join(directory, stateName), 64 * 1024 * 1024, 'budget_snapshot_missing');
  if (!text.endsWith('\n')) fail('state', 'budget_snapshot_torn_write');
  let saved;
  try { saved = JSON.parse(text); } catch { fail('state', 'budget_snapshot_invalid'); }
  if (!object(saved) || !digest(saved.stateHash) || !digest(saved.anchorHash)
    || !count(saved.anchorSequence) || saved.anchorSequence === 0) fail('state', 'budget_snapshot_invalid');
  const { stateHash, ...payload } = saved;
  if (hash(payload) !== stateHash) fail('state', 'budget_snapshot_hash_changed');
  if (saved.policyHash !== policyHash) fail('state', 'budget_snapshot_policy_changed');
  const events = history(directory, previousEvents, true), reservations = new Map(), checkpoints = new Map();
  let initialized = null, pending = null, checkpoint = null, lastElapsed = 0, lastAtMs = 0;
  for (const event of events) {
    if (pending) {
      if (event.type !== 'budget_checkpoint') fail('state', 'budget_checkpoint_missing');
      if (event.schemaVersion !== 1 || event.policyHash !== policyHash || !digest(event.stateHash)
        || event.anchorSequence !== pending.sequence || event.anchorHash !== hash(pending)
        || event.sequence !== pending.sequence + 1) fail('state', 'budget_checkpoint_changed');
      checkpoints.set(event.anchorSequence, event);
      checkpoint = event;
      pending = null;
      continue;
    }
    if (!event.type.startsWith('budget_')) continue;
    if (!mutations.has(event.type) && !controls.has(event.type)) fail('state', 'budget_event_invalid');
    if (event.schemaVersion !== 1 || event.policyHash !== policyHash
      || !count(event.elapsedMs) || !count(event.atMs)
      || event.elapsedMs < lastElapsed || event.atMs < lastAtMs) fail('state', 'budget_event_invalid');
    lastElapsed = event.elapsedMs;
    lastAtMs = event.atMs;
    if (event.type === 'budget_initialized') {
      if (initialized || event.startedAtMs !== saved.startedAtMs || event.elapsedMs !== 0
        || event.atMs !== event.startedAtMs) fail('state', 'budget_initialization_invalid');
      initialized = event;
    } else {
      if (!initialized) fail('state', 'budget_initialization_missing');
      if (mutations.has(event.type)) applyMutation(event, reservations);
      if (event.type === 'budget_restored') {
        const source = checkpoints.get(event.restoredFromAnchorSequence);
        if (!source || source.stateHash !== event.restoredFromStateHash) fail('state', 'budget_restore_anchor_changed');
      }
    }
    pending = event;
  }
  if (pending) fail('state', 'budget_checkpoint_missing');
  if (!initialized || !checkpoint) fail('state', 'budget_initialization_missing');
  if (checkpoint.stateHash !== saved.stateHash || checkpoint.anchorSequence !== saved.anchorSequence
    || checkpoint.anchorHash !== saved.anchorHash) fail('state', 'budget_checkpoint_changed');
  const snapshot = snapshotOnly(saved);
  validateSnapshot(snapshot, options);
  if (snapshot.capturedAtMs < lastAtMs || snapshot.elapsedMs < lastElapsed
    || snapshot.elapsedMs - lastElapsed !== snapshot.capturedAtMs - lastAtMs
    || reservations.size !== snapshot.reservations.length
    || snapshot.reservations.some(value => !same(value, reservations.get(value.requestId)))) {
    fail('state', 'budget_snapshot_reservations_changed');
  }
  return saved;
}

function atomicSnapshot(root, saved) {
  const target = join(root, stateName), stat = statOrNull(target);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) fail('state', 'budget_ledger_file_invalid');
  const temp = join(root, `${stateName}.${randomUUID()}.tmp`);
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(saved, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  // A failed write deliberately leaves its owned partial file for fail-closed recovery.
  writableRootBeforeRename(root, temp);
  renameSync(temp, target);
  const parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

function writableRootBeforeRename(root, ownTemp) {
  if (statOrNull(join(root, 'seal.json'))) fail('state', 'budget_run_sealed');
  if (readdirSync(root).some(name => name.startsWith(`${stateName}.`) && name.endsWith('.tmp') && join(root, name) !== ownTemp)) {
    fail('state', 'budget_snapshot_partial');
  }
}

function synchronousAppend(append, payload, minimumSequence, exactSequence = null) {
  const expected = structuredClone(payload), event = append(structuredClone(payload));
  if (event && typeof event.then === 'function') {
    Promise.resolve(event).catch(() => {});
    fail('state', 'budget_journal_failed');
  }
  if (!validEvent(event) || event.sequence <= minimumSequence || exactSequence !== null && event.sequence !== exactSequence
    || !same(pick(event, Object.keys(expected)), expected)
    || Object.keys(event).some(key => !Object.hasOwn(expected, key) && !['sequence', 'at'].includes(key))) {
    fail('state', 'budget_journal_failed');
  }
  return structuredClone(event);
}

/**
 * One trusted synchronous writer per run. append(event) must fsync and return the actual journal
 * event with sequence/at. Passing previousEvents resumes; null initializes without overwriting.
 * A method may dispatch transport only after its entire callback has returned successfully.
 */
export function openBudgetLedger(root, policy, append, { previousEvents = null, now = Date.now } = {}) {
  const options = policyOptions(policy), policyHash = hash(options), directory = writableRoot(root);
  if (typeof append !== 'function') fail('state', 'budget_journal_callback_invalid');
  const saved = previousEvents === null ? null : validateBudgetLedger(directory, options, previousEvents);
  const events = saved ? structuredClone(previousEvents) : history(directory, previousEvents);
  if (!saved && (statOrNull(join(directory, stateName)) || events.some(event => event.type.startsWith('budget_')))) {
    fail('state', 'budget_ledger_already_exists');
  }
  let controller, failed = false, writing = false, sequence = events.length, constructedAtMs;
  function commit(detail) {
    if (failed || writing) fail('state', 'budget_journal_failed');
    writing = true;
    try {
      writableRoot(directory);
      // Callback contexts may contain arbitrary caller data. Persist only budget/correlation fields.
      const payload = {
        ...pick(detail, [...reservationFields, 'reconciled', 'elapsedMs', 'atMs', 'startedAtMs',
          'restoredFromStateHash', 'restoredFromAnchorSequence']),
        type: detail.type, schemaVersion: 1, policyHash
      };
      if (!mutations.has(payload.type) && !controls.has(payload.type)) fail('state', 'budget_event_invalid');
      if (payload.reason !== undefined && payload.reason !== null
        && !/^[a-z][a-z0-9_]{0,127}$/.test(payload.reason)) fail('state', 'budget_event_invalid');
      const anchor = synchronousAppend(append, payload, sequence);
      const snapshot = controller.snapshot();
      const body = { ...snapshot, anchorSequence: anchor.sequence, anchorHash: hash(anchor) };
      const state = { ...body, stateHash: hash(body) };
      atomicSnapshot(directory, state);
      const checkpoint = synchronousAppend(append, {
        type: 'budget_checkpoint', schemaVersion: 1, policyHash, stateHash: state.stateHash,
        anchorSequence: state.anchorSequence, anchorHash: state.anchorHash
      }, anchor.sequence, anchor.sequence + 1);
      sequence = checkpoint.sequence;
    } catch {
      failed = true;
      fail('state', 'budget_journal_failed');
    } finally { writing = false; }
  }
  controller = new BudgetController(options, commit, { now: () => {
    const value = now();
    constructedAtMs ??= value;
    return value;
  } });
  if (saved) {
    const restored = controller.restore(saved);
    commit({ type: 'budget_restored', restoredFromStateHash: saved.stateHash,
      restoredFromAnchorSequence: saved.anchorSequence, elapsedMs: restored.elapsedMs, atMs: restored.capturedAtMs });
  } else {
    commit({ type: 'budget_initialized', startedAtMs: constructedAtMs, atMs: constructedAtMs, elapsedMs: 0 });
  }
  return controller;
}
