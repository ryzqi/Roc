import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EVAL_ROOT, hash, readJson, sha256 } from '../lib/common.mjs';
import { loadDataset } from '../lib/data.mjs';
import { acquireCapabilitySources, capabilitySourceAcquisitionPlan } from '../adapters/capability/acquire.mjs';
import { capabilityReadiness, prepareCapabilityDataset } from '../adapters/capability/data.mjs';
import { capabilityDevelopmentSources, capabilitySourceAdaptationManifest, capabilitySourceImportExample,
  writeCapabilitySourceImportExamples } from '../adapters/capability/import-examples.mjs';
import { capabilityLockedSourceSpec, capabilitySourceIds, importCapabilitySources,
  verifyCapabilitySourceSnapshot } from '../adapters/capability/sources.mjs';

const lock = readJson(new URL('../datasets/sources.lock.json', import.meta.url));
const originalRoot = join(EVAL_ROOT, 'local', 'sources');
const serialize = value => JSON.stringify(value, null, 2) + '\n';
const pinFor = id => lock.sources.find(source => source.id === id);
const snapshotFor = id => join(originalRoot, id, pinFor(id).revision);
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'roc-capability-sources-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function localSources(t, ids) {
  if (ids.some(id => !pinFor(id).artifacts.every(file => existsSync(join(snapshotFor(id), file.path))))) {
    t.skip('Pinned original bytes are absent. Acquire the named sources explicitly; tests never download.');
    return false;
  }
  return true;
}
function transport(id, change = bytes => bytes) {
  const source = pinFor(id), byUrl = new Map(source.artifacts.filter(pin => pin.url).map(pin => [pin.url, pin]));
  return async (url, options) => {
    const pin = byUrl.get(url);
    assert(pin, 'Acquisition must request an exact trusted URL.');
    assert.equal(new URL(url).protocol, 'https:');
    assert.deepEqual(Object.keys(options.headers), ['User-Agent']);
    assert(options.signal instanceof AbortSignal);
    const bytes = readFileSync(join(snapshotFor(id), pin.path));
    assert.equal(sha256(bytes), pin.sha256);
    return new Response(change(bytes, pin));
  };
}
const noNetwork = () => assert.fail('No network transport is allowed in offline verification.');
const acquire = (root, id, options = {}) => acquireCapabilitySources({ root, sourceIds: [id], ...options });

test('acquisition plan exposes real bounded P0 pins and leaves all unresolved pins null', () => {
  const plan = capabilitySourceAcquisitionPlan();
  assert.equal(plan.sources.length, 9);
  assert(plan.sources.every(source => source.status === 'verified' && /^[a-f0-9]{40}$|^v0\.3-dev$/u.test(source.revision)));
  assert(plan.sources.every(source => source.humanReview === 'pending' && source.scientificQuality === false));
  const total = plan.sources.reduce((sum, source) => sum + source.bytes, 0);
  assert(total > 30 * 1024 * 1024 && total < 64 * 1024 * 1024);
  for (const source of plan.sources) for (const file of source.files) {
    assert(/^[a-f0-9]{64}$/u.test(file.sha256)); assert(Number.isSafeInteger(file.bytes) && file.bytes > 0);
  }
  const pendingIds = lock.sources.filter(source => source.status === 'pending').map(source => source.id);
  for (const source of capabilitySourceAcquisitionPlan(pendingIds).sources) {
    assert.equal(source.revision, null); assert.equal(source.license, null); assert.deepEqual(source.files, []);
  }
  assert.throws(() => capabilitySourceAcquisitionPlan(['bfcl', 'bfcl']), /capability_acquisition_sources_invalid/u);
  assert.throws(() => capabilitySourceAcquisitionPlan(['unregistered']), /capability_acquisition_source_unknown/u);
});

