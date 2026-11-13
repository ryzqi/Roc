import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const {MacOSHostService} = await importTypeScriptModule('src/main/macos-host-service.ts');
const {createDiagnosticsLifecycleAdapter} = await importTypeScriptModule('src/main/plugins/diagnostics/lifecycle-adapter.ts');
const backgroundTasks = {total: 0, running: 0, pendingConfirmation: 0, failed: 0, nextRunAt: null};
const summary = (backgroundPaused = false) => ({
  residentEnabled: true, backgroundPaused, backgroundTasks, nextRunAt: null, updatedAt: '2026-11-12T00:00:00Z'
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
function host(lifecycle = {}) {
  const state = {menus: [], tooltips: [], errors: [], created: 0, destroyed: 0, broadcasts: 0};
  const service = new MacOSHostService({
    isPackaged: false,
    app: {requestSingleInstanceLock: () => true, on() {}, quit() {}, setLoginItemSettings() {},
      getLoginItemSettings: () => ({openAtLogin: false})},
    globalShortcut: {register: () => true, unregister() {}, unregisterAll() {}},
    lifecycleService: {getTraySummary: () => summary(), pauseBackgroundExecution: () => summary(true),
      resumeBackgroundExecution: () => summary(false), ...lifecycle},
    logService: {info() {}, warn() {}, error: (...args) => state.errors.push(args)},
    menu: {buildFromTemplate: items => {state.menus.push(items); return items;}},
    trayIconPath: '/unused/tray.png',
    createTray: () => {
      state.created++;
      return {setToolTip: value => state.tooltips.push(value), setContextMenu() {}, destroy: () => state.destroyed++};
    },
    openMainPage() {}, broadcastTaskUpdated: () => state.broadcasts++, broadcastWindowHidden() {}
  });
  return {service, state, mutation: () => state.menus.at(-1)?.[1]};
}

test('tray refresh handles synchronous failures and promise rejections without creating a tray', async () => {
  for (const getTraySummary of [
    () => {throw new Error('summary unavailable');},
    () => Promise.reject(new Error('summary unavailable'))
  ]) {
    const {service, state} = host({getTraySummary});
    assert.doesNotThrow(() => service.refreshTray());
    await nextTurn();
    assert.equal(state.created, 0);
    assert.equal(state.errors.length, 1);
  }
});

test('a stale tray read cannot replace the newer completed pause state', async () => {
  const read = deferred();
  let reads = 0;
  const {service, state, mutation} = host({getTraySummary: () => ++reads === 1 ? summary() : read.promise});
  service.refreshTray();
  service.refreshTray();
  mutation().click();
  await nextTurn();
  assert.equal(state.tooltips.at(-1), 'Roc 已暂停后台执行');
  read.resolve(summary(false));
  await nextTurn();
  assert.equal(state.tooltips.at(-1), 'Roc 已暂停后台执行');
  assert.equal(state.broadcasts, 1);
});

test('tray mutations lock immediately, keep the real state, and recover after a failed request', async () => {
  const write = deferred();
  let writes = 0;
  const {service, state, mutation} = host({pauseBackgroundExecution: () => {
    writes++;
    return writes === 1 ? write.promise : summary(true);
  }});
  service.refreshTray();
  const click = mutation().click;
  click(); click();
  assert.equal(writes, 1);
  assert.equal(mutation().enabled, false);
  assert.match(mutation().label, /正在暂停/);
  assert.equal(state.tooltips.at(-1), 'Roc 正在后台运行');
  write.reject(new Error('scheduler unavailable'));
  await nextTurn();
  assert.equal(state.broadcasts, 0);
  assert.equal(state.errors.length, 1);
  assert.equal(mutation().enabled, true);
  mutation().click();
  await nextTurn();
  assert.equal(state.broadcasts, 1);
  assert.equal(state.tooltips.at(-1), 'Roc 已暂停后台执行');
});

test('shutdown invalidates tray reads and mutations and cannot recreate a destroyed tray', async () => {
  const read = deferred();
  const first = host({getTraySummary: () => read.promise});
  first.service.refreshTray();
  first.service.shutdown();
  read.resolve(summary());
  await nextTurn();
  first.service.refreshTray();
  assert.equal(first.state.created, 0);

  const write = deferred();
  const second = host({pauseBackgroundExecution: () => write.promise});
  second.service.refreshTray();
  second.mutation().click();
  second.service.shutdown();
  const tooltipCount = second.state.tooltips.length;
  write.resolve(summary(true));
  await nextTurn();
  second.service.shutdown();
  assert.equal(second.state.destroyed, 1);
  assert.equal(second.state.tooltips.length, tooltipCount);
  assert.equal(second.state.broadcasts, 0);
});

test('the lifecycle adapter reports pause only after the scheduler succeeds and retains state on failure', async () => {
  const pause = deferred();
  const adapter = createDiagnosticsLifecycleAdapter({
    getBackgroundTaskSummary: () => backgroundTasks,
    scheduler: {suspendAll: () => pause.promise, resumeAll() {}}
  });
  const pending = adapter.pauseBackgroundExecution();
  assert.equal((await adapter.getTraySummary()).backgroundPaused, false);
  pause.reject(new Error('pause failed'));
  await assert.rejects(pending, /pause failed/);
  assert.equal((await adapter.getTraySummary()).backgroundPaused, false);
});

test('opposing lifecycle mutations run in order and expose their actual settled state', async () => {
  const pause = deferred();
  const calls = [];
  const adapter = createDiagnosticsLifecycleAdapter({
    getBackgroundTaskSummary: () => backgroundTasks,
    scheduler: {suspendAll: () => {calls.push('pause'); return pause.promise;},
      resumeAll: () => {calls.push('resume');}}
  });
  const pendingPause = adapter.pauseBackgroundExecution();
  const pendingResume = adapter.resumeBackgroundExecution();
  assert.deepEqual(calls, ['pause']);
  pause.resolve();
  assert.equal((await pendingPause).backgroundPaused, true);
  assert.equal((await pendingResume).backgroundPaused, false);
  assert.deepEqual(calls, ['pause', 'resume']);
});
