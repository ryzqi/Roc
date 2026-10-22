import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { createInventory, hash } from './inventory.mjs';
import { scenarios } from './scenarios.mjs';

const directory = resolve('.artifacts/harness-eval', new Date().toISOString().replaceAll(':', '-') + `-${process.pid}`);
const expectedCaseCount = 93;
mkdirSync(directory, { recursive: true });
const save = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2));
const report = { schemaVersion: 1, kind: 'deterministic-pilot', directory,
  command: 'pnpm harness:eval', cwd: process.cwd(), results: [], knownDefects: {},
  taxonomy: ['infra', 'provider', 'policy', 'effect', 'state', 'verifier', 'agent'],
  qualityClaim: 'fixture transport only; real model quality not measured', costUsd: null, passed: false,
  limits: { externalCalls: 0, modelCallsPerTurn: 2, maxTurnsPerTask: 3, recursionLimit: 12, requestTimeoutMs: 10000 },
  thresholds: { contractFailures: 0, knownProductDefects: 'observed, not passed', qualityImprovement: 'not measured' } };
let server;
const started = performance.now();
try {
  const runtimePath = join(directory, 'runtime.mjs');
  const compiled = await build({ entryPoints: ['scripts/harness-eval/runtime.ts'], outfile: runtimePath,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent', metafile: true });
  const sourceInputs = Object.keys(compiled.metafile.inputs);
  const inventory = createInventory({ sourceInputs });
  assert.deepEqual(inventory, createInventory({ sourceInputs }));
  const changed = createInventory({ sourceInputs, readComponent: path => path === 'scripts/harness-eval/scenarios.mjs'
    ? Buffer.concat([readFileSync(path), Buffer.from('mutation')]) : readFileSync(path) });
  assert.notEqual(inventory.hash, changed.hash);
  assert.deepEqual(changed.components.filter((c, i) => c.hash !== inventory.components[i].hash)
    .map(c => c.path), ['scripts/harness-eval/scenarios.mjs']);
  save('inventory.json', inventory);
  save('dataset.json', { hash: hash(JSON.stringify(scenarios)), scenarios });
  // Prevent tracing from exporting synthetic trajectories using an ambient account.
  process.env.LANGSMITH_TRACING = 'false';
  process.env.LANGCHAIN_TRACING_V2 = 'false';
  const runtime = await import(pathToFileURL(runtimePath).href);
  report.knownDefects = runtime.observeBaseline(directory);
  for (const point of ['before-dispatch', 'remote-success', 'result-stored']) {
    const dir = join(directory, point);
    mkdirSync(dir);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { crashWorker } from ${JSON.stringify(pathToFileURL(runtimePath).href)}; crashWorker(${JSON.stringify(dir)}, ${JSON.stringify(point)});`
    ], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 73, child.stderr);
    report.results.push({ id: point, passed: true, evidence: runtime.recoverCrash(dir, point) });
  }
  const requests = new Map();
  server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.stream, false);
      const user = body.messages.findLast(m => m.role === 'user')?.content;
      const step = (requests.get(user) ?? 0) + 1;
      requests.set(user, step);
      const done = user === 'budget-child-tools: preserve correction' || (body.messages.at(-1).role === 'tool'
        && user !== 'budget-loop' && (user !== 'budget-window' || step === 3));
      assert.ok(step <= (user === 'budget-loop' || user === 'budget-window' ? 3 : 2), 'unbounded provider calls');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: `pilot-${hash(String(user)).slice(0, 16)}-${step}`, object: 'chat.completion', created: 0, model: 'roc-pilot',
        choices: [{ index: 0, finish_reason: done ? 'stop' : 'tool_calls', message: done
          ? { role: 'assistant', content: 'pilot-complete' }
          : { role: 'assistant', content: null, tool_calls: user === 'execution-child' ? [{id:'child-task',type:'function',function:{name:'task',arguments:JSON.stringify({description:'execution-child/child',subagent_type:'pilot-child'})}},{id:'parent-action',type:'function',function:{name:'pilot_action',arguments:'{"index":0}'}}] : user.startsWith('execution-') ? Array.from({ length: 4 }, (_, index) => ({ id: `execution-${index}`, type: 'function', function: { name: 'pilot_action', arguments: JSON.stringify({ index }) } })) : [{ id: `pilot-${hash(String(user)).slice(0, 16)}-${step}`, type: 'function',
            function: user === 'budget-child-tools'
              ? { name: 'task', arguments: JSON.stringify({ description: 'budget-child-tools-child', subagent_type: 'pilot-child' }) }
              : { name: 'pilot_action', arguments: '{}' } }] } }],
        ...(user === 'budget-unknown' ? {} : { usage: user === 'budget-window'
          ? { prompt_tokens: 40000, completion_tokens: 5000, total_tokens: 45000 }
          : { prompt_tokens: 64, completion_tokens: 16, total_tokens: 80 } })
      }));
    } catch (error) {
      response.writeHead(500).end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  for (const name of ['execution-admission', 'execution-resource', 'execution-mutation', 'execution-signal', 'execution-cancel', 'execution-child']) {
    const dir = join(directory, name);
    mkdirSync(dir);
    try { report.results.push({ id: name, passed: true, evidence: await runtime.runExecutionScenario(name, dir, endpoint) }); }
    catch (error) { report.results.push({ id: name, passed: false, failureClass: 'verifier', error: String(error) }); }
  }
  {
    const dir = join(directory, 'execution-isolation'); mkdirSync(dir);
    try { report.results.push({ id: 'execution-isolation', passed: true, evidence: await runtime.runIsolationScenario(dir) }); }
    catch (error) { report.results.push({ id: 'execution-isolation', passed: false, failureClass: 'verifier', error: String(error) }); }
  }
  for (const name of ['execution-atomic', 'execution-plugin-cleanup', 'execution-mcp-lifecycle']) {
    const dir = join(directory, name); mkdirSync(dir);
    try { report.results.push({ id: name, passed: true, evidence: await runtime.verifyExtensions(name, dir) }); }
    catch (error) { report.results.push({ id: name, passed: false, failureClass: 'verifier', error: String(error) }); }
  }
  for (const scenario of scenarios) {
    const dir = join(directory, scenario.id);
    mkdirSync(dir);
    const start = performance.now();
    try {
      const evidence = await runtime.runScenario(scenario, dir, endpoint);
      const modelCalls = [...requests].filter(([id]) => id === scenario.id || id.startsWith(scenario.id + '/turn-'))
        .reduce((total, [, count]) => total + count, 0);
      assert.equal(modelCalls, evidence.turns * 2);
      report.results.push({ id: scenario.id, passed: true, durationMs: performance.now() - start,
        modelCalls, tokenUsage: { source: 'fixture', totalTokens: modelCalls * 80 }, costUsd: null, evidence });
    } catch (error) {
      report.results.push({ id: scenario.id, passed: false, failureClass: error.failureClass ?? (error.name === 'AssertionError' ? 'verifier' : 'infra'), error: String(error) });
    }
  }
  for (const name of ['budget-model', 'budget-token', 'budget-unknown', 'budget-restart', 'budget-loop', 'budget-cost', 'budget-deadline', 'budget-inbox', 'budget-retry', 'budget-concurrency', 'budget-window', 'budget-child-tools']) {
    const dir = join(directory, name);
    mkdirSync(dir);
    const before = [...requests.values()].reduce((a, b) => a + b, 0);
    try {
      const evidence = await runtime.runBudgetScenario(name, dir, endpoint);
      const modelCalls = [...requests.values()].reduce((a, b) => a + b, 0) - before;
      assert.equal(modelCalls, name === 'budget-child-tools' ? 4 : name === 'budget-cost' || name === 'budget-deadline' ? 0
        : name === 'budget-loop' || name === 'budget-concurrency' || name === 'budget-window' ? 3 : name === 'budget-inbox' ? 2 : 1);
      report.results.push({ id: name, passed: true, modelCalls, evidence });
    } catch (error) {
      report.results.push({ id: name, passed: false, failureClass: 'verifier', error: String(error) });
    }
  }
  for (const name of ['context-artifacts', 'context-prefix', 'context-tokens', 'context-compaction', 'context-summary-failure']) {
    const dir = join(directory, name);
    mkdirSync(dir);
    try { report.results.push({ id: name, passed: true, evidence: await runtime.runContextScenario(name, dir) }); }
    catch (error) { report.results.push({ id: name, passed: false, failureClass: 'verifier', error: String(error) }); }
  }
  {
    const name = 'task-contracts';
    const dir = join(directory, name);
    mkdirSync(dir);
    try { report.results.push({ id: name, passed: true, evidence: await runtime.verifyTaskContracts(dir) }); }
    catch (error) { report.results.push({ id: name, passed: false, failureClass: 'verifier', error: String(error) }); }
  }
  for (const name of ['optimizer-surface', 'optimizer-isolation', 'optimizer-adopt', 'optimizer-dataset', 'optimizer-cost-manifest']) {
    const dir = join(directory, name);
    mkdirSync(dir);
    try { report.results.push({ id: name, passed: true, evidence: await runtime.verifyOptimizer(name, dir) }); }
    catch (error) { report.results.push({ id: name, passed: false, failureClass: 'verifier', error: String(error) }); }
  }
  for (const name of ['experience-records', 'experience-transfer', 'experience-retention', 'harness-release', 'pilot-gate', 'pilot-product-path', 'pilot-dispatch']) {
    const dir = join(directory, name);
    mkdirSync(dir);
    try { report.results.push({ id: name, passed: true, evidence: await runtime.verifyP6(name, dir) }); }
    catch (error) { report.results.push({ id: name, passed: false, failureClass: 'verifier', error: String(error) }); }
  }
  for (const name of ['memory-versions', 'skills-pinning']) {
    const dir = join(directory, name);
    mkdirSync(dir);
    try { report.results.push({ id: name, passed: true, evidence: await runtime.runMemorySkillScenario(name, dir) }); }
    catch (error) { report.results.push({ id: name, passed: false, failureClass: 'verifier', error: String(error) }); }
  }
  for (const observation of Object.values(report.knownDefects)) assert.equal(observation.observed, observation.expected);
  report.passed = report.results.length === expectedCaseCount && report.results.every(r => r.passed);
} catch (error) {
  report.error = String(error);
  report.failureClass = error.failureClass ?? 'infra';
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  report.durationMs = performance.now() - started;
  save('report.json', report);
  console.log(JSON.stringify({ passed: report.passed, cases: report.results.length, report: join(directory, 'report.json'), error: report.error }));
  if (!report.passed) process.exitCode = 1;
}