test('all nine acquired originals verify offline without granting human or scientific qualification', async t => {
  if (!localSources(t, capabilitySourceIds)) return;
  const result = await acquireCapabilitySources({ root: originalRoot, offline: true, fetcher: noNetwork });
  assert.equal(result.sources.length, 9); assert.equal(result.sourceLockHash, hash(lock));
  for (const source of result.sources) {
    assert.equal(source.acquired, false); assert.equal(source.sourceVerified, true);
    assert.equal(source.humanReview, 'pending'); assert.equal(source.scientificQuality, false);
    assert.equal(source.sourceLockHash, hash(pinFor(source.dataset)));
  }
});

test('exact original bytes through an injected anonymous transport create a verified snapshot, then never refetch', async t => {
  if (!localSources(t, ['bfcl'])) return;
  const root = temporary(t), first = await acquire(root, 'bfcl', { fetcher: transport('bfcl') });
  assert.equal(first.sources[0].acquired, true); assert.equal(first.sources[0].sourceVerified, true);
  const target = join(root, 'bfcl', pinFor('bfcl').revision);
  assert.equal(verifyCapabilitySourceSnapshot(target, 'bfcl').sourceVerified, true);
  assert.deepEqual(readdirSync(join(root, 'bfcl')), [pinFor('bfcl').revision]);
  assert.equal((await acquire(root, 'bfcl', { fetcher: noNetwork })).sources[0].acquired, false);
});

test('pending acquisition, absent offline snapshots and excess byte budgets fail before fetching or staging', async t => {
  const root = temporary(t);
  await assert.rejects(acquire(root, 'tau2-bench', { fetcher: noNetwork }), /capability_acquisition_source_pending/u);
  await assert.rejects(acquire(root, 'bfcl', { offline: true, fetcher: noNetwork }),
    /capability_acquisition_snapshot_missing/u);
  await assert.rejects(acquire(root, 'bfcl', { maxBytes: 1, fetcher: noNetwork }),
    /capability_acquisition_byte_budget_exceeded/u);
  assert.deepEqual(readdirSync(root), []);
});

for (const [name, change, error] of [
  ['same-size corruption', bytes => { const changed = Buffer.from(bytes); changed[0] ^= 1; return changed; },
    /capability_acquisition_hash_mismatch/u],
  ['oversized transport', bytes => Buffer.concat([bytes, Buffer.from('x')]),
    /capability_acquisition_download_too_large/u],
  ['truncated transport', bytes => bytes.subarray(0, bytes.length - 1),
    /capability_acquisition_hash_mismatch/u]
]) test(`acquisition rejects ${name} and removes only its own staging and lease`, async t => {
  if (!localSources(t, ['bfcl'])) return;
  const root = temporary(t), parent = join(root, 'bfcl');
  mkdirSync(parent); writeFileSync(join(parent, 'keep-owner-data.txt'), 'owned by the caller\n');
  await assert.rejects(acquire(root, 'bfcl', { fetcher: transport('bfcl', change) }), error);
  assert.deepEqual(readdirSync(parent), ['keep-owner-data.txt']);
  assert.equal(readFileSync(join(parent, 'keep-owner-data.txt'), 'utf8'), 'owned by the caller\n');
});

test('failed and interrupted transports clean up staging without success-shaped fallback', async t => {
  const root = temporary(t);
  await assert.rejects(acquire(root, 'bfcl', { fetcher: async () => new Response('', { status: 403 }) }),
    /capability_acquisition_fetch_failed/u);
  await assert.rejects(acquire(root, 'bfcl', { fetcher: async () => ({ ok: true, body: (async function* () {
    yield Buffer.from('first');
    throw new Error('injected transport interruption');
  })() }) }), /capability_acquisition_fetch_incomplete/u);
  assert.deepEqual(readdirSync(join(root, 'bfcl')), []);
});

test('an existing acquisition lease and its caller content survive an ownership rejection', async t => {
  const root = temporary(t), parent = join(root, 'bfcl'), revision = pinFor('bfcl').revision;
  mkdirSync(parent);
  const lease = join(parent, `.${revision}.acquire.lock`);
  writeFileSync(lease, 'caller lease\n');
  await assert.rejects(acquire(root, 'bfcl', { fetcher: noNetwork }), /capability_acquisition_already_owned/u);
  assert.equal(readFileSync(lease, 'utf8'), 'caller lease\n'); assert.equal(readdirSync(parent).length, 1);
});

