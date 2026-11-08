import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareApplication, executeApplication } from '../lib/application.mjs';
import { fixtureConfig, fixtureCompletion } from '../lib/fixture.mjs';
import { fileInventory, ROOT } from '../lib/common.mjs';
import { scienceFixture } from './science-fixture.mjs';
import { sciencePreflight, stageScience, executeScience, gradeScience } from '../lib/science.mjs';

mkdirSync('evaluation/.runtime/tests', { recursive: true });
const root = mkdtempSync(join(ROOT, 'evaluation/.runtime/tests/application-'));
const artifact = await prepareApplication(root), hidden = join(root, 'hidden-gold.txt');
writeFileSync(hidden, 'hidden-evaluation-truth');
const input = { kind: 'qasper', prompt: 'Read /workspace/paper.json using read_file and answer JSON.', files: { 'paper.json': '{"title":"Visible paper","paragraphs":[{"id":"p0","text":"visible-paper-sentinel"}]}' } };
function trial(name) { const path = join(root, name); mkdirSync(path); return path; }

test('real Roc file tool exposes only public paper; complete trace, isolation and cleanup retained', async () => {
  const path = trial('paper'), requests = [];
  const result = await executeApplication({ artifact, input, directory: path, config: fixtureConfig,
    protectedPaths: [hidden], signal: new AbortController().signal, record: () => {}, complete: body => { requests.push(body); return fixtureCompletion(body); } });
  assert.equal(result.output, '{"answer":"Unanswerable","evidence":[]}');
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('visible-paper-sentinel')));
  assert.equal(JSON.stringify(requests).includes('hidden-evaluation-truth'), false);
  const trace = readFileSync(join(path, 'transcript.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(trace.some(m => m.type === 'isolation' && m.filesDenied && m.childDenied));
  assert.ok(trace.some(m => m.event?.type === 'run_completed'));
  assert.equal(JSON.parse(readFileSync(join(path, 'cleanup.json'))).processGroupGone, true);
  assert.ok(fileInventory(path).some(f => f.path === 'worker/agent.sqlite'));
});
function completion(body, tool, args) {
  return { id: `fixture-science-${body.messages.length}`, object: 'chat.completion', created: 0, model: body.model,
    choices: [{ index: 0, finish_reason: tool ? 'tool_calls' : 'stop', message: tool ? { role: 'assistant', content: null,
      tool_calls: [{ id: `call-${tool}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: '{"done":true}' } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
}
test('scientific task uses production write tool and consumed execution grant before host callback', async () => {
  const path = trial('science'); let calls = 0, executions = 0; const events = [];
  const result = await executeApplication({ artifact, input: { kind: 'scienceagentbench', prompt: 'Write solution.py and run python solution.py.', files: {} }, directory: path,
    config: fixtureConfig, protectedPaths: [hidden], signal: new AbortController().signal, record: e => events.push(e),
    complete: body => { calls++; return calls === 1 ? completion(body, 'write_file', { file_path: '/workspace/solution.py', content: 'print(42)\n' }) : calls === 2 ? completion(body, 'run_shell_command', { command: 'python solution.py' }) : completion(body); },
    execute: async (workspace, _signal, limits) => { executions++; assert.equal(readFileSync(join(workspace, 'solution.py'), 'utf8'), 'print(42)\n');
      assert.ok(limits.timeoutMs > 0 && limits.timeoutMs <= 120000);
      assert.ok(limits.maxBytes > 0 && limits.maxBytes <= 1048576);
      assert.ok(events.some(e => e.type === 'execution_requested' && e.grantId));
      return { command: 'python solution.py', normalizedCommand: 'python solution.py', cwd: workspace, stdout: '42\n', stderr: '', exitCode: 0, durationMs: 1, usedRtk: false }; }
  });
  assert.equal(result.output, '{"done":true}'); assert.equal(executions, 1); assert.equal(calls, 3);
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
