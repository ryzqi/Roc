import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTraceSummary, measureRendererWorkload} from '../../scripts/performance/renderer-workload-metrics.mjs';

test('trace summary resolves late thread metadata and excludes nested and non-renderer tasks from busy time', () => {
  const aggregate = createTraceSummary();
  aggregate.add([
    {pid: 1, tid: 2, ph: 'X', name: 'RunTask', dur: 60_000},
    {pid: 1, tid: 2, ph: 'X', name: 'FunctionCall', dur: 40_000},
    {pid: 1, tid: 2, ph: 'X', name: 'Layout', dur: 5_000},
    {pid: 1, tid: 2, ph: 'X', name: 'Paint', dur: 2_000},
    {pid: 1, tid: 3, ph: 'X', name: 'RunTask', dur: 900_000},
    {pid: 1, tid: 2, ph: 'X', name: 'RunTask', dur: -100},
    {pid: 1, tid: 2, ph: 'B', name: 'RunTask', dur: 90_000}
  ]);
  aggregate.add([
    {pid: 1, tid: 2, ph: 'M', name: 'thread_name', args: {name: 'CrRendererMain'}},
    {pid: 1, tid: 3, ph: 'M', name: 'thread_name', args: {name: 'Compositor'}},
    {pid: 1, tid: 2, ph: 'X', name: 'ThreadControllerImpl::RunTask', dur: 10_000}
  ]);
  const summary = aggregate.finish();
  assert.equal(summary.eventCount, 10);
  assert.equal(summary.rendererThreadCount, 1);
  assert.equal(summary.taskCount, 2);
  assert.equal(summary.busyMs, 70);
  assert.equal(summary.longTaskCount, 1);
  assert.equal(summary.longTaskMs, 60);
  assert.equal(summary.longestTaskMs, 60);
  assert.equal(summary.layoutMs, 5);
  assert.equal(summary.paintMs, 2);
});

test('missing renderer metadata stays explicit instead of treating all process threads as renderer work', () => {
  const aggregate = createTraceSummary();
  aggregate.add([{pid: 1, tid: 2, ph: 'X', name: 'RunTask', dur: 60_000}]);
  const summary = aggregate.finish();
  assert.equal(summary.eventCount, 1);
  assert.equal(summary.rendererThreadCount, 0);
  assert.equal(summary.busyMs, 0);
});

test('a failed initial renderer snapshot still detaches both CDP sessions and closes the requested trace file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'roc-trace-cleanup-'));
  const sessions = [];
  const page = {isClosed: () => false, evaluate: async () => null, context: () => ({
    async newCDPSession() {
      const session = Object.assign(new EventEmitter(), {detached: false,
        async send() {throw new Error('snapshot transport unavailable');},
        async detach() {this.detached = true;}});
      sessions.push(session);
      return session;
    }
  })};
  try {
    const path = join(directory, 'failure.trace.json');
    await assert.rejects(measureRendererWorkload(page, () => assert.fail('action must not run'), {rawTracePath: path}),
      /snapshot transport unavailable/u);
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every(session => session.detached));
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {traceEvents: []});
    assert.equal(sessions[0].listenerCount('Tracing.dataCollected'), 0);
  } finally {rmSync(directory, {recursive: true, force: true});}
});