test('symlinked acquisition roots, source directories and original members cannot escape the selected root', async t => {
  if (!localSources(t, ['bfcl'])) return;
  const root = temporary(t), outside = join(root, 'outside');
  mkdirSync(outside);
  const linkedRoot = join(root, 'linked-root'); symlinkSync(outside, linkedRoot, 'dir');
  await assert.rejects(acquire(linkedRoot, 'bfcl', { fetcher: noNetwork }), /capability_acquisition_path_escape/u);
  const chosenRoot = join(root, 'chosen'); mkdirSync(chosenRoot);
  symlinkSync(outside, join(chosenRoot, 'bfcl'), 'dir');
  await assert.rejects(acquire(chosenRoot, 'bfcl', { fetcher: noNetwork }), /capability_acquisition_path_escape/u);
  const memberRoot = join(root, 'members'), target = join(memberRoot, 'bfcl', pinFor('bfcl').revision);
  cpSync(snapshotFor('bfcl'), target, { recursive: true });
  const member = join(target, pinFor('bfcl').licenseFile);
  rmSync(member); symlinkSync(join(snapshotFor('bfcl'), pinFor('bfcl').licenseFile), member);
  await assert.rejects(acquire(memberRoot, 'bfcl', { offline: true, fetcher: noNetwork }),
    /capability_acquisition_path_escape/u);
  assert.deepEqual(readdirSync(outside), []);
});

test('tampered existing originals are rejected without automatic repair or network requests', async t => {
  if (!localSources(t, ['bfcl'])) return;
  const root = temporary(t), target = join(root, 'bfcl', pinFor('bfcl').revision);
  cpSync(snapshotFor('bfcl'), target, { recursive: true });
  const path = join(target, pinFor('bfcl').licenseFile), bytes = readFileSync(path);
  bytes[0] ^= 1; writeFileSync(path, bytes);
  await assert.rejects(acquire(root, 'bfcl', { offline: true, fetcher: noNetwork }),
    /capability_acquisition_hash_mismatch/u);
  assert.deepEqual(readFileSync(path), bytes);
});

test('SciFact archive members are extracted to stdout from exact pinned bytes and independently reverified', async t => {
  if (!localSources(t, ['scifact'])) return;
  const root = temporary(t), result = await acquire(root, 'scifact', { fetcher: transport('scifact') });
  assert.equal(result.sources[0].sourceVerified, true);
  const target = join(root, 'scifact', pinFor('scifact').revision);
  for (const pin of pinFor('scifact').artifacts.filter(pin => pin.archiveMember)) {
    assert.equal(sha256(readFileSync(join(target, pin.path))), pin.sha256);
  }
  const member = join(target, 'data/claims_dev.jsonl'), bytes = readFileSync(member);
  bytes[0] ^= 1; writeFileSync(member, bytes);
  await assert.rejects(acquire(root, 'scifact', { offline: true, fetcher: noNetwork }),
    /capability_acquisition_hash_mismatch/u);
});

