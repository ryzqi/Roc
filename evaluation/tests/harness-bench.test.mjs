import { scienceFixture } from './science-fixture.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { answerF1, evidenceF1, importQasper, qasperInput, gradeQasper } from '../lib/qasper.mjs';
import { hash, sha256, writeJson, fileInventory, snapshotNativeEvidence, ROOT } from '../lib/common.mjs';
import { loadDataset, prepareScience, scienceRecipeSchema } from '../lib/data.mjs';
import { compareRuns, summarize, sealRun, inspectRun } from '../lib/report.mjs';
import { createProvider, validateProviderOptions } from '../lib/provider.mjs';
import { runBenchmark, selectTasks, profiles } from '../lib/runner.mjs';
import { applicationContract } from '../lib/application-verifier.mjs';
import { parseScienceGrade, gradeScience } from '../lib/science.mjs';
import { testArtifacts } from './test-artifacts.mjs';

const root = testArtifacts('protocol');
const paragraph = 'The experiment measured a 25% increase.';
const annotation = (overrides = {}) => ({ answer: { unanswerable: false, extractive_spans: ['25%'], free_form_answer: '', yes_no: null, evidence: [paragraph], ...overrides } });
const paper = (id, annotations = [annotation()]) => ({ title: 'Test paper', abstract: 'Abstract text', full_text: [{ section_name: 'Results', paragraphs: [paragraph] }],
  qas: [{ question_id: id, question: 'How much did it increase?', answers: annotations }] });

