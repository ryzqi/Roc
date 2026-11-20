import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileInventory, hash, readJson, ROOT, sha256, writeJson } from '../lib/common.mjs';
import { importQasper } from '../lib/qasper.mjs';
import { inspectRun } from '../lib/report.mjs';
import { readEvents } from '../lib/lifecycle.mjs';
import { inspectResumable } from '../lib/execution.mjs';
import { testArtifacts } from './test-artifacts.mjs';

const root = testArtifacts('runner-recovery');
const dataset = join(root, 'dataset');
mkdirSync(dataset);
const tasks = importQasper(Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
  `paper-${index}`, {
    title: 'Frozen recovery paper', abstract: 'Recovery fixture', full_text: [
      { section_name: 'Results', paragraphs: ['The observed yield was 42 units.'] }
    ],
    qas: [{ question_id: `question-${index}`, question: 'What was the observed yield?', answers: [{
      answer: { unanswerable: false, extractive_spans: ['42 units'], free_form_answer: '', yes_no: null,
        evidence: ['The observed yield was 42 units.'] }
    }] }]
  }
]))).filter(task => task.split === 'development').slice(0, 1);
assert.equal(tasks.length, 1);
writeJson(join(dataset, 'tasks.json'), tasks);
const provenance = { kind: 'synthetic-recovery-test' }, suite = 'qasper', inventory = fileInventory(dataset);
writeJson(join(dataset, 'dataset.json'), { suite, provenance, inventory, identity: hash({ suite, provenance, inventory }) });

function cli(args) {
  const child = spawnSync(process.execPath, ['evaluation/lib/cli.mjs', ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' }
  });
  assert.equal(child.error, undefined, child.error?.message);
  return child;
}
function output(child) {
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}
const finalized = ['seal.json', 'summary.json', 'trials.json', 'report.md'];
const bytesHash = path => sha256(readFileSync(path));
const replayEvents = new Set(['worker_started', 'model_request', 'budget_dispatched', 'execution_requested']);

