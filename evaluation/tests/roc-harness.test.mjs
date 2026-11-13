import assert from 'node:assert/strict';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { hash, readJson } from '../lib/common.mjs';
import { harnessCases, selectHarnessCases } from '../lib/harness-cases.mjs';
import { runHarness } from '../lib/harness.mjs';
import { readHarnessState, summarizeHarness, verifyHarnessCase } from '../lib/harness-verifier.mjs';
import { inspectRun } from '../lib/report.mjs';
import { testArtifacts } from './test-artifacts.mjs';

const root = testArtifacts('harness');
const result = await runHarness({ profile: 'fast', outputRoot: join(root, 'runs') });
const original = id => join(result.directory, `trial-${id}-0`);
function audit(name, id, mutate) {
  const path = join(root, name);
  cpSync(original(id), path, { recursive: true, errorOnExist: true });
  mutate(path);
  return verifyHarnessCase(harnessCases.find(c => c.id === id), path);
}
function changeDb(path, mutate) {
  const db = new Database(join(path, 'final.sqlite'));
  // Copied audit evidence keeps production triggers; their event transport has
  // no host connection here and must not dispatch into the real application.
  db.function('roc_task_event', { varargs: true }, () => null);
  try { mutate(db); } finally { db.close(); }
}
function changeLines(path, file, mutate) {
  const records = readFileSync(join(path, file), 'utf8').trim().split('\n').map(JSON.parse);
  mutate(records);
  writeFileSync(join(path, file), records.map(record => JSON.stringify(record)).join('\n') + '\n');
}
function failed(grade, criterion) {
  assert.equal(grade.status, 'failed', grade.reason);
  assert.ok(grade.checks.some(c => c.id === criterion && !c.passed), grade.reason);
  assert.equal(grade.metrics.scenarioPassRate, 0);
}

