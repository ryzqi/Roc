import assert from 'node:assert/strict';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { hash, readJson, sha256 } from '../lib/common.mjs';
import { harnessCases, selectHarnessCases } from '../lib/harness-cases.mjs';
import { runHarness } from '../lib/harness.mjs';
import { readHarnessState, summarizeHarness, verifyHarnessCase } from '../lib/harness-verifier.mjs';
import { inspectRun } from '../lib/report.mjs';
import { testArtifacts } from './test-artifacts.mjs';

const root = testArtifacts('harness');
const result = await runHarness({ profile: 'fast', outputRoot: relative(process.cwd(), join(root, 'runs')) });
const original = id => join(result.directory, `trial-${id}-0`);
function audit(name, id, mutate) {
  const path = join(root, name);
  cpSync(original(id), path, { recursive: true, errorOnExist: true });
  mutate(path);
  return verifyHarnessCase(harnessCases.find(c => c.id === id), path);
}
function changeDb(path, mutate, file = 'final.sqlite') {
  const db = new Database(join(path, file));
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
function changeMemory(path, file, mutate) {
  changeDb(path, db => {
    const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all();
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    try { mutate(db); } finally { for (const trigger of triggers) db.exec(trigger.sql); }
  }, file);
}
function changeChildReceipt(path, mutate) {
  changeDb(path, db => {
    const child = db.prepare("SELECT call_id, envelope_json FROM agent_calls WHERE kind = 'child'").get();
    const envelope = JSON.parse(child.envelope_json);
    mutate(envelope);
    if (envelope.settlementReceipt) envelope.settlementReceiptHash = hash(envelope.settlementReceipt);
    db.prepare('UPDATE agent_calls SET envelope_json = ? WHERE call_id = ?').run(JSON.stringify(envelope), child.call_id);
  });
}

test('all 22 production harness cases pass in separate workspaces with zero inference', () => {
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(result.assessment, 'pass', JSON.stringify(inspectRun(result.directory).trials));
  assert.equal(harnessCases.length, 22);
  assert.equal(result.expected, 22);
  assert.equal(result.passed, 22);
  assert.equal(Object.keys(result.dimensions).length, 13);
  assert.equal(result.invalid, 0);
  assert.equal(result.usage.inferenceRequests, 0);
  const report = readFileSync(join(result.directory, 'report.md'), 'utf8');
  assert.match(report, /Harness gate: pass/);
  assert.match(report, /\| tool-effects \| 3 \| 3 \| 3 \|/);
  const runs = harnessCases.map(c => readHarnessState(join(original(c.id), 'final.sqlite')).runs[0]);
  assert.equal(new Set(runs.map(run => run.id)).size, 22);
  assert.equal(new Set(runs.map(run => run.thread_id)).size, 22);
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
test('startup events require complete ordered transport and exact persisted row provenance', () => {
  for (const [name, mutate] of [
    ['startup-missing', records => { records.splice(records.findIndex(record => record.persisted), 1); }],
    ['startup-duplicate', records => { records.push(structuredClone(records.find(record => record.persisted))); }],
    ['startup-reordered', records => {
      const first = records.findIndex(record => record.persisted);
      [records[first], records[first + 1]] = [records[first + 1], records[first]];
    }],
    ['startup-wrong-source', records => { records.find(record => record.persisted).persisted.source = 'invented'; }],
    ['startup-wrong-sequence', records => { records.find(record => record.persisted).persisted.sequence += 1; }],
    ['startup-wrong-time', records => { records.find(record => record.persisted).persisted.createdAt = '2000-01-01T00:00:00.000Z'; }],
    ['startup-wrong-boundary', records => { records.find(record => record.type === 'reconciled').throughSequence += 1; }]
  ]) {
    failed(audit(name, 'cold-model-resume', path => changeLines(path, 'recover.jsonl', mutate)), 'raw-events-observed');
  }
});
test('persisted terminal rows cannot substitute for missing or reordered EventBus notifications', () => {
  for (const id of ['cancel-model', 'denied-tool', 'workspace-replaced', 'budget-stop', 'subagent-cancel']) {
    for (const [name, mutate] of [
      ['missing', records => { records.splice(records.findLastIndex(record => record.type === 'event-bus'), 1); }],
      ['reordered', records => {
        const indices = records.flatMap((record, i) => record.type === 'event-bus' ? [i] : []).slice(-2);
        [records[indices[0]], records[indices[1]]] = [records[indices[1]], records[indices[0]]];
      }]
    ]) {
      failed(audit(`event-bus-${name}-${id}`, id, path => changeLines(path, 'start.jsonl', mutate)), 'event-bus-bound');
    }
  }
});
test('memory failure preserves independently backed-up seed bytes, MIME and timestamps', () => {
  for (const file of ['seed-memory.sqlite', 'final-memory.sqlite']) {
    for (const field of ['content', 'mimeType', 'modified_at']) {
      failed(audit(`memory-${file}-${field}`, 'memory-db-error', path => changeMemory(path, file, db => {
        const row = db.prepare('SELECT namespace_key, key, value_json FROM langgraph_store_items').get();
        const value = JSON.parse(row.value_json);
        value[field] = field === 'content' ? 'forged saved memory\n' : field === 'mimeType' ? 'text/plain' : '2000-01-01T00:00:00.000Z';
        db.prepare('UPDATE langgraph_store_items SET value_json = ? WHERE namespace_key = ? AND key = ?')
          .run(JSON.stringify(value), row.namespace_key, row.key);
      })), 'memory-original-preserved');
    }
  }
  failed(audit('memory-fault-after-request', 'memory-db-error', path => changeLines(path, 'start.jsonl', records => {
    const [fault] = records.splice(records.findIndex(record => record.type === 'memory-fault'), 1);
    records.splice(records.findIndex(record => record.type === 'request') + 1, 0, fault);
  })), 'memory-fault-installed');
});
test('both UI and model context artifacts require the complete independently observed original', () => {
  const artifacts = readHarnessState(join(original('context-compaction-crash'), 'final.sqlite')).artifacts;
  assert.equal(artifacts.length, 2);
  for (const artifact of artifacts) {
    failed(audit(`context-content-${artifact.id}`, 'context-compaction-crash', path => changeDb(path, db => {
      const forged = artifact.content.replace('  1: ', '  1: forged ');
      assert.notEqual(forged, artifact.content);
      db.prepare('UPDATE context_artifacts SET content = ?, sha256 = ?, original_chars = ?, preview = ? WHERE id = ?')
        .run(forged, sha256(forged), forged.length, forged.slice(0, 2000), artifact.id);
    })), 'context-artifact-original-bound');
  }
  failed(audit('context-artifact-missing', 'context-compaction-crash', path => changeDb(path, db => {
    db.prepare('DELETE FROM context_artifacts WHERE id = ?').run(artifacts[0].id);
  })), 'context-artifact-original-bound');
  failed(audit('context-parent-reference-changed', 'context-compaction-crash', path => changeLines(path, 'recover.jsonl', records => {
    const request = records.find(record => record.type === 'request');
    const tool = request.body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'read-large-source');
    tool.content = typeof tool.content === 'string' ? tool.content.replace('sha256:', 'forgedSha256:') : 'forged reference';
    changeLines(path, 'recover.responses.jsonl', replies => { replies[0].requestHash = hash(request.body); });
  })), 'context-resumed-without-reread');
});
test('child cancellation and reported error require durable failed receipts and the original parent tool error', () => {
  for (const id of ['subagent-cancel', 'subagent-error']) {
    failed(audit(`child-receipt-missing-${id}`, id, path => changeChildReceipt(path, envelope => {
      delete envelope.settlementReceipt;
      delete envelope.settlementReceiptHash;
    })), 'child-failed-settlement-bound');
    failed(audit(`child-receipt-wrong-outcome-${id}`, id, path => changeChildReceipt(path, envelope => {
      envelope.settlementReceipt.outcome = { outcomeStatus: 'completed' };
    })), 'child-failed-settlement-bound');
  }
  failed(audit('child-error-parent-wire-changed', 'subagent-error', path => changeLines(path, 'start.jsonl', records => {
    const request = records.find(record => record.type === 'request' && record.index === 2);
    const tool = request.body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'delegate-once');
    tool.content = 'The child completed successfully.';
    changeLines(path, 'start.responses.jsonl', replies => {
      replies.find(reply => reply.request === 2).requestHash = hash(request.body);
    });
  })), 'child-transport-error-propagated');
});
test('replaced workspace admission rejects a forged later write dispatch', () => {
  failed(audit('workspace-replaced-extra-dispatch', 'workspace-replaced', path => changeDb(path, db => {
    const read = db.prepare("SELECT * FROM agent_calls WHERE kind = 'tool'").get();
    const envelope = JSON.parse(read.envelope_json), args = { file_path: '/workspace/result.txt', content: 'saved\n' };
    const inputHash = hash({ name: 'write_file', args });
    const columns = Object.keys(read);
    db.prepare(`INSERT INTO agent_calls (${columns.join(',')}) VALUES (${columns.map(column => `@${column}`).join(',')})`)
      .run({ ...read, call_id: 'forged-write-dispatch', input_hash: inputHash,
        envelope_json: JSON.stringify({ ...envelope, name: 'write_file', inputHash }) });
  })), 'workspace-write-rejected');
});
test('uncertain MCP effect requires actual remote bytes and excludes an invented success reply', () => {
  failed(audit('mcp-marker-hash-changed', 'mcp-receipt-lost', path => {
    const marker = readJson(join(path, 'worker/mcp-state/commit-observed.json'));
    marker.sha256 = sha256('forged');
    writeFileSync(join(path, 'worker/mcp-state/commit-observed.json'), JSON.stringify(marker) + '\n');
  }), 'mcp-durable-effect-without-reply');
  failed(audit('mcp-wire-reply-invented', 'mcp-receipt-lost', path => changeLines(path, 'worker/mcp-state/transport.jsonl', records => {
    const call = records.find(record => record.event === 'wire' && record.direction === 'in'
      && JSON.parse(record.raw).method === 'tools/call');
    records.push({ pid: call.pid, event: 'wire', direction: 'out', raw: JSON.stringify({
      jsonrpc: '2.0', id: JSON.parse(call.raw).id, result: { content: [{ type: 'text', text: 'committed' }] }
    }) });
  })), 'mcp-no-success-reply');
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
  const duplicate = structuredClone(sealed.trials); duplicate[duplicate.length - 1] = duplicate[0];
  const summary = summarizeHarness(sealed.manifest, duplicate);
  assert.equal(summary.status, 'incomplete');
  assert.equal(summary.fatal.reason, 'harness_trial_set_invalid');
  assert.equal(summary.unattempted, 1);
  assert.equal(summarizeHarness(sealed.manifest, sealed.trials.slice(0, -1)).status, 'incomplete');
});
test('harness profile selection is explicit and has no model-quality release profile', () => {
  assert.equal(selectHarnessCases('smoke').cases.length, 3);
  assert.equal(selectHarnessCases('full').repeats, 3);
  assert.equal(selectHarnessCases('fast', 'approval-approve').cases.length, 1);
  assert.throws(() => selectHarnessCases('release'), /harness_profile_requires/);
  assert.throws(() => selectHarnessCases('fast', 'missing'), /harness_task_not_found/);
  assert.equal(hash(selectHarnessCases('fast').cases), hash(harnessCases));
});
