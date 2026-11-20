import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';

import { executeApplication, prepareApplication } from '../lib/application.mjs';
import { verifyApplicationEvidence } from '../lib/application-verifier.mjs';
import { fixtureCompletion, fixtureConfig } from '../lib/fixture.mjs';
import { gradeQasper, importQasper, qasperInput } from '../lib/qasper.mjs';
import { withQasperResponseContract } from '../lib/response-contract.mjs';
import { hash, sha256 } from '../lib/common.mjs';
import { testArtifacts } from './test-artifacts.mjs';

const root = testArtifacts('response-contract-application');
const artifact = await prepareApplication(root);
const [task] = importQasper({ paper: { title: 'Visible paper', abstract: 'Visible source.', full_text: [],
  qas: [{ question_id: 'missing', question: 'Which missing result is reported?', answers: [{ answer: {
    unanswerable: true, extractive_spans: [], free_form_answer: '', yes_no: null, evidence: []
  } }] }] } });
const input = withQasperResponseContract(qasperInput(task));
const valid = '{"answer":"Unanswerable","evidence":[]}';
const narration = 'Reading the supplied paper.';
const jsonl = path => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
const trial = name => { const path = join(root, name); mkdirSync(path); return path; };
function persisted(path) {
  const db = new Database(join(path, 'worker/agent.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const run = db.prepare('SELECT * FROM agent_runs').get();
    const checkpoint = db.prepare("SELECT checkpoint_blob FROM langgraph_checkpoints WHERE checkpoint_ns='' ORDER BY checkpoint_id DESC LIMIT 1").get();
    return {
      run, snapshot: JSON.parse(run.snapshot_json), checkpoint: JSON.parse(checkpoint.checkpoint_blob.toString()),
      report: JSON.parse(db.prepare('SELECT report_json FROM agent_task_contracts').pluck().get()),
      calls: db.prepare("SELECT * FROM agent_calls WHERE kind='model' ORDER BY rowid").all()
    };
  } finally { db.close(); }
}
const badOutputs = {
  preface: `Here is the JSON:\n${valid}`,
  fence: `\`\`\`json\n${valid}\n\`\`\``,
  missing: '{"answer":"Unanswerable"}',
  citation: '{"answer":"Unanswerable","evidence":["p999"]}',
  duplicate: '{"answer":"Unanswerable","evidence":["p0","p0"]}'
};
for (const [name, invalid] of Object.entries(badOutputs)) {
  test(`real Roc graph corrects ${name} once while retaining raw responses, usage and checkpoint history`, async () => {
    const path = trial(name), requests = [];
    const result = await executeApplication({
      artifact, input, directory: path, config: fixtureConfig, signal: new AbortController().signal, record: () => {},
      complete: body => {
        requests.push(body);
        const response = fixtureCompletion(body);
        response.choices[0].message.content = requests.length === 1 ? narration : requests.length === 2 ? invalid : valid;
        return response;
      }
    });
    assert.equal(result.requests, 3); assert.equal(requests.length, 3);
    assert.equal(result.output, valid);
    assert.equal(result.runtimeVerification.status, 'verified');
    assert.deepEqual(gradeQasper(task, result.output).metrics, { answerF1: 1, evidenceF1: 1, citationValidity: 1 });
    assert.ok(requests[2].messages.some(message => message.role === 'assistant' && message.content === invalid));
    const feedback = requests[2].messages.filter(message => message.role === 'user'
      && message.content.startsWith('Your final response failed the user-provided response contract:'));
    assert.equal(feedback.length, 1);
    assert.match(feedback[0].content, /This is the only format correction/);
    for (const request of requests) {
      assert.deepEqual(request.tools.map(tool => tool.function.name).sort(), ['ls', 'read_file']);
      assert.equal(hash(request.tools), result.toolSchemaHash);
      const system = request.messages.filter(message => message.role === 'system').map(message =>
        typeof message.content === 'string' ? message.content : message.content.map(block => block.text).join('\n')).join('\n');
      assert.equal(system.includes('## `write_todos`'), false);
      assert.equal(system.includes('edit_file'), false);
      assert.match(system, /Identify the requested answer unit/);
      const taskContract = JSON.parse(system.split('\n').find(line => line.startsWith('{"contractVersion":')));
      assert.deepEqual(taskContract.responseContract, input.responseContract);
      const ls = request.tools.find(tool => tool.function.name === 'ls');
      assert.match(ls.function.description, /read that file directly/);
    }
    const state = persisted(path);
    assert.equal(state.run.status, 'completed');
    assert.equal(state.snapshot.taskContract.kind, 'reply');
    assert.deepEqual(state.snapshot.taskContract.responseContract, input.responseContract);
    assert.deepEqual(state.checkpoint.channel_values.rocResponseCorrection, { runId: state.run.id, attempts: 1 });
    assert.equal(state.checkpoint.channel_values.messages.at(-1).kwargs.content, valid);
    assert.ok(state.checkpoint.channel_values.messages.some(message => message.kwargs.content === invalid));
    assert.equal(state.checkpoint.channel_values.messages.filter(message => message.kwargs.id === `roc-response-correction:${state.run.id}`).length, 1);
    assert.equal(state.calls.length, 3);
    assert.ok(state.calls.every(call => call.state === 'settled' && call.actual_tokens === 120));
    assert.equal(state.report.status, 'satisfied');
    assert.equal(state.report.criteria[0].verifier, 'response_json_schema');
    assert.equal(state.report.criteria[0].artifactRefs[0].sha256, sha256(valid));
    assert.equal(JSON.parse(readFileSync(join(path, 'output.json'))).output, narration + invalid + valid);
    assert.equal(jsonl(join(path, 'responses.jsonl'))[1].body.choices[0].message.content, invalid);
  });
}

for (const name of ['preface', 'fence', 'citation']) {
  test(`exhausted ${name} correction completes generation with failed acceptance and the native bad answer`, async () => {
    const path = trial(`exhausted-${name}`), invalid = badOutputs[name], requests = [];
    const result = await executeApplication({
      artifact, input, directory: path, config: fixtureConfig, signal: new AbortController().signal, record: () => {},
      complete: body => {
        requests.push(body);
        const response = fixtureCompletion(body);
        response.choices[0].message.content = requests.length === 1 ? narration : invalid;
        return response;
      }
    });
    assert.equal(requests.length, 3);
    assert.equal(result.output, invalid);
    assert.equal(result.runtimeVerification.status, 'verified');
    const state = persisted(path);
    assert.equal(state.run.status, 'completed');
    assert.notEqual(state.report.status, 'satisfied');
    assert.equal(state.report.criteria[0].verdict, 'failed');
    assert.equal(state.report.criteria[0].artifactRefs[0].sha256, sha256(invalid));
    assert.equal(state.checkpoint.channel_values.messages.filter(message => message.kwargs.id === `roc-response-correction:${state.run.id}`).length, 1);
    assert.equal(state.checkpoint.channel_values.messages.at(-1).kwargs.content, invalid);
    const grade = gradeQasper(task, result.output);
    assert.equal(grade.metrics.citationValidity, 0);
    if (name !== 'citation') {
      assert.equal(grade.reason, 'output_not_json');
      assert.deepEqual(grade.metrics, { answerF1: 0, evidenceF1: 0, citationValidity: 0 });
    }
    const acceptance = jsonl(join(path, 'transcript.jsonl')).find(row => row.event?.type === 'task_acceptance');
    assert.equal(acceptance.event.report.criteria[0].verdict, 'failed');
  });
}

test('independent runtime verifier rejects response schema drift in frozen task inputs', async () => {
  const path = trial('schema-drift');
  const result = await executeApplication({ artifact, input, directory: path, config: fixtureConfig,
    signal: new AbortController().signal, record: () => {}, complete: fixtureCompletion });
  const db = new Database(join(path, 'worker/agent.sqlite'));
  const run = db.prepare('SELECT id, snapshot_json FROM agent_runs').get();
  try {
    const snapshot = JSON.parse(run.snapshot_json);
    snapshot.taskContract.responseContract.schema.properties.answer.minLength = 2;
    db.prepare('UPDATE agent_runs SET snapshot_json=? WHERE id=?').run(JSON.stringify(snapshot), run.id);
  } finally { db.close(); }
  const args = { artifact, input, directory: path, config: fixtureConfig, requests: result.requests, toolSchemaHash: result.toolSchemaHash };
  const rejected = verifyApplicationEvidence(args);
  assert.equal(rejected.status, 'invalid');
  assert.ok(rejected.checks.some(check => check.id === 'frozen-inputs' && !check.passed));
  const restored = new Database(join(path, 'worker/agent.sqlite'));
  try { restored.prepare('UPDATE agent_runs SET snapshot_json=? WHERE id=?').run(run.snapshot_json, run.id); }
  finally { restored.close(); }
  assert.equal(verifyApplicationEvidence(args).status, 'verified');
});

test('cancellation during correction dispatch stops the worker and confirms cleanup', async () => {
  const path = trial('cancel-correction'), controller = new AbortController(); let requests = 0;
  await assert.rejects(executeApplication({
    artifact, input, directory: path, config: fixtureConfig, signal: controller.signal, record: () => {},
    complete: body => {
      requests++;
      if (requests === 3) controller.abort();
      const response = fixtureCompletion(body);
      response.choices[0].message.content = requests === 1 ? narration : badOutputs.preface;
      return response;
    }
  }), /run_cancelled/);
  assert.equal(requests, 3);
  assert.equal(JSON.parse(readFileSync(join(path, 'cleanup.json'))).processGroupGone, true);
});
