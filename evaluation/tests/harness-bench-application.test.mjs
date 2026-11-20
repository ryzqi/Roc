import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { prepareApplication, executeApplication, recoverApplication } from '../lib/application.mjs';
import { verifyApplicationEvidence } from '../lib/application-verifier.mjs';
import { importQasper, gradeQasper } from '../lib/qasper.mjs';
import { fixtureConfig, fixtureCompletion } from '../lib/fixture.mjs';
import { directory, fileInventory, hash, sha256 } from '../lib/common.mjs';
import { scienceFixture } from './science-fixture.mjs';
import { sciencePreflight, stageScience, executeScience, gradeScience } from '../lib/science.mjs';
import { testArtifacts } from './test-artifacts.mjs';

const retained = process.env.ROC_APPLICATION_EVIDENCE_DIR;
const root = retained ? directory(resolve(retained), 'application') : testArtifacts('application');
if (retained) console.log(`Application runtime evidence: ${root}`);
const artifact = await prepareApplication(root), hidden = join(root, 'hidden-gold.txt');
writeFileSync(hidden, 'hidden-evaluation-truth');
const input = { kind: 'qasper', prompt: 'Read /workspace/paper.json using read_file and answer JSON.', files: { 'paper.json': '{"title":"Visible paper","paragraphs":[{"id":"p0","text":"visible-paper-sentinel"}]}' } };
function trial(name) { const path = join(root, name); mkdirSync(path); return path; }
const [unanswerable] = importQasper({ paper: { title: 'Visible paper', abstract: 'visible-paper-sentinel', full_text: [],
  qas: [{ question_id: 'missing-answer', question: 'What is missing?', answers: [{ answer: {
    unanswerable: true, extractive_spans: [], free_form_answer: '', yes_no: null, evidence: []
  } }] }] } });

