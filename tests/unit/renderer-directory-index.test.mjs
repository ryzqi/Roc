import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

let WorkspaceDirectoryIndex, workspaceDirectoryIndex;
before(async () => {
  const result = await build({entryPoints: ['src/renderer/workspace/directory-index.ts'], bundle: true,
    platform: 'node', format: 'esm', write: false, logLevel: 'silent'});
  ({WorkspaceDirectoryIndex, workspaceDirectoryIndex} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`));
});

function fixture(read) {
  let listener = null, subscriptions = 0, removals = 0;
  const calls = [];
  const client = {api: {files: {listTree: request => {calls.push(request.relativePath); return read(request);}},
    workspace: {onChanged: callback => {listener = callback; subscriptions++; return () => {listener = null; removals++;};}}}};
  return {client, calls, emit: event => listener?.({workspacePath: '/project', relativePath: event, eventType: 'change'}),
    counts: () => ({subscriptions, removals})};
}
const result = (relativePath = '', name = 'draft.tex', workspacePath = '/project') => ({ok: true,
  data: {workspacePath, relativePath, truncated: false, entries: [{name, relativePath: name, type: 'file', size: 1, updatedAt: '2026-11-23'}]}});

test('sidebar and writing share in-flight listings and exactly one workspace watcher', async () => {
  let finish;
  const source = fixture(() => new Promise(resolve => {finish = resolve;}));
  const tree = workspaceDirectoryIndex(source.client, '/project');
  const writer = workspaceDirectoryIndex(source.client, '/project');
  assert.equal(tree, writer);
  const offTree = tree.subscribe(() => {}), offWriter = writer.subscribe(() => {});
  const first = tree.read(''), second = writer.read('');
  assert.equal(first, second);assert.deepEqual(source.calls, ['']);
  finish(result());await first;
  assert.equal(tree.read(''), first);
  offWriter();assert.deepEqual(source.counts(), {subscriptions: 1, removals: 0});
  assert.equal(tree.read(''), first);
  offTree();assert.deepEqual(source.counts(), {subscriptions: 1, removals: 1});
  const again = tree.read('');assert.notEqual(again, first);finish(result());await again;
});

test('invalidated in-flight responses cannot replace the new directory listing', async () => {
  const pending = [];
  const source = fixture(() => new Promise(resolve => pending.push(resolve)));
  const index = new WorkspaceDirectoryIndex(source.client, '/project');
  const first = index.read('');index.invalidate('draft.tex');const second = index.read('');
  pending[1](result('', 'new.tex'));await second;
  pending[0](result('', 'old.tex'));await first;
  assert.equal((await index.read('')).data.entries[0].name, 'new.tex');
  assert.equal(source.calls.length, 2);
});

test('directory rename invalidates descendants while keeping unrelated cached directories', async () => {
  const source = fixture(async ({relativePath}) => result(relativePath));
  const index = new WorkspaceDirectoryIndex(source.client, '/project');
  const paths = ['', 'chapters', 'chapters/nested', 'references'];
  await Promise.all(paths.map(path => index.read(path)));source.calls.length = 0;
  index.invalidate('chapters');
  await Promise.all(paths.map(path => index.read(path)));
  assert.deepEqual(source.calls, ['', 'chapters', 'chapters/nested']);
});

test('burst refresh retains every changed directory and stops when the last consumer leaves', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const source = fixture(async ({relativePath}) => result(relativePath));
  const index = new WorkspaceDirectoryIndex(source.client, '/project');
  const batches = [];
  const off = index.subscribe(targets => batches.push([...targets].sort()));
  await Promise.all(['', 'chapters', 'refs'].map(path => index.read(path)));
  source.emit('main.tex');source.emit('chapters/one.tex');source.emit('refs/main.bib');
  assert.deepEqual(batches, [['']]);
  t.mock.timers.tick(200);
  assert.deepEqual(batches, [[''], ['', 'chapters', 'refs']]);
  source.emit('main.tex');source.emit(null);off();t.mock.timers.tick(200);
  assert.equal(batches.length, 3);
  assert.equal(source.counts().removals, 1);
});

test('workspace mismatch is surfaced and distinct workspace indexes never share data', async () => {
  const source = fixture(async () => result('', 'foreign.tex', '/foreign'));
  const index = workspaceDirectoryIndex(source.client, '/project');
  const foreign = workspaceDirectoryIndex(source.client, '/foreign');
  assert.notEqual(index, foreign);assert.equal(workspaceDirectoryIndex(source.client, null), null);
  assert.equal((await index.read('')).ok, false);
  assert.equal((await foreign.read('')).data.entries[0].name, 'foreign.tex');
});

test('failures remain explicit until invalidation retries the actual backend', async () => {
  let fail = true;
  const source = fixture(async () => fail ? {ok: false, error: {message: 'offline'}} : result());
  const index = new WorkspaceDirectoryIndex(source.client, '/project');
  assert.deepEqual(await index.read(''), {ok: false, error: {message: 'offline'}});
  fail = false;index.invalidate();assert.equal((await index.read('')).ok, true);
  assert.equal(source.calls.length, 2);
});