test('actual fixture runs recover committed and orphan grades without replay or evidence mutation', async t => {
  const seed = output(cli(['run', '--suite', suite, '--profile', 'smoke', '--dataset', dataset,
    '--fixture', '--output-root', join(root, 'runs')]));
  assert.equal(seed.status, 'complete');
  const run = seed.directory, manifest = readJson(join(run, 'manifest.json'));
  assert.equal(manifest.evidence, 'fixture');
  assert.equal(manifest.qasperQualification.status, 'unverified');
  assert.equal(manifest.qasperQualification.kind, 'locked-official-qasper-adaptation');
  const { hash: qualificationHash, ...qualificationPayload } = manifest.qasperQualification;
  assert.equal(qualificationHash, hash(qualificationPayload));
  const [trial] = readJson(join(run, 'run-plan.json')).trials, trialDirectory = join(run, trial.trialId);
  const originalEvents = readEvents(join(run, 'events.jsonl'));
  const rootSnapshot = new Map(readdirSync(run).filter(name => !finalized.includes(name)
    && !name.startsWith('trial-')).map(name => [name, readFileSync(join(run, name))]));
  const gradePath = join(trialDirectory, 'grade.json'), trialSealPath = join(trialDirectory, 'trial-evidence.json');
  const originalGrade = readFileSync(gradePath), originalTrialSeal = readFileSync(trialSealPath);
  const checkpointPath = join(trialDirectory, 'worker/agent.sqlite'), checkpointHash = bytesHash(checkpointPath);
  const last = state => originalEvents.findIndex(event => event.type === 'trial_state' && event.to === state);
  assert.ok(last('verified') > 0 && last('graded') > last('verified'));

  function simulateCrash(state, { removeTrialSeal = false } = {}) {
    // This is a task-owned fixture. Keep the real workspace path and inode: the
    // production verifier deliberately rejects relocated checkpoint evidence.
    for (const name of readdirSync(run).filter(name => finalized.includes(name) || name.startsWith('resume-claim-'))) {
      unlinkSync(join(run, name));
    }
    for (const [name, bytes] of rootSnapshot) writeFileSync(join(run, name), bytes);
    writeFileSync(gradePath, originalGrade);
    writeFileSync(trialSealPath, originalTrialSeal);
    if (removeTrialSeal) unlinkSync(trialSealPath);
    const events = originalEvents.slice(0, last(state) + 1);
    writeFileSync(join(run, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
    return events;
  }

  for (const scenario of [
    { name: 'committed grade', state: 'graded' },
    { name: 'orphan grade with final trial seal', state: 'verified' },
    { name: 'orphan grade before final trial seal', state: 'verified', removeTrialSeal: true }
  ]) {
    await t.test(scenario.name, () => {
      const previous = simulateCrash(scenario.state, scenario);
      const result = output(cli(['run', '--resume', run]));
      assert.equal(result.status, 'complete', JSON.stringify(result.fatal));
      const sealed = inspectRun(run), appended = readEvents(join(run, 'events.jsonl')).slice(previous.length);
      assert.equal(sealed.manifest.evidence, 'fixture');
      assert.deepEqual(sealed.manifest.qasperQualification, manifest.qasperQualification);
      assert.equal(sealed.trials.length, 1);
      assert.equal(appended.some(event => replayEvents.has(event.type)), false);
      assert.equal(appended.filter(event => event.type === 'recovery_evidence_verified').length, 1);
      assert.deepEqual(readFileSync(gradePath), originalGrade);
      assert.deepEqual(readFileSync(trialSealPath), originalTrialSeal);
      assert.equal(bytesHash(checkpointPath), checkpointHash);
      assert.equal(sealed.summary.usage.requests, seed.usage.requests);
    });
  }

  await t.test('tampered committed grade is rejected before journal/owner mutation', () => {
    simulateCrash('graded');
    const before = bytesHash(join(run, 'events.jsonl')), owner = bytesHash(join(run, 'execution-owner.json'));
    const grade = readJson(gradePath); grade.metrics.answerF1 = .75;
    writeFileSync(gradePath, JSON.stringify(grade) + '\n');
    const child = cli(['run', '--resume', run]);
    assert.equal(child.status, 2);
    assert.match(child.stderr, /trial_evidence_changed/);
    assert.equal(bytesHash(join(run, 'events.jsonl')), before);
    assert.equal(bytesHash(join(run, 'execution-owner.json')), owner);
    assert.equal(existsSync(join(run, 'seal.json')), false);
  });

  function stagedRun(name, dispatched, qualificationChange = null) {
    const destination = join(root, name);
    mkdirSync(destination);
    const prepare = `
      import {readJson,writeJson,journal,hash} from './evaluation/lib/common.mjs';
      import {openExecution,withinTrial} from './evaluation/lib/execution.mjs';
      import {mkdirSync,writeFileSync} from 'node:fs';
      import {join} from 'node:path';
      const [destination,seed,dispatch,qualificationChange] = process.argv.slice(1);
      const manifest = readJson(join(seed,'manifest.json'));
      if(qualificationChange==='missing') delete manifest.qasperQualification;
      if(qualificationChange==='schema') manifest.qasperQualification.schemaVersion=2;
      if(qualificationChange==='source-lock') manifest.qasperQualification.sourceContract.sourceLockSha256=hash('self-declared-lock');
      if(qualificationChange==='derivation') manifest.qasperQualification.sourceContract.derivation.files[0].sha256=hash('self-declared-derivation');
      if(manifest.qasperQualification){
        const {hash:omitted,...payload}=manifest.qasperQualification;
        manifest.qasperQualification={...payload,hash:hash(payload)};
      }
      writeJson(join(destination,'manifest.json'),manifest);
      writeJson(join(destination,'worker.json'),readJson(join(seed,'worker.json')));
      const events = journal(join(destination,'events.jsonl'));
      events.append({type:'run_started',suite:manifest.suite,profile:manifest.profile,startedAtMs:Date.now()});
      const execution = openExecution(destination,manifest,events), [trial] = execution.plan.trials;
      mkdirSync(join(destination,trial.trialId));
      writeFileSync(join(destination,trial.trialId,'owned-staging.txt'),'proven undispatched staging');
      await withinTrial(execution,trial,new AbortController().signal,async()=>{
        if(dispatch==='true'){
          execution.lifecycle.transition(trial,'dispatched');
          const binding={trialId:trial.trialId,requestId:'uncertain-request',requestHash:hash({request:'owned-test'})};
          execution.budget.reserve({...binding,kind:'chat',providerId:'evaluation-host',model:manifest.provider.model,inputTokens:1,outputTokens:1});
          execution.budget.dispatch(binding.requestId,binding);
        }
      });
      events.close();
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', prepare, destination, run,
      String(dispatched), String(qualificationChange)], {
      cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    return destination;
  }

  for (const change of ['missing', 'schema', 'source-lock', 'derivation']) {
    await t.test(`resume rejects ${change} QASPER qualification before journal, owner or budget mutation`, () => {
      const path = stagedRun(`qualification-${change}`, false, change), before = fileInventory(path);
      const child = cli(['run', '--resume', path]);
      assert.equal(child.status, 2);
      assert.match(child.stderr, /resume_qasper_qualification_changed/);
      assert.deepEqual(fileInventory(path), before);
      assert.equal(existsSync(join(path, 'seal.json')), false);
    });
  }

  await t.test('uncertain durable provider dispatch is rejected without replay or ledger mutation', () => {
    const path = stagedRun('uncertain-dispatch', true), inspected = inspectResumable(path);
    assert.equal(inspected.events.some(event => event.type === 'budget_dispatched'), true);
    const before = bytesHash(join(path, 'events.jsonl')), budget = bytesHash(join(path, 'budget-state.json'));
    const child = cli(['run', '--resume', path]);
    assert.equal(child.status, 2);
    assert.match(child.stderr, /ENOENT|trial_seal_invalid|resume_application_evidence_invalid/);
    assert.equal(bytesHash(join(path, 'events.jsonl')), before);
    assert.equal(bytesHash(join(path, 'budget-state.json')), budget);
    assert.equal(existsSync(join(path, 'seal.json')), false);
  });

  await t.test('proven undispatched staging is discarded once and the real fixture trial can finish', () => {
    const path = stagedRun('undispatched', false);
    const result = output(cli(['run', '--resume', path]));
    assert.equal(result.status, 'complete', JSON.stringify(result.fatal));
    const sealed = inspectRun(path), events = readEvents(join(path, 'events.jsonl'));
    assert.equal(sealed.manifest.source.sourceHash, manifest.source.sourceHash);
    assert.equal(sealed.trials.length, 1);
    assert.equal(events.filter(event => event.type === 'undispatched_staging_discarded').length, 1);
    assert.equal(events.filter(event => event.type === 'worker_started').length, 1);
    assert.equal(events.filter(event => event.type === 'model_request').length, 2);
    assert.equal(existsSync(join(path, sealed.trials[0].trialId, 'owned-staging.txt')), false);
    assert.equal(sealed.summary.usage.requests, 2);
  });
});