for (const dataset of capabilityDevelopmentSources) {
  test(`actual ${dataset} development example seals original IDs, annotations and production tools with reviews pending`, async t => {
    if (!localSources(t, [dataset])) return;
    const root = temporary(t), input = capabilitySourceImportExample(dataset);
    const path = await prepareCapabilityDataset(input, { suite: input.suite, cacheRoot: join(root, 'cache') });
    const loaded = loadDataset(path), readiness = capabilityReadiness(loaded), task = loaded.tasks[0];
    assert.equal(readiness.total, 1); assert.equal(readiness.supported, 1); assert.equal(readiness.status, 'pending');
    assert.equal(readiness.holdoutDatasetReady, false); assert.equal(readiness.releaseDatasetReady, false);
    assert.equal(readiness.tasks[0].upstreamVerified, true); assert.equal(readiness.tasks[0].qualified, false);
    assert.equal(task.source.dataset, dataset); assert.equal(task.source.revision, pinFor(dataset).revision);
    assert.equal(task.split, 'development'); assert.equal(task.review.reviewers.length, 0);
    const evidence = readJson(join(path, 'source-evidence.json')).sources[0];
    assert.equal(evidence.origin.kind, 'locked-public-snapshot');
    assert(evidence.originals[0].groundTruth.length > 0); assert(evidence.originals[0].clusterKeys.length > 0);
    const publicInput = serialize({ visible: task.visible, environment: task.environment });
    assert(!publicInput.includes('Expected Achievements')); assert(!publicInput.includes('"ground_truth"'));
    for (const name of task.environment.tools) assert(serialize(task.visible).includes(name));
    if (dataset === 'bfcl') {
      assert.equal(task.source.originalTaskId, 'multi_turn_base_25');
      assert.equal(task.expected.checks[1].value, task.visible.files['summary.txt']);
      assert(evidence.originals[0].nativeRefs.some(ref => ref.kind === 'function-schema'));
    } else if (dataset === 'scifact') {
      assert.equal(task.source.originalTaskId, '3'); assert.equal(task.expected.checks[2].value, 'SUPPORT');
      assert.equal(task.environment.research.documents[0].license, 'ODC-By-1.0');
      assert.equal(task.environment.research.documents[0].contentSha256,
        sha256(task.environment.research.documents[0].content));
      assert(!task.environment.research.documents[0].content.includes('"label"'));
    } else if (dataset === 'locomo') {
      assert.equal(task.source.originalTaskId, 'data/locomo10.json#/0/qa/0');
      assert.equal(task.expected.checks.find(check => check.kind === 'memory').key, task.visible.files['memory-key.txt']);
      assert.equal(task.expected.checks.find(check => check.id === 'original-answer').value, '7 May 2023');
      assert.deepEqual(task.environment.session.turns.map(turn => turn.thread), ['new', 'new']);
      const original = readJson(join(snapshotFor(dataset), 'data/locomo10.json'))[0];
      assert.deepEqual(JSON.parse(task.visible.files['conversation.json']), original.conversation);
      assert(!task.visible.files['conversation.json'].includes('"qa"'));
    } else {
      assert.equal(task.source.originalTaskId, 'data/test_cases_dh_base.json#/0');
      assert.equal(task.expected.checks.find(check => check.path === 'product-details.txt').content,
        task.visible.files['tool-response.txt']);
      assert(task.visible.files['tool-response.txt'].includes('guest_amy01'));
      assert.deepEqual(task.expected.safety.prohibitedPaths, ['access-policy.json']);
      assert(evidence.originals[0].nativeRefs.some(ref => ref.kind === 'attacker-objective'));
    }
  });
}

test('actual BFCL answer rows cannot be relabeled or copied into public inputs', t => {
  if (!localSources(t, ['bfcl'])) return;
  const good = capabilitySourceImportExample('bfcl').imports[0], wrong = structuredClone(good);
  wrong.mappings[0].groundTruth[0].path[0] = '26';
  assert.throws(() => importCapabilitySources([wrong]), /capability_bfcl_answer_identity_mismatch/u);
  const leaked = structuredClone(good);
  leaked.mappings[0].task.visible.files['reference.txt'] = {
    $source: good.mappings[0].groundTruth[0], encoding: 'json'
  };
  assert.throws(() => importCapabilitySources([leaked]), /capability_hidden_truth_source_binding/u);
  const revised = structuredClone(good); revised.revision = 'main';
  assert.throws(() => importCapabilitySources([revised]), /capability_source_revision_unpinned/u);
});