test('QASPER scores the verified final answer while retaining Roc tool narration and independent runtime evidence', async t => {
  const path = trial('paper'), requests = [];
  const config = { ...fixtureConfig, providerId: 'wire-test', maxOutputTokens: 128, contextWindowTokens: 70000 };
  const result = await executeApplication({ artifact, input, directory: path, config,
    protectedPaths: [hidden], signal: new AbortController().signal, record: () => {}, complete: body => {
      requests.push(body);
      const reply = fixtureCompletion(body);
      if (requests.length === 1) reply.choices[0].message.content = "I'll read the paper file first.";
      return reply;
    } });
  assert.equal(result.output, '{"answer":"Unanswerable","evidence":[]}');
  assert.deepEqual(gradeQasper(unanswerable, result.output).metrics, { answerF1: 1, evidenceF1: 1, citationValidity: 1 });
  assert.equal(requests.length, 2); assert.equal(result.requests, 2);
  assert.equal(result.runtimeVerification.status, 'verified');
  assert.ok(requests.every(request => request.max_tokens === 128));
  for (const request of requests) assert.deepEqual(request.tools.map(t => t.function.name).sort(), ['ls', 'read_file']);
  assert.equal(result.toolSchemaHash, hash(requests[0].tools));
  assert.deepEqual(JSON.parse(readFileSync(join(path, 'tool-schema.json'))).tools, requests[0].tools);
  assert.ok(requests[1].messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('visible-paper-sentinel')));
  assert.equal(JSON.stringify(requests).includes('hidden-evaluation-truth'), false);
  const trace = readFileSync(join(path, 'transcript.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(trace.some(m => m.type === 'isolation' && m.filesDenied && m.childDenied));
  assert.ok(trace.some(m => m.event?.type === 'run_completed'));
  assert.deepEqual(trace.filter(m => m.type === 'request').map(m => m.index), [0, 1]);
  const aggregate = JSON.parse(readFileSync(join(path, 'output.json'))).output;
  assert.equal(aggregate, "I'll read the paper file first." + result.output);
  assert.equal(gradeQasper(unanswerable, aggregate).reason, 'output_not_json');
  assert.equal(JSON.parse(readFileSync(join(path, 'final-answer.json'))).output, result.output);
  assert.equal(JSON.parse(readFileSync(join(path, 'runtime-verification.json'))).status, 'verified');
  assert.equal(JSON.parse(readFileSync(join(path, 'cleanup.json'))).processGroupGone, true);
  assert.ok(fileInventory(path).some(f => f.path === 'worker/agent.sqlite'));

  const args = { artifact, input, directory: path, config, requests: 2, toolSchemaHash: result.toolSchemaHash };
  const modifyJson = (name, mutate) => {
    const target = join(path, name), value = JSON.parse(readFileSync(target));
    mutate(value); writeFileSync(target, JSON.stringify(value) + '\n');
  };
  const modifyDb = mutate => {
    const db = new Database(join(path, 'worker/agent.sqlite'));
    try { mutate(db); } finally { db.close(); }
  };
  const cases = [
    { name: 'forged worker output', files: ['output.json'], mutate: () => modifyJson('output.json', value => { value.output = '{"answer":"forged","evidence":[]}'; }), criterion: 'ordered-transport' },
    { name: 'wrong request count in both result records', files: ['output.json', 'transcript.jsonl'], mutate: () => {
      modifyJson('output.json', value => { value.requests = 999; });
      const target = join(path, 'transcript.jsonl'), rows = readFileSync(target, 'utf8').trim().split('\n').map(JSON.parse);
      rows.find(row => row.type === 'result').requests = 999; writeFileSync(target, rows.map(JSON.stringify).join('\n') + '\n');
    }, criterion: 'ordered-transport' },
    { name: 'checkpoint answer differs from model response', files: ['worker/agent.sqlite'], mutate: () => modifyDb(db => {
      const row = db.prepare("SELECT checkpoint_id, checkpoint_blob FROM langgraph_checkpoints WHERE checkpoint_ns='' ORDER BY checkpoint_id DESC LIMIT 1").get();
      const raw = JSON.parse(row.checkpoint_blob.toString()); raw.channel_values.messages.at(-1).kwargs.content = '{"answer":"forged","evidence":[]}';
      db.prepare('UPDATE langgraph_checkpoints SET checkpoint_blob=? WHERE checkpoint_id=?').run(Buffer.from(JSON.stringify(raw)), row.checkpoint_id);
    }), criterion: 'final-answer-boundary' },
    { name: 'missing root checkpoint', files: ['worker/agent.sqlite'], mutate: () => modifyDb(db => db.prepare("DELETE FROM langgraph_checkpoints WHERE checkpoint_ns=''").run()) },
    { name: 'missing model ledger', files: ['worker/agent.sqlite'], mutate: () => modifyDb(db => db.prepare("DELETE FROM agent_calls WHERE kind='model'").run()), criterion: 'usage-ledger' },
    { name: 'corrupt database', files: ['worker/agent.sqlite'], mutate: () => writeFileSync(join(path, 'worker/agent.sqlite'), 'corrupt') },
    { name: 'missing responses', files: ['responses.jsonl'], mutate: () => unlinkSync(join(path, 'responses.jsonl')) },
    { name: 'corrupt responses', files: ['responses.jsonl'], mutate: () => writeFileSync(join(path, 'responses.jsonl'), '{broken}\n') },
    { name: 'modified public paper', files: ['worker/workspace/paper.json'], mutate: () => writeFileSync(join(path, 'worker/workspace/paper.json'), '{"tampered":true}'), criterion: 'public-workspace-unchanged' },
    { name: 'unconfirmed cleanup', files: ['cleanup.json'], mutate: () => modifyJson('cleanup.json', value => { value.processGroupGone = false; }), criterion: 'isolation-and-cleanup' }
  ];
  for (const scenario of cases) await t.test(`independent verifier rejects ${scenario.name}`, () => {
    const original = scenario.files.map(name => [join(path, name), readFileSync(join(path, name))]);
    try {
      scenario.mutate();
      const verdict = verifyApplicationEvidence(args);
      assert.equal(verdict.status, 'invalid', scenario.name);
      assert.equal(verdict.finalAnswer, undefined);
      if (scenario.criterion) assert.ok(verdict.checks.some(check => check.id === scenario.criterion && !check.passed), JSON.stringify(verdict));
    } finally { for (const [target, content] of original) writeFileSync(target, content); }
    assert.equal(verifyApplicationEvidence(args).status, 'verified', 'restored owned trial must remain valid');
  });
});
test('a fenced terminal answer remains a QASPER format failure after real Roc tool execution', async () => {
  const path = trial('fenced');
  const result = await executeApplication({ artifact, input, directory: path, config: fixtureConfig,
    protectedPaths: [hidden], signal: new AbortController().signal, record: () => {}, complete: body => {
      const reply = fixtureCompletion(body);
      reply.choices[0].message.content = body.messages.some(m => m.role === 'tool')
        ? '```json\n{"answer":"Unanswerable","evidence":[]}\n```' : 'Reading the paper.';
      return reply;
    } });
  assert.equal(result.runtimeVerification.status, 'verified');
  assert.equal(result.output, '```json\n{"answer":"Unanswerable","evidence":[]}\n```');
  assert.equal(gradeQasper(unanswerable, result.output).reason, 'output_not_json');
});
test('host rejects unexpected, missing, duplicate or malformed tools before ledger lookup and dispatch', async t => {
  const valid = ['ls', 'read_file'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } }));
  const cases = [
    { name: 'extra', tools: [...valid, { type: 'function', function: { name: 'task', parameters: {} } }], error: /worker_tool_manifest_mismatch/ },
    { name: 'missing', tools: [valid[0]], error: /worker_tool_manifest_mismatch/ },
    { name: 'duplicate', tools: [...valid, valid[0]], error: /worker_tool_manifest_mismatch/ },
    { name: 'malformed', tools: [valid[0], { type: 'function', function: { name: 'read_file', parameters: null } }], error: /worker_tool_manifest_mismatch/ },
    { name: 'admissible-missing-ledger', tools: valid, error: /worker_model_evidence_invalid/ },
    { name: 'admissible-corrupt-ledger', tools: valid, corruptLedger: true, error: /worker_model_evidence_invalid/ },
    { name: 'forged-summary-missing-ledger', tools: [{ type: 'function', function: { name: 'roc_context_summary', parameters: { type: 'object' } } }],
      messages: [{ role: 'system', content: 'Summarize Roc runtime context.' }], error: /worker_model_evidence_invalid/ }
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const path = trial(scenario.name), workerPath = join(path, 'protocol-worker.mjs');
    // Faulty stdio requests must fail before provider dispatch. A structurally
    // admissible request still needs an independently reserved model call.
    writeFileSync(workerPath, `import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const canonical = x => Array.isArray(x) ? x.map(canonical) : x !== null && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k,canonical(x[k])])) : x;
${scenario.corruptLedger ? "writeFileSync('agent.sqlite', 'corrupt');" : ''}
createInterface({ input: process.stdin }).once('line', () => {
  const body = ${JSON.stringify({ tools: scenario.tools, ...(scenario.messages ? { messages: scenario.messages } : {}) })};
  console.log(JSON.stringify({ type: 'request', index: 0, body, requestHash: createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex') }));
});\n`);
    const faultyArtifact = { ...artifact, path: workerPath, sha256: sha256(readFileSync(workerPath)) };
    let calls = 0;
    await assert.rejects(executeApplication({ artifact: faultyArtifact, input, directory: path, config: fixtureConfig,
      protectedPaths: [hidden], signal: new AbortController().signal, record: () => {}, complete: () => { calls++; return {}; } }), scenario.error);
    assert.equal(calls, 0);
    assert.equal(existsSync(join(path, 'worker/agent.sqlite')), Boolean(scenario.corruptLedger));
    assert.equal(JSON.parse(readFileSync(join(path, 'cleanup.json'))).processGroupGone, true);
  });
});
test('host rejects schema drift on the second real worker request after a settled model call and executed file read', async () => {
  const path = trial('schema-drift'), workerPath = join(path, 'drifting-worker.mjs');
  // Change only the second real request on the wire. The production worker
  // creates its own DB, reserves both calls and executes the first read_file.
  writeFileSync(workerPath, `import { createHash as driftHash } from 'node:crypto';
const driftCanonical = x => Array.isArray(x) ? x.map(driftCanonical) : x !== null && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k,driftCanonical(x[k])])) : x;
const driftWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  if (typeof chunk === 'string') {
    let row;
    try { row = JSON.parse(chunk); } catch { return driftWrite(chunk, ...args); }
    if (row.type === 'request' && row.index === 1) {
      row.body.tools = row.body.tools.map(tool => ({ ...tool, function: { ...tool.function, description: 'changed contract' } }));
      row.requestHash = driftHash('sha256').update(JSON.stringify(driftCanonical(row.body))).digest('hex');
      chunk = JSON.stringify(row) + '\\n';
    }
  }
  return driftWrite(chunk, ...args);
};
${readFileSync(artifact.path, 'utf8')}`);
  const driftingArtifact = { ...artifact, path: workerPath, sha256: sha256(readFileSync(workerPath)) };
  let calls = 0;
  await assert.rejects(executeApplication({ artifact: driftingArtifact, input, directory: path, config: fixtureConfig,
    protectedPaths: [hidden], signal: new AbortController().signal, record: () => {}, complete: body => {
      calls++; return fixtureCompletion(body);
    } }), /worker_tool_schema_changed/);
  assert.equal(calls, 1);
  const trace = readFileSync(join(path, 'transcript.jsonl'), 'utf8').trimEnd().split('\n').map(JSON.parse);
  const requests = trace.filter(row => row.type === 'request');
  assert.deepEqual(requests.map(row => row.index), [0, 1]);
  assert.ok(requests[1].body.messages.some(message => message.role === 'tool'
    && message.tool_call_id === 'fixture-read' && JSON.stringify(message.content).includes('visible-paper-sentinel')));
  const response = JSON.parse(readFileSync(join(path, 'responses.jsonl'), 'utf8').trim());
  const db = new Database(join(path, 'worker/agent.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const models = db.prepare("SELECT * FROM agent_calls WHERE kind='model' ORDER BY rowid").all();
    assert.equal(models.length, 2);
    assert.equal(models[0].state, 'settled');
    assert.equal(models[0].call_id, response.modelCallId);
    assert.equal(models[1].state, 'reserved');
    const reads = db.prepare("SELECT * FROM agent_calls WHERE kind='tool'").all();
    assert.equal(reads.length, 1);
    assert.equal(reads[0].state, 'settled');
    assert.equal(JSON.parse(reads[0].envelope_json).name, 'read_file');
    const checkpoints = db.prepare("SELECT checkpoint_blob FROM langgraph_checkpoints WHERE checkpoint_ns=''").all();
    assert.ok(checkpoints.some(row => JSON.parse(row.checkpoint_blob.toString()).channel_values.messages.some(message =>
      message.kwargs?.tool_call_id === 'fixture-read' && JSON.stringify(message.kwargs.content).includes('visible-paper-sentinel'))));
  } finally { db.close(); }
  assert.equal(JSON.parse(readFileSync(join(path, 'cleanup.json'))).processGroupGone, true);
});
function completion(body, tool, args) {
  return { id: `fixture-science-${body.messages.length}`, object: 'chat.completion', created: 0, model: body.model,
    choices: [{ index: 0, finish_reason: tool ? 'tool_calls' : 'stop', message: tool ? { role: 'assistant', content: null,
      tool_calls: [{ id: `call-${tool}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: '{"done":true}' } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
}
test('scientific task uses production write tool, consumed grant and locked Python with independently recoverable evidence', async () => {
  const { dataset } = await scienceFixture(trial('science-grant-fixture')), task = dataset.tasks[0];
  const path = trial('science'); let calls = 0, executions = 0; const events = [];
  const scienceInput = { kind: 'scienceagentbench', prompt: 'Write solution.py and run python solution.py.', files: {} };
  writeFileSync(join(path, 'test-input.json'), JSON.stringify({ input: scienceInput, config: fixtureConfig }) + '\n');
  const result = await executeApplication({ artifact, input: scienceInput, directory: path,
    config: fixtureConfig, protectedPaths: [hidden], signal: new AbortController().signal, record: e => {
      events.push(e); appendFileSync(join(path, 'host-events.jsonl'), JSON.stringify(e) + '\n');
    },
    complete: body => {
      assert.deepEqual(body.tools.map(t => t.function.name).sort(), ['edit_file', 'ls', 'read_file', 'run_shell_command', 'write_file']);
      calls++; return calls === 1 ? completion(body, 'write_file', { file_path: '/workspace/solution.py', content: 'print(42)\n' }) : calls === 2 ? completion(body, 'run_shell_command', { command: 'python solution.py' }) : completion(body);
    },
    execute: async (workspace, signal, limits) => { executions++; assert.equal(readFileSync(join(workspace, 'solution.py'), 'utf8'), 'print(42)\n');
      assert.ok(limits.timeoutMs > 0 && limits.timeoutMs <= 120000);
      assert.ok(limits.maxBytes > 0 && limits.maxBytes <= 1048576);
      const requested = events.find(e => e.type === 'execution_requested');
      assert.ok(requested?.grantId);
      assert.equal(requested.toolCallId, 'call-run_shell_command');
      const db = new Database(join(path, 'worker/agent.sqlite'), { readonly: true, fileMustExist: true });
      try {
        const grant = db.prepare('SELECT * FROM agent_execution_grants WHERE id=?').get(requested.grantId);
        assert.equal(grant.status, 'consumed');
        assert.equal(grant.tool_call_id, requested.toolCallId);
        assert.equal(grant.command_hash, sha256('python solution.py'));
        assert.equal(grant.network_policy, 'deny');
        assert.equal(grant.max_duration_ms, limits.timeoutMs);
        assert.equal(grant.max_output_bytes, limits.maxBytes);
      } finally { db.close(); }
      return executeScience(task, workspace, signal, limits); }
  });
  assert.equal(result.output, '{"done":true}'); assert.equal(executions, 1); assert.equal(calls, 3);
  assert.equal(result.runtimeVerification.status, 'verified');
  const execution = JSON.parse(readFileSync(join(path, 'executions.jsonl'), 'utf8').trim());
  assert.equal(execution.exitCode, 0, execution.stderr);
  assert.equal(execution.stdout, '42\n'); assert.equal(execution.stderr, '');
  const processFile = fileInventory(path).find(file => /^python-execution-[^/]+\/process\.json$/u.test(file.path));
  assert.ok(processFile, 'real Python must retain its host process evidence');
  const process = JSON.parse(readFileSync(join(path, processFile.path)));
  assert.equal(process.stdout, execution.stdout); assert.equal(process.stderr, execution.stderr);
  assert.equal(process.exitCode, execution.exitCode); assert.equal(process.durationMs, execution.durationMs);
  assert.equal(process.processGroupGone, true);
  const sandboxPath = processFile.path.replace(/process\.json$/u, 'sandbox.sb');
  const sandbox = readFileSync(join(path, sandboxPath), 'utf8');
  assert.ok(sandbox.includes('(deny default)'));
  assert.equal(/\(allow\b[^()]*\bnetwork/u.test(sandbox), false);
  const seal = JSON.parse(readFileSync(join(path, 'verified-evidence.json')));
  for (const name of [processFile.path, sandboxPath, 'executions.jsonl', 'worker/agent.sqlite']) {
    assert.equal(seal.files.find(file => file.path === name)?.sha256, sha256(readFileSync(join(path, name))));
  }
  const db = new Database(join(path, 'worker/agent.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const effect = db.prepare("SELECT * FROM agent_tool_effects WHERE tool_call_id='call-run_shell_command'").get();
    assert.equal(effect.status, 'succeeded');
    const receipt = db.prepare('SELECT * FROM agent_tool_effect_results WHERE operation_id=?').get(effect.operation_id);
    assert.equal(receipt.receipt_hash, hash(JSON.parse(receipt.receipt_json)));
    const checkpoints = db.prepare("SELECT checkpoint_blob FROM langgraph_checkpoints WHERE checkpoint_ns=''").all();
    assert.ok(checkpoints.some(row => JSON.parse(row.checkpoint_blob.toString()).channel_values.messages.some(message => {
      if (message.kwargs?.tool_call_id !== 'call-run_shell_command') return false;
      const value = JSON.parse(message.kwargs.content);
      return value.exitCode === execution.exitCode && value.output === execution.stdout;
    })));
  } finally { db.close(); }
  const args = { artifact, input: scienceInput, directory: path, config: fixtureConfig,
    requests: result.requests, toolSchemaHash: result.toolSchemaHash };
  assert.equal(verifyApplicationEvidence(args).status, 'verified');
  const inventory = fileInventory(path);
  assert.deepEqual(recoverApplication(args), result);
  assert.deepEqual(fileInventory(path), inventory, 'recovery must preserve existing bytes');
  assert.equal(executions, 1); assert.equal(calls, 3);
  const target = join(path, processFile.path), original = readFileSync(target);
  try {
    writeFileSync(target, JSON.stringify({ ...process, stdout: 'forged\n' }) + '\n');
    assert.throws(() => recoverApplication(args), /trial_evidence_changed/);
    unlinkSync(target);
    assert.throws(() => recoverApplication(args), /trial_evidence_changed/);
  } finally { writeFileSync(target, original); }
  assert.deepEqual(recoverApplication(args), result);
  assert.deepEqual(fileInventory(path), inventory);
});
test('scientific host rejects a JSON-serialized execution result without private host evidence', async () => {
  const { dataset } = await scienceFixture(trial('science-missing-evidence-fixture')), task = dataset.tasks[0];
  const path = trial('science-missing-host-evidence'); let calls = 0, executions = 0;
  await assert.rejects(executeApplication({ artifact,
    input: { kind: 'scienceagentbench', prompt: 'Write solution.py and run python solution.py.', files: {} }, directory: path,
    config: fixtureConfig, protectedPaths: [hidden], signal: new AbortController().signal, record: () => {},
    complete: body => { calls++; return calls === 1
      ? completion(body, 'write_file', { file_path: '/workspace/solution.py', content: 'print(42)\n' })
      : completion(body, 'run_shell_command', { command: 'python solution.py' }); },
    execute: async (workspace, signal, limits) => {
      executions++; return JSON.parse(JSON.stringify(await executeScience(task, workspace, signal, limits)));
    }
  }), /execution_host_evidence_missing/);
  assert.equal(executions, 1); assert.equal(calls, 2);
  assert.equal(existsSync(join(path, 'executions.jsonl')), false);
  assert.equal(existsSync(join(path, 'final-answer.json')), false);
  assert.equal(existsSync(join(path, 'verified-evidence.json')), false);
  assert.equal(JSON.parse(readFileSync(join(path, 'cleanup.json'))).processGroupGone, true);
});
test('cancellation during model dispatch terminates worker and records cleanup', async () => {
  const path = trial('cancel'), controller = new AbortController();
  await assert.rejects(executeApplication({ artifact, input, directory: path, config: fixtureConfig,
    signal: controller.signal, protectedPaths: [hidden], record: () => {}, complete: body => { controller.abort(); return fixtureCompletion(body); } }), /run_cancelled/);
  assert.equal(JSON.parse(readFileSync(join(path, 'cleanup.json'))).processGroupGone, true);
});

test('local science runs real tools, denies hidden files/network/subprocesses, calibrates and independently grades', async () => {
  const { dataset } = await scienceFixture(root), task = dataset.tasks[0];
  const calibrationRoot = trial('calibration');
  const preflight = await sciencePreflight(dataset, [task], calibrationRoot, new AbortController().signal);
  assert.equal(preflight.calibration.length, 5);
  assert.ok(preflight.calibration.every(c => c.observed === c.expected));
  const path = trial('local-science'); let calls = 0;
  const script = `import pathlib,socket,subprocess,json
denied=0
try: pathlib.Path(${JSON.stringify(hidden)}).read_text()
except PermissionError: denied+=1
try: socket.create_connection(('127.0.0.1',9),timeout=1)
except PermissionError: denied+=1
try: subprocess.run(['/bin/cat',${JSON.stringify(hidden)}],check=True)
except PermissionError: denied+=1
assert denied==3,denied
value=float(pathlib.Path('input.csv').read_text())*2
pathlib.Path('pred.csv').write_text(str(value))
print(json.dumps({'denied':denied}))
`;
  const result = await executeApplication({ artifact, input: { kind: 'scienceagentbench', files: {}, prompt: 'Write solution.py, compute pred.csv and run python solution.py.' },
    directory: path, config: fixtureConfig, protectedPaths: [hidden], signal: new AbortController().signal, record: () => {},
    stage: workspace => stageScience(dataset, task, workspace),
    execute: (workspace, signal, limits) => executeScience(task, workspace, signal, limits),
    complete: body => { calls++; return calls === 1 ? completion(body, 'write_file', { file_path: '/workspace/solution.py', content: script })
      : calls === 2 ? completion(body, 'run_shell_command', { command: 'python solution.py' }) : completion(body); }
  });
  assert.equal((await gradeScience(dataset, task, result.workspace, path, new AbortController().signal)).metrics.successRate, 1);
  const execution = JSON.parse(readFileSync(join(path, 'executions.jsonl'), 'utf8').trim());
  assert.equal(execution.exitCode, 0, execution.stderr); assert.equal(JSON.parse(execution.stdout).denied, 3);
  const limitRoot = trial('python-timeout'), limited = join(limitRoot, 'worker/workspace'); mkdirSync(limited, { recursive: true });
  writeFileSync(join(limited, 'solution.py'), 'while True: pass\n');
  await assert.rejects(executeScience(task, limited, new AbortController().signal, { timeoutMs: 100, maxBytes: 1024 }), /scientific_execution_limit/);
});
