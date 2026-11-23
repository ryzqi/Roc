import {before, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
let ui, values;
before(async () => {
  const result = await build({entryPoints: ['src/renderer/app/ui-state.ts'], bundle: true,
    platform: 'node', format: 'esm', write: false, logLevel: 'silent'});
  ui = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});
beforeEach(() => {
  values = new Map();
  globalThis.window = {localStorage: {getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)}};
});
test('legacy widths initialize independent scopes and resetting one scope preserves its neighbours', () => {
  values.set(ui.uiStateKeys.sidebarWidth, '300'); values.set(ui.uiStateKeys.assistantWidth, '600');
  assert.deepEqual(ui.readWorkspaceLayout('a', 'research'), {sidebarWidth: 300, assistantWidth: 520, collapsed: false});
  ui.writeWorkspaceLayout('a', 'writing', {sidebarWidth: 280, assistantWidth: 400, collapsed: false});
  ui.writeWorkspaceLayout('a', 'research', ui.defaultWorkspaceLayout('research'));
  assert.equal(ui.readWorkspaceLayout('a', 'writing').assistantWidth, 400);
  assert.equal(ui.readWorkspaceLayout('b', 'research').sidebarWidth, 300);
  assert.deepEqual(ui.readWorkspaceLayout('a', 'research'), ui.defaultWorkspaceLayout('research'));
});
test('malformed preferences and unavailable storage fall back without throwing', () => {
  values.set(ui.uiStateKeys.workspaceLayouts, '{');
  assert.deepEqual(ui.readWorkspaceLayout('a', 'writing'), ui.defaultWorkspaceLayout('writing'));
  values.set(ui.uiStateKeys.workspaceLayouts, JSON.stringify({'["a","research"]': {sidebarWidth: -5, assistantWidth: 999, collapsed: 'false'}}));
  assert.deepEqual(ui.readWorkspaceLayout('a', 'research'), {sidebarWidth: 200, assistantWidth: 520, collapsed: false});
  globalThis.window = {get localStorage() {throw new Error('blocked');}};
  assert.doesNotThrow(() => ui.writeWorkspaceLayout('a', 'research', ui.defaultWorkspaceLayout('research')));
  assert.deepEqual(ui.readWorkspaceLayout('a', 'research'), ui.defaultWorkspaceLayout('research'));
});
test('layout history retains only the sixty most recently written presentation scopes', () => {
  for (let i = 0; i < 60; i++) ui.writeWorkspaceLayout(String(i), 'research', {sidebarWidth: 260, assistantWidth: 400, collapsed: false});
  ui.writeWorkspaceLayout('0', 'research', {sidebarWidth: 300, assistantWidth: 420, collapsed: false});
  ui.writeWorkspaceLayout('60', 'research', ui.defaultWorkspaceLayout('research'));
  assert.equal(Object.keys(JSON.parse(values.get(ui.uiStateKeys.workspaceLayouts))).length, 60);
  assert.equal(ui.readWorkspaceLayout('0', 'research').sidebarWidth, 300);
  assert.equal(ui.readWorkspaceLayout('1', 'research').sidebarWidth, 232);
});
