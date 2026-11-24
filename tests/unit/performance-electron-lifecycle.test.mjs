import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {closeBenchmarkElectron, launchBenchmarkElectron, recordBenchmarkFailure,
  withBenchmarkTimeout} from '../../scripts/performance/electron-lifecycle.mjs';
import {saveReport} from '../../scripts/performance/report-lib.mjs';

const never = () => new Promise(() => {});
async function childProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
  await once(child, 'spawn');
  return child;
}
async function dispose(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
}

test('startup passes a bounded launch timeout and preserves initializer order and result', async () => {
  const order = [], app = {};
  const result = await launchBenchmarkElectron({launch: async options => {
    assert.equal(options.timeout, 30_000); assert.deepEqual(options.args, ['main.js']);
    order.push('launch'); return app;
  }}, {args: ['main.js']}, async value => {
    assert.equal(value, app); order.push('ready'); return 'page';
  });
  assert.deepEqual(order, ['launch', 'ready']);
  assert.deepEqual(result, {app, value: 'page'});
});

test('a stuck initializer reports startup failure and waits for its owned process to exit', async () => {
  const child = await childProcess();
  let closeCalls = 0;
  const app = {process: () => child, close: async () => {closeCalls++; child.kill('SIGTERM');}};
  try {
    await assert.rejects(launchBenchmarkElectron({launch: async () => app}, {}, never, 20),
      error => error.benchmarkPhase === 'startup' && /benchmark_startup_timeout/u.test(error.message));
    assert.equal(closeCalls, 1);
    assert.equal(child.signalCode, 'SIGTERM', 'failure must not return before owned process exit');
  } finally {await dispose(child);}
});

test('a stuck close kills only its own process, preserves failure, and never repeats close', async () => {
  const child = await childProcess(), unrelated = await childProcess();
  let closeCalls = 0;
  const app = {process: () => child, close: () => {closeCalls++; return never();}};
  try {
    await assert.rejects(closeBenchmarkElectron(app, 20), /benchmark_close_timeout/u);
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
    await assert.rejects(closeBenchmarkElectron(app, 20), /benchmark_close_timeout/u);
    assert.equal(closeCalls, 1);
  } finally {await dispose(child); await dispose(unrelated);}
});

test('normal close waits for the captured process after Playwright releases its dispatcher', async () => {
  const child = await childProcess();
  let closed = false;
  const app = {
    process: () => {
      assert.equal(closed, false, 'Playwright process() is unavailable after close()');
      return child;
    },
    close: async () => {closed = true; child.kill('SIGTERM');}
  };
  try {
    await closeBenchmarkElectron(app);
    assert.equal(child.signalCode, 'SIGTERM');
    await closeBenchmarkElectron(app);
  } finally {await dispose(child);}
});

test('a rejected close also terminates the owned process without replacing the original error', async () => {
  const child = await childProcess(), failure = new Error('native_modal');
  try {
    await assert.rejects(closeBenchmarkElectron({process: () => child, close: async () => {throw failure;}}, 20),
      error => error === failure && error.benchmarkPhase === 'close');
    assert.equal(child.signalCode, 'SIGKILL');
  } finally {await dispose(child);}
});

test('a launch rejection is tagged and returned without creating a late unowned application', async () => {
  const failure = new Error('launch_failed');
  await assert.rejects(launchBenchmarkElectron({launch: async ({timeout}) => {
    assert.equal(timeout, 20); throw failure;
  }}, {}, () => assert.fail('initializer must not run'), 20),
  error => error === failure && error.benchmarkPhase === 'startup');
});

test('failure report preserves completed scenarios and cleanup evidence before disposable data is removed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'roc-electron-lifecycle-test-'));
  const profile = join(directory, 'profile'), output = join(directory, 'report.json');
  mkdirSync(profile);
  const report = {kind: 'fixture', source: {gitSha: 'fixture'}, fixtureSha256: 'fixture', host: {},
    scenarios: [{id: 'completed'}], limitations: []};
  try {
    try {
      try {await withBenchmarkTimeout('startup', never, 10);}
      catch (error) {recordBenchmarkFailure(report, error, 'events-10000'); throw error;}
    } catch {
      const cleanup = Object.assign(new Error('close_failed'), {benchmarkPhase: 'close'});
      recordBenchmarkFailure(report, cleanup, 'events-10000');
      saveReport(output, report);
    } finally {rmSync(profile, {recursive: true, force: true});}
    const saved = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(saved.status, 'failed');
    assert.equal(saved.failure.phase, 'startup');
    assert.equal(saved.failure.scenario, 'events-10000');
    assert.equal(saved.cleanupFailures[0].phase, 'close');
    assert.equal(saved.cleanupFailures.length, 1);
    assert.equal(saved.scenarios[0].id, 'completed');
    assert.match(readFileSync(output.replace('.json', '.md'), 'utf8'), /Status: failed/u);
    assert.equal(existsSync(profile), false);
  } finally {rmSync(directory, {recursive: true, force: true});}
});