test('QASPER matches native token normalization, multiset and empty-answer semantics', () => {
  assert.equal(answerF1('The Cat, a dog!', 'cat dog'), 1);
  assert.equal(answerF1('x x y', 'x y y'), 2 / 3);
  assert.equal(answerF1('', ''), 0);
  assert.equal(answerF1('Yes', 'yes'), 1);
  assert.equal(answerF1('a[x]\\y', 'axy'), 1);
  assert.equal(evidenceF1([], []), 1);
  assert.equal(evidenceF1(['p', 'p'], ['p']), 2 / 3);
});
test('QASPER preserves annotation alternatives, handles unanswerable, keeps gold out of task view', () => {
  const [task] = importQasper({ paper: paper('q', [annotation(), annotation({ extractive_spans: [], free_form_answer: 'one quarter' })]) });
  const input = qasperInput(task);
  assert.equal(JSON.stringify(input).includes('one quarter'), false);
  const grade = gradeQasper(task, JSON.stringify({ answer: 'one quarter', evidence: ['p1'] }));
  assert.deepEqual(grade.metrics, { answerF1: 1, evidenceF1: 1, citationValidity: 1 });
  const [none] = importQasper({ paper: paper('n', [annotation({ unanswerable: true })]) });
  assert.equal(gradeQasper(none, '{"answer":"Unanswerable","evidence":[]}').metrics.answerF1, 1);
  assert.equal(gradeQasper(task, '{"answer":"25%","evidence":["p99"]}').failureClass, 'agent');
  assert.equal(gradeQasper(task, '{"answer":"25%","evidence":["p1","p1"]}').reason, 'citation_invalid');
  assert.equal(gradeQasper(task, '```json\n{}\n```').reason, 'output_not_json');
  assert.equal(gradeQasper(task, '{}').reason, 'output_schema_invalid');
});
test('paper groups never cross splits; unsupported evidence stays explicitly excluded', () => {
  const data = paper('a'); data.qas.push({ ...data.qas[0], question_id: 'b' });
  const tasks = importQasper({ same: data, figure: paper('c', [annotation({ evidence: ['Figure 2'] })]) });
  assert.equal(tasks.find(t => t.id === 'a').split, tasks.find(t => t.id === 'b').split);
  assert.equal(tasks.find(t => t.id === 'c').unsupported, 'non_text_or_unmapped_evidence');
  assert.throws(() => importQasper({ x: data, y: data }), /question_invalid/);
});
test('selection is stable, distributes clusters, and never fills from another split', () => {
  const tasks = Array.from({ length: 30 }, (_, i) => ({ id: String(i), clusterId: String(i % 6), split: i < 24 ? 'development' : 'holdout' }));
  const selected = selectTasks(tasks, profiles.fast);
  assert.equal(selected.length, 5); assert.equal(new Set(selected.map(t => t.clusterId)).size, 5);
  assert.deepEqual(selectTasks([...tasks].reverse(), profiles.fast), selected);
  assert.ok(selectTasks(tasks, profiles.release).every(t => t.split === 'holdout'));
});
function run(score = .8) {
  const selection = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, clusterId: `paper${i}` }));
  const manifest = { suite: 'qasper', evidence: 'live-model', datasetIdentity: 'dataset', selection, repeats: 3, metrics: ['answerF1'], scorerHash: 'scorer', provider: { model: 'frozen' }, environment: { node: 'same' }, split: 'holdout', exclusions: [], source: { sourceHash: String(score) } };
  manifest.toolManifest = { tools: [{ modelVisibleName: 'read_file', executionScopes: ['main'], effect: 'read' }] };
  manifest.applicationContract = applicationContract;
  const trials = selection.flatMap(t => Array.from({ length: 3 }, (_, repeat) => ({ taskId: t.id, clusterId: t.clusterId, repeat, status: 'scored', metrics: { answerF1: score }, latencyMs: 100, toolSchemaHash: hash('test-schema'),
    runtimeVerification: { status: 'verified', contractHash: hash(applicationContract), finalAnswerHash: hash('final-answer'), evidenceHash: hash('runtime-evidence') } })));
  return { manifest, trials, summary: summarize(manifest, trials) };
}
test('paired comparison detects regression and never calls fixture/small/incomplete evidence green', () => {
  assert.equal(compareRuns(run(.8), run(.9)).conclusion, 'non-inferior');
  assert.equal(compareRuns(run(.8), run(.6)).conclusion, 'regression');
  const fixtureA = run(), fixtureB = run(); fixtureA.manifest.evidence = fixtureB.manifest.evidence = 'fixture';
  assert.equal(compareRuns(fixtureA, fixtureB).conclusion, 'insufficient');
  const incomplete = run(); incomplete.summary.status = 'incomplete';
  assert.equal(compareRuns(run(), incomplete).conclusion, 'incomplete');
  const drift = run(); drift.manifest.scorerHash = 'changed';
  assert.deepEqual(compareRuns(run(), drift).mismatches, ['scorerHash']);
  const missing = run(); missing.trials.pop(); assert.throws(() => compareRuns(run(), missing), /trial_set_invalid/);
});
test('comparison holds tool permissions and observed schemas fixed while allowing harness changes', () => {
  const drift = run(); drift.manifest.toolManifest.tools.push({ modelVisibleName: 'write_file', executionScopes: ['main'], effect: 'write' });
  assert.deepEqual(compareRuns(run(), drift).mismatches, ['toolManifest']);
  const scope = run(); scope.manifest.toolManifest.tools[0].executionScopes.push('subagent');
  assert.deepEqual(compareRuns(run(), scope).mismatches, ['toolManifest']);
  const schema = run(); schema.trials.forEach(t => { t.toolSchemaHash = hash('changed-schema'); });
  assert.deepEqual(compareRuns(run(), schema).mismatches, ['toolSchemaHash']);
  const changed = run(); changed.manifest.source.sourceHash = 'new-harness'; changed.manifest.workerHash = 'new-worker';
  assert.equal(compareRuns(run(), changed).conclusion, 'non-inferior');
});
test('legacy or partial tool evidence cannot establish non-inferiority', () => {
  const a = run(), b = run(); delete a.manifest.toolManifest; delete b.manifest.toolManifest;
  assert.equal(compareRuns(a, b).conclusion, 'insufficient');
  const missing = run(); delete missing.trials[0].toolSchemaHash;
  assert.equal(compareRuns(run(), missing).conclusion, 'insufficient');
  const mixed = run(); mixed.trials[0].toolSchemaHash = hash('different');
  assert.equal(compareRuns(run(), mixed).conclusion, 'incompatible');
});
test('legacy aggregate-answer runs and partial runtime evidence cannot establish a QASPER quality comparison', () => {
  const a = run(), b = run(); delete a.manifest.applicationContract; delete b.manifest.applicationContract;
  assert.deepEqual(compareRuns(a, b), { conclusion: 'insufficient', reason: 'application_runtime_evidence_missing' });
  const missing = run(); delete missing.trials[0].runtimeVerification;
  assert.deepEqual(compareRuns(run(), missing), { conclusion: 'insufficient', reason: 'application_runtime_evidence_missing' });
  const drift = run(); drift.manifest.applicationContract = { ...applicationContract, answerBoundary: 'aggregate-output' };
  assert.deepEqual(compareRuns(run(), drift).mismatches, ['applicationContract']);
});
test('versioned response requirements preserve legacy comparisons and reject missing, unknown or mixed contracts', () => {
  const withContract = contract => {
    const result = run();
    result.manifest.applicationContract = contract;
    result.trials.forEach(trial => { trial.runtimeVerification.contractHash = hash(contract); });
    return result;
  };
  const legacy = { schemaVersion: 1, runtime: 'roc-agent-plugin-deep-agent',
    answerBoundary: 'final-checkpoint-assistant-bound-to-terminal-model-response',
    verification: 'sqlite-transport-workspace-process-v1' };
  assert.equal(compareRuns(withContract(legacy), withContract(legacy)).conclusion, 'non-inferior');
  assert.deepEqual(compareRuns(withContract(legacy), run()).mismatches, ['applicationContract']);
  const { responseRequirements, ...missingRequirements } = applicationContract;
  for (const contract of [
    missingRequirements, { ...applicationContract, responseRequirements: 'unrecognized-requirements' },
    { ...applicationContract, schemaVersion: 3 }
  ]) {
    assert.deepEqual(compareRuns(withContract(contract), withContract(contract)),
      { conclusion: 'insufficient', reason: 'application_runtime_evidence_missing' });
  }
  const mismatchedReceipt = run();
  mismatchedReceipt.trials[0].runtimeVerification.contractHash = hash(legacy);
  assert.deepEqual(compareRuns(run(), mismatchedReceipt),
    { conclusion: 'insufficient', reason: 'application_runtime_evidence_missing' });
});
test('fixture runner seals actual tool schemas across independent task workspaces without a live provider', async () => {
  const dataset = join(root, 'schema-dataset'); mkdirSync(dataset);
  const tasks = importQasper(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, paper(`q${i}`)])))
    .filter(t => t.split === 'development').slice(0, 2);
  assert.equal(tasks.length, 2);
  writeJson(join(dataset, 'tasks.json'), tasks);
  const suite = 'qasper', provenance = { kind: 'synthetic-schema-test' }, inventory = fileInventory(dataset);
  writeJson(join(dataset, 'dataset.json'), { suite, provenance, inventory, identity: hash({ suite, provenance, inventory }) });
  const result = await runBenchmark({ suite, profile: 'fast', dataset, fixture: true, outputRoot: join(root, 'runs') });
  assert.equal(result.status, 'complete', JSON.stringify(result.fatal));
  assert.equal(result.usage.requests, 4);
  const sealed = inspectRun(result.directory);
  assert.equal(new Set(sealed.trials.map(t => t.toolSchemaHash)).size, 1);
  for (const trial of sealed.trials) assert.match(trial.toolSchemaHash, /^[a-f0-9]{64}$/);
  assert.equal(compareRuns(sealed, sealed).conclusion, 'insufficient');
});
test('invalid trials, unattempted trials and empty selections are visible and incomplete', () => {
  const sample = run(); sample.trials.pop(); sample.trials[0] = { ...sample.trials[0], metrics: null, failureClass: 'provider' };
  const summary = summarize(sample.manifest, sample.trials);
  assert.equal(summary.status, 'incomplete'); assert.equal(summary.unattempted, 1); assert.equal(summary.invalid, 1);
  assert.equal(summarize({ ...sample.manifest, selection: [] }, []).status, 'incomplete');
});
test('evidence seals reject edits and symlinks', () => {
  const path = join(root, 'sealed'); mkdirSync(path); const sample = run();
  writeJson(join(path, 'manifest.json'), sample.manifest); writeJson(join(path, 'trials.json'), sample.trials); sealRun(path, sample.summary);
  assert.equal(inspectRun(path).summary.status, 'complete');
  writeFileSync(join(path, 'trials.json'), '[]'); assert.throws(() => inspectRun(path), /evidence_changed/);
  symlinkSync(join(path, 'trials.json'), join(path, 'link')); assert.throws(() => fileInventory(path), /link_or_special/);
});
test('native isolation-fixture links are retained as metadata without reading their targets', () => {
  const source = join(root, 'native-source'), target = join(root, 'native-snapshot'); mkdirSync(source);
  writeFileSync(join(source, 'report.json'), '{}');
  symlinkSync('/unavailable/hidden-file', join(source, 'fixture-link'));
  assert.deepEqual(snapshotNativeEvidence(source, target), [{ path: 'fixture-link', target: '/unavailable/hidden-file' }]);
  assert.deepEqual(fileInventory(target).map(f => f.path), ['report.json']);
});
const config = () => ({ model: 'model', temperature: 0, ...validateProviderOptions({
   maxInputBytes: 1024, requestTimeoutMs: 1000, taskTimeoutMs: 5000 }) });