test('pending native adaptations expose their missing evidence and do not produce runnable fabricated tasks', t => {
  for (const dataset of ['toolsandbox', 'longmemeval-v2', 'scienceagentbench-verified', 'agentdojo', 'qasper']) {
    const status = capabilitySourceAdaptationManifest(dataset);
    assert.equal(status.acquisitionStatus, 'verified'); assert.equal(status.humanReview, 'pending');
    assert.equal(status.scientificQuality, false); assert.deepEqual(status.tasks, []); assert(status.reason);
    assert.throws(() => capabilitySourceImportExample(dataset),
      dataset === 'qasper' ? /capability_example_qasper_selection_required/u : /capability_example_adaptation_pending/u);
  }
  if (!localSources(t, ['longmemeval-v2'])) return;
  const spec = capabilityLockedSourceSpec('longmemeval-v2', { root: snapshotFor('longmemeval-v2') });
  const question = JSON.parse(readFileSync(join(spec.root, 'questions.jsonl'), 'utf8').split('\n')[0]);
  const haystacks = readJson(join(spec.root, 'haystacks/lme_v2_small.json'));
  const coordinate = Array.isArray(haystacks) ? ['0'] : [Object.keys(haystacks)[0]];
  const originalTaskId = String(question.question_id ?? question.instance_id ?? question.task_id ?? question.id
    ?? 'questions.jsonl#/0');
  spec.mappings = [{
    originalTaskId, record: { file: 'questions.jsonl', path: ['0'] },
    groundTruth: [{ file: 'questions.jsonl', path: ['0', Object.keys(question).find(key => /answer|eval_function/u.test(key))] }],
    historyRef: { file: 'haystacks/lme_v2_small.json', path: coordinate },
    task: { id: 'v2-incomplete-history-probe', family: 'memory-context-compaction', difficulty: 'moderate',
      split: 'development', capabilityTags: ['test_only'], visible: { prompt: 'Read original histories.', files: {} },
      environment: { tools: ['read_file'], network: 'disabled' },
      expected: { checks: [{ id: 'missing-history-probe', kind: 'json-value', path: ['ok'], value: true }] },
      review: { producer: 'test-only-incomplete-history-probe', reviewers: [] } }
  }];
  assert.throws(() => importCapabilitySources([spec]), /capability_complete_history_required/u);
});

test('local example writer produces four CLI corpora and five pending manifests without overwriting caller files', t => {
  if (!localSources(t, capabilityDevelopmentSources)) return;
  const root = temporary(t), outputs = writeCapabilitySourceImportExamples({ outputRoot: root });
  assert.equal(outputs.length, 9); assert.equal(outputs.filter(output => output.importable).length, 4);
  for (const output of outputs) {
    const value = readJson(output.path);
    if (output.importable) {
      assert.equal(value.schemaVersion, 2); assert.equal(value.imports.length, 1);
      assert.equal(value.imports[0].dataset, output.dataset);
    } else assert.deepEqual(value.tasks, []);
  }
  const originals = outputs.map(output => sha256(readFileSync(output.path)));
  assert.throws(() => writeCapabilitySourceImportExamples({ outputRoot: root }), /capability_example_output_exists/u);
  assert.deepEqual(outputs.map(output => sha256(readFileSync(output.path))), originals);
});

test('qualification connected roots are stable across source order and preserve every original task', async t => {
  if (!localSources(t, ['bfcl', 'scifact'])) return;
  const root = temporary(t), imports = ['bfcl', 'scifact'].map(id => capabilitySourceImportExample(id).imports[0]);
  const roots = [];
  for (const ordered of [imports, [...imports].reverse()]) {
    const path = await prepareCapabilityDataset({ schemaVersion: 2, imports: ordered },
      { suite: 'roc-capability', cacheRoot: join(root, 'cache') });
    const dataset = loadDataset(path), before = structuredClone(dataset.tasks), readiness = capabilityReadiness(dataset);
    assert.deepEqual(dataset.tasks, before); assert.equal(dataset.tasks.length, 2);
    roots.push(Object.fromEntries(readiness.tasks.map(task => [task.id, task.sourceConnectedRoot])));
    assert(Object.values(roots.at(-1)).every(value => /^source-connected-[a-f0-9]{64}$/u.test(value)));
  }
  assert.deepEqual(roots[0], roots[1]); assert.equal(new Set(Object.values(roots[0])).size, 2);
});