test('all ten production harness cases pass in separate workspaces with zero inference', () => {
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(result.assessment, 'pass', JSON.stringify(inspectRun(result.directory).trials));
  assert.equal(result.expected, 10);
  assert.equal(result.passed, 10);
  assert.equal(result.invalid, 0);
  assert.equal(result.usage.inferenceRequests, 0);
  const report = readFileSync(join(result.directory, 'report.md'), 'utf8');
  assert.match(report, /Harness gate: pass/);
  assert.match(report, /\| tool-effects \| 3 \| 3 \| 3 \|/);
  const runs = harnessCases.map(c => readHarnessState(join(original(c.id), 'final.sqlite')).runs[0]);
  assert.equal(new Set(runs.map(run => run.id)).size, 10);
  assert.equal(new Set(runs.map(run => run.thread_id)).size, 10);
});
test('supported alternative assistant wording preserves the same independently verified effects', () => {
  const grade = audit('alternative', 'tool-result-replay', path => {
    changeLines(path, 'recover.jsonl', records => {
      records.findLast(r => r.type === 'result').output = 'The requested file has been saved.';
    });
    changeLines(path, 'recover.responses.jsonl', records => {
      records.at(-1).body.choices[0].message.content = 'The requested file has been saved.';
    });
  });
  assert.equal(grade.status, 'passed', grade.reason);
});
test('wrong file bytes and collateral files fail the actual workspace criterion', () => {
  failed(audit('wrong-bytes', 'tool-result-replay', path =>
    writeFileSync(join(path, 'worker/workspace/result.txt'), 'wrong result\n')), 'workspace-state');
  failed(audit('collateral', 'tool-result-replay', path =>
    writeFileSync(join(path, 'worker/workspace/extra.txt'), 'collateral\n')), 'workspace-state');
});
test('a missing saved result receipt and a repeated effect attempt cannot earn a replay pass', () => {
  failed(audit('receipt-missing', 'tool-result-replay', path => changeDb(path, db =>
    db.exec('DELETE FROM agent_tool_effect_results'))), 'result-receipt-integrity');
  failed(audit('effect-repeated', 'tool-result-replay', path => changeDb(path, db =>
    db.exec('UPDATE agent_tool_effects SET attempt_count = attempt_count + 1'))), 'stored-result-replayed');
});
test('a second persisted tool dispatch fails even if its usage envelope remains valid', () => {
  const grade = audit('dispatch-repeated', 'tool-result-replay', path => changeDb(path, db => {
    const call = db.prepare("SELECT * FROM agent_calls WHERE kind = 'tool'").get();
    const columns = Object.keys(call);
    db.prepare(`INSERT INTO agent_calls (${columns.join(',')}) VALUES (${columns.map(c => `@${c}`).join(',')})`)
      .run({ ...call, call_id: 'audit-extra-dispatch' });
  }));
  failed(grade, 'stored-result-replayed');
});
test('tool input hashes must bind the model response to the persisted operation', () => {
  const grade = audit('wrong-tool-input', 'tool-result-replay', path => {
    changeLines(path, 'start.responses.jsonl', records => {
      const call = records[0].body.choices[0].message.tool_calls[0];
      call.function.arguments = JSON.stringify({ file_path: '/workspace/result.txt', content: 'different\n' });
    });
  });
  failed(grade, 'tool-inputs-bound-to-responses');
});
test('unknown usage settlement receipts remain bound to the cancelled call and state', () => {
  for (const [name, mutate] of [
    ['wrong-usage-call', receipt => { receipt.callId = 'a-different-call'; }],
    ['wrong-usage-state', receipt => { receipt.state = 'settled'; }]
  ]) {
    failed(audit(name, 'cancel-model', path => changeDb(path, db => {
      const call = db.prepare('SELECT call_id, envelope_json FROM agent_calls').get();
      const envelope = JSON.parse(call.envelope_json);
      mutate(envelope.settlementReceipt);
      envelope.settlementReceiptHash = hash(envelope.settlementReceipt);
      db.prepare('UPDATE agent_calls SET envelope_json = ? WHERE call_id = ?')
        .run(JSON.stringify(envelope), call.call_id);
    })), 'usage-ledger-integrity');
  }
});
test('a forged assistant success cannot bypass an unknown effect and blocked recovery', () => {
  const grade = audit('forged-success', 'tool-receipt-unknown', path =>
    changeLines(path, 'recover.jsonl', records => {
      const terminal = records.findLast(r => r.type === 'result');
      terminal.status = 'completed'; terminal.output = 'Everything succeeded.'; delete terminal.error;
    }));
  failed(grade, 'unattended-resume-blocked');
});
test('approved deletion requires the real recoverable original bytes', () => {
  const grade = audit('bad-recovery-snapshot', 'approval-approve', path => {
    const points = readJson(join(path, 'final-state.json')).effects;
    const toolResult = JSON.parse(points[0].result_json);
    const point = JSON.parse(toolResult.content).recoveryPoint;
    writeFileSync(join(path, 'worker/state/tasks/recovery', point.id, 'original'), 'unrecoverable\n');
  });
  failed(grade, 'approved-delete-recoverable');
});
test('missing or corrupt databases, transcripts and response evidence are invalid without a score', () => {
  for (const [name, mutate] of [
    ['missing-db', path => rmSync(join(path, 'final.sqlite'))],
    ['corrupt-db', path => writeFileSync(join(path, 'final.sqlite'), 'corrupt sqlite')],
    ['missing-transcript', path => rmSync(join(path, 'recover.jsonl'))],
    ['corrupt-transcript', path => writeFileSync(join(path, 'recover.jsonl'), '{"type":"result"')],
    ['missing-response', path => rmSync(join(path, 'recover.responses.jsonl'))],
    ['bad-response-index', path => changeLines(path, 'recover.responses.jsonl', records => { records[0].request = 9; })]
  ]) {
    const grade = audit(name, 'tool-result-replay', mutate);
    assert.equal(grade.status, 'invalid', `${name}: ${grade.reason}`);
    assert.equal(grade.failureClass, 'verifier');
    assert.equal(grade.metrics, null);
  }
});
test('one failed invariant fails the gate; duplicate or missing trials cannot become complete', () => {
  const sealed = inspectRun(result.directory), trials = structuredClone(sealed.trials);
  trials[0].status = 'failed'; trials[0].metrics.scenarioPassRate = 0;
  assert.equal(summarizeHarness(sealed.manifest, trials).assessment, 'fail');
  const duplicate = structuredClone(sealed.trials); duplicate[9] = duplicate[0];
  const summary = summarizeHarness(sealed.manifest, duplicate);
  assert.equal(summary.status, 'incomplete');
  assert.equal(summary.fatal.reason, 'harness_trial_set_invalid');
  assert.equal(summary.unattempted, 1);
  assert.equal(summarizeHarness(sealed.manifest, sealed.trials.slice(0, 9)).status, 'incomplete');
});
test('harness profile selection is explicit and has no model-quality release profile', () => {
  assert.equal(selectHarnessCases('smoke').cases.length, 3);
  assert.equal(selectHarnessCases('full').repeats, 3);
  assert.equal(selectHarnessCases('fast', 'approval-approve').cases.length, 1);
  assert.throws(() => selectHarnessCases('release'), /harness_profile_requires/);
  assert.throws(() => selectHarnessCases('fast', 'missing'), /harness_task_not_found/);
  assert.equal(hash(selectHarnessCases('fast').cases), hash(harnessCases));
});