const body = { model: 'model', stream: false, max_tokens: 4096, temperature: 0, messages: [] };
const response = { choices: [{ message: { role: 'assistant', content: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
test('provider records requests before dispatch and permits repeated calls', async () => {
  const events = []; let calls = 0;
  const provider = createProvider(config(), e => events.push(e), { complete: async () => {
    assert.equal(events.at(-1).type, 'provider_admitted'); calls++; return response;
  } });
  await provider.complete(body, new AbortController().signal);
  await provider.complete(body, new AbortController().signal);
  assert.equal(calls, 2); assert.deepEqual(provider.snapshot(), { requests: 2, inputTokens: 20, outputTokens: 20 });
  assert.equal(JSON.stringify(events).includes('test-only'), false);
});
test('transport failure remains visible and bad binding prevents dispatch', async () => {
  let calls = 0;
  const provider = createProvider(config(), () => {}, { complete: async () => { calls++; throw new Error('secret server details'); } });
  await assert.rejects(provider.complete({ ...body, model: 'wrong' }, new AbortController().signal), /binding_changed/);
  assert.equal(calls, 0);
  await assert.rejects(provider.complete(body, new AbortController().signal), /transport_failed/);
  assert.deepEqual(provider.snapshot(), { requests: 1, inputTokens: 0, outputTokens: 0 });
  await assert.rejects(provider.complete(body, new AbortController().signal), /transport_failed/);
  assert.equal(calls, 2);
  assert.throws(() => validateProviderOptions({ apiKey: 'test-only' }));
});
test('Science verifier rejects absent/corrupt reward and independently scores both outcomes', () => {
  assert.equal(parseScienceGrade('{"success":true,"evidence":"arrays match"}').metrics.successRate, 1);
  assert.equal(parseScienceGrade('{"success":false,"evidence":"wrong predictions"}').metrics.successRate, 0);
  for (const invalid of ['', '{}', '{"success":1,"evidence":"x"}', '{"success":true,"evidence":""}']) assert.throws(() => parseScienceGrade(invalid), /science_grade/);

});
test('Science import freezes verified metadata/data and missing output fails before grader execution', async () => {
  const { source, recipe, path, dataset } = await scienceFixture(root);
  assert.equal(dataset.tasks.length, 1); assert.equal(JSON.stringify(dataset.tasks[0].visible).includes('hidden data'), false);
  const trial = join(source, 'trial'), workspace = join(source, 'workspace'); mkdirSync(trial); mkdirSync(workspace);
  assert.equal((await gradeScience(dataset, dataset.tasks[0], workspace, trial, new AbortController().signal)).reason, 'required_output_missing');
  assert.throws(() => scienceRecipeSchema.parse({ ...recipe, tasks: [{ ...recipe.tasks[0], outputFiles: ['../truth'] }] }));
  assert.throws(() => scienceRecipeSchema.parse({ ...recipe, tasks: [{ ...recipe.tasks[0], outputFiles: ['solution.py'] }] }));
  const changed = join(source, 'copied-cache'); cpSync(path, changed, { recursive: true }); writeFileSync(join(changed, 'assets/1/publicDir/input.csv'), 'tampered'); assert.throws(() => loadDataset(changed), /integrity_failed/);
});
