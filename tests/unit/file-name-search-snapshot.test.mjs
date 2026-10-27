import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const fileServiceModule = await importTypeScriptModule('src/main/services/file-service.ts', { platform: 'node' });
const watcherModule = await importTypeScriptModule('src/main/services/workspace-change-watcher-service.ts', { platform: 'node' });
const tempRoot = mkdtempSync(join(tmpdir(), 'roc-file-name-snapshot-'));

after(() => rmSync(tempRoot, { recursive: true, force: true }));

function createWorkspace(name) {
  const root = join(tempRoot, name);
  mkdirSync(root, { recursive: true });
  return root;
}

function createFileService(root, options = {}) {
  const workspace = { path: root, id: `workspace:${root}` };
  const workspaceService = {
    getCurrentWorkspace: () => workspace,
    requireWorkspace: () => workspace,
    resolveInsideWorkspace: (relativePath) => join(workspace.path, relativePath)
  };
  const ripgrep = { isAvailable: () => false, search: async () => { throw new Error('unused'); } };
  const paths = { tasksDir: join(tempRoot, `recovery-${root.split('/').at(-1)}`) };
  const database = { db: { prepare: () => ({ run() {} }) } };
  const service = new fileServiceModule.FileService(paths, database, workspaceService, ripgrep, options);
  return { service, workspace };
}

function names(result) {
  return result.matches.map(({ name, relativePath }) => [name, relativePath]);
}

test('reuses the path snapshot until explicitly invalidated', async () => {
  const root = createWorkspace('reuse');
  writeFileSync(join(root, 'first-report.md'), '');
  const { service } = createFileService(root);

  assert.deepEqual(names(await service.searchByName({ query: 'first' })), [['first-report.md', 'first-report.md']]);
  writeFileSync(join(root, 'second-report.md'), '');
  assert.deepEqual(names(await service.searchByName({ query: 'second' })), []);

  service.invalidateFileNameSnapshot(root);
  assert.deepEqual(names(await service.searchByName({ query: 'second' })), [['second-report.md', 'second-report.md']]);
});

test('application file writes invalidate only when the indexed path set changes', async () => {
  const root = createWorkspace('application-file-mutations');
  const diagnostics = [];
  const { service } = createFileService(root, { onPathSnapshotDiagnostic: (event) => diagnostics.push(event) });

  assert.deepEqual(names(await service.searchByName({ query: 'created' })), []);
  await service.writeTextFile({ relativePath: 'nested/created-file.md', content: 'first', source: 'test' });
  assert.deepEqual(names(await service.searchByName({ query: 'created' })), [['created-file.md', 'nested/created-file.md']]);
  await service.writeTextFile({ relativePath: 'nested/created-file.md', content: 'updated', source: 'test' });
  assert.deepEqual(names(await service.searchByName({ query: 'created' })), [['created-file.md', 'nested/created-file.md']]);

  await service.deleteFile('nested/created-file.md');
  assert.deepEqual(names(await service.searchByName({ query: 'created' })), []);
  assert.deepEqual(diagnostics.filter((event) => event.event === 'invalidation').map(({ reason }) => reason), [
    'files.writeText.created',
    'files.delete'
  ]);
  assert.deepEqual(diagnostics.filter((event) => event.event === 'build').map(({ buildCount, reason, committed }) => ({ buildCount, reason, committed })), [
    { buildCount: 1, reason: 'initial', committed: true },
    { buildCount: 2, reason: 'files.writeText.created', committed: true },
    { buildCount: 3, reason: 'files.delete', committed: true }
  ]);
});

test('concurrent first queries share one path traversal', async () => {
  const root = createWorkspace('concurrent');
  writeFileSync(join(root, 'alpha.md'), '');
  writeFileSync(join(root, 'beta.md'), '');
  const { service } = createFileService(root);
  const visitFiles = service.visitFiles.bind(service);
  let traversals = 0;
  let releaseTraversal;
  const gate = new Promise((resolve) => { releaseTraversal = resolve; });
  service.visitFiles = async (...args) => {
    traversals += 1;
    await gate;
    return visitFiles(...args);
  };

  const alpha = service.searchByName({ query: 'alpha' });
  const beta = service.searchByName({ query: 'beta' });
  assert.equal(traversals, 1);
  releaseTraversal();
  assert.deepEqual(names(await alpha), [['alpha.md', 'alpha.md']]);
  assert.deepEqual(names(await beta), [['beta.md', 'beta.md']]);
});

test('workspace changes do not reuse paths from the previous root', async () => {
  const firstRoot = createWorkspace('workspace-one');
  const secondRoot = createWorkspace('workspace-two');
  writeFileSync(join(firstRoot, 'first-project-only.md'), '');
  writeFileSync(join(secondRoot, 'second-project-only.md'), '');
  const { service, workspace } = createFileService(firstRoot);

  assert.deepEqual(names(await service.searchByName({ query: 'first' })), [['first-project-only.md', 'first-project-only.md']]);
  workspace.path = secondRoot;
  workspace.id = 'workspace-two';
  service.invalidateAllFileNameSnapshots();
  assert.deepEqual(names(await service.searchByName({ query: 'first' })), []);
  assert.deepEqual(names(await service.searchByName({ query: 'second' })), [['second-project-only.md', 'second-project-only.md']]);
});

test('an invalidated in-flight build cannot replace the current snapshot generation', async () => {
  const root = createWorkspace('inflight-invalidation');
  const { service } = createFileService(root);
  const visitFiles = service.visitFiles.bind(service);
  let traversals = 0;
  let releaseFirstTraversal;
  const firstTraversalGate = new Promise((resolve) => { releaseFirstTraversal = resolve; });
  service.visitFiles = async (...args) => {
    traversals += 1;
    if (traversals === 1) await firstTraversalGate;
    return visitFiles(...args);
  };

  const firstQuery = service.searchByName({ query: 'new' });
  writeFileSync(join(root, 'new-file.md'), '');
  service.invalidateFileNameSnapshot(root, 'watcher.path-structure');
  service.invalidateFileNameSnapshot(root, 'watcher.path-structure');
  service.invalidateFileNameSnapshot(root, 'watcher.path-structure');
  const currentQuery = service.searchByName({ query: 'new' });
  assert.equal(traversals, 1);

  releaseFirstTraversal();
  assert.deepEqual(names(await currentQuery), [['new-file.md', 'new-file.md']]);
  assert.deepEqual(names(await firstQuery), [['new-file.md', 'new-file.md']]);
  assert.equal(traversals, 2);
});

test('a stale search does not rebuild its previous workspace after selection changes', async () => {
  const firstRoot = createWorkspace('stale-search-first');
  const secondRoot = createWorkspace('stale-search-second');
  writeFileSync(join(firstRoot, 'first-only.md'), '');
  writeFileSync(join(secondRoot, 'second-only.md'), '');
  const { service, workspace } = createFileService(firstRoot);
  const visitFiles = service.visitFiles.bind(service);
  let traversals = 0;
  let releaseFirstTraversal;
  const firstTraversalGate = new Promise((resolve) => { releaseFirstTraversal = resolve; });
  service.visitFiles = async (...args) => {
    traversals += 1;
    if (traversals === 1) await firstTraversalGate;
    return visitFiles(...args);
  };

  const staleQuery = service.searchByName({ query: 'first' });
  workspace.path = secondRoot;
  workspace.id = 'workspace:second-selection';
  service.invalidateAllFileNameSnapshots();
  assert.deepEqual(names(await service.searchByName({ query: 'second' })), [['second-only.md', 'second-only.md']]);

  releaseFirstTraversal();
  await assert.rejects(staleQuery, { code: 'file_name_search_workspace_changed' });
  assert.equal(traversals, 2);
});

test('a cached snapshot is periodically reconciled on the next query', async () => {
  const root = createWorkspace('reconcile');
  writeFileSync(join(root, 'before.md'), '');
  const reconcileMs = 60_000;
  const { service } = createFileService(root, { pathSnapshotReconcileMs: reconcileMs });
  await service.searchByName({ query: 'before' });
  writeFileSync(join(root, 'after.md'), '');
  assert.deepEqual(names(await service.searchByName({ query: 'after' })), []);
  service.fileNamePathSnapshots.get(root).snapshot.builtAt -= reconcileMs + 1;

  assert.deepEqual(names(await service.searchByName({ query: 'after' })), [['after.md', 'after.md']]);
});

test('preserves ignored directories, symlink exclusion, Unicode, ranking, and top-20 behavior', async () => {
  const root = createWorkspace('filters');
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'docs', 'node_modules'), { recursive: true });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  mkdirSync(join(root, '目录'), { recursive: true });
  writeFileSync(join(root, 'docs', 'report-long-name.md'), '');
  writeFileSync(join(root, 'docs', 'node_modules', 'nested-secret-report.md'), '');
  writeFileSync(join(root, 'report.md'), '');
  writeFileSync(join(root, '.git'), 'a regular file with an ignored directory name');
  writeFileSync(join(root, '目录', '分析-report.md'), '');
  writeFileSync(join(root, 'node_modules', 'secret-report.md'), '');
  symlinkSync(join(root, 'report.md'), join(root, 'linked-report.md'));
  for (let index = 0; index < 20; index += 1) {
    writeFileSync(join(root, `report-${String(index).padStart(2, '0')}.md`), '');
  }
  const { service } = createFileService(root);

  const result = await service.searchByName({ query: 'rpt', maxResults: 20 });
  assert.equal(result.matches.length, 20);
  assert.equal(result.truncated, true);
  assert.deepEqual(names(result)[0], ['report.md', 'report.md']);
  assert.ok(names(result).every(([, path]) => !path.startsWith('node_modules/')));
  assert.ok(names(result).every(([, path]) => path !== 'linked-report.md'));
  assert.deepEqual(names(await service.searchByName({ query: '.git' })), [['.git', '.git']]);
  assert.deepEqual(names(await service.searchByName({ query: '分析' })), [['分析-report.md', '目录/分析-report.md']]);
});

test('an empty query preserves traversal order and reports truncation at the result limit', async () => {
  const root = createWorkspace('empty-query');
  const { service } = createFileService(root);
  service.visitFiles = async (_root, visit) => {
    for (let index = 0; index < 24; index += 1) {
      if (await visit(join(root, `suggestion-${String(index).padStart(2, '0')}.md`))) return true;
    }
    return false;
  };

  const result = await service.searchByName({ query: '', maxResults: 20 });
  assert.deepEqual(names(result).slice(0, 2), [
    ['suggestion-00.md', 'suggestion-00.md'],
    ['suggestion-01.md', 'suggestion-01.md']
  ]);
  assert.equal(result.matches.length, 20);
  assert.equal(result.truncated, true);
});

test('the path snapshot enforces the 20,000-file ceiling even when the query has no matches', async () => {
  const root = createWorkspace('ceiling');
  const { service } = createFileService(root);
  let visited = 0;
  service.visitFiles = async (_root, visit) => {
    for (let index = 0; index < 20_001; index += 1) {
      visited += 1;
      if (await visit(join(root, `file-${index}.md`))) return true;
    }
    return false;
  };

  const result = await service.searchByName({ query: 'does-not-match' });
  assert.equal(visited, 20_001);
  assert.deepEqual(names(result), []);
  assert.equal(result.truncated, true);
});

test('known content changes publish events without rebuilding for each write', async () => {
  const root = createWorkspace('watcher-content-changes');
  const filePath = join(root, 'existing-file.md');
  writeFileSync(filePath, 'initial');
  const diagnostics = [];
  const invalidations = [];
  const published = [];
  const { service } = createFileService(root, { onPathSnapshotDiagnostic: (event) => diagnostics.push(event) });
  const visitFiles = service.visitFiles.bind(service);
  let traversals = 0;
  service.visitFiles = async (...args) => {
    traversals += 1;
    return await visitFiles(...args);
  };
  let changed;
  const watcher = new watcherModule.WorkspaceChangeWatcherService({
    debounceMs: 5,
    logger: { warn() {} },
    onInvalidate: (workspacePath, reason) => {
      invalidations.push(reason);
      service.invalidateFileNameSnapshot(workspacePath, reason);
    },
    isKnownSnapshotPath: (workspacePath, relativePath) => service.hasFileNamePathSnapshotEntry(workspacePath, relativePath),
    onChange: (event) => { published.push(event); },
    watch: (_path, _options, listener) => {
      changed = listener;
      return { close() {}, on() {} };
    }
  });
  watcher.setWorkspace(root);
  await service.searchByName({ query: 'existing' });

  for (let index = 0; index < 100; index += 1) {
    writeFileSync(filePath, `content-${index}`);
    changed('change', 'existing-file.md');
    await service.searchByName({ query: 'existing' });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(traversals, 1);
  assert.deepEqual(invalidations, []);
  assert.deepEqual(diagnostics.filter((event) => event.event === 'build').map(({ buildCount, durationMs, reason, committed }) => ({ buildCount, durationMs, reason, committed })), [
    { buildCount: 1, durationMs: diagnostics.find((event) => event.event === 'build').durationMs, reason: 'initial', committed: true }
  ]);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0], { workspacePath: root, relativePath: 'existing-file.md', eventType: 'change' });
  watcher.shutdown();
});

test('a new path reported as a content change invalidates the snapshot', async () => {
  const root = createWorkspace('watcher-unindexed-content-path');
  const { service } = createFileService(root);
  await service.searchByName({ query: 'new-file' });
  const invalidations = [];
  let changed;
  const watcher = new watcherModule.WorkspaceChangeWatcherService({
    logger: { warn() {} },
    isKnownSnapshotPath: (workspacePath, relativePath) => service.hasFileNamePathSnapshotEntry(workspacePath, relativePath),
    onInvalidate: (workspacePath, reason) => {
      invalidations.push(reason);
      service.invalidateFileNameSnapshot(workspacePath, reason);
    },
    onChange() {},
    watch: (_path, _options, listener) => {
      changed = listener;
      return { close() {}, on() {} };
    }
  });
  watcher.setWorkspace(root);

  writeFileSync(join(root, 'new-file.md'), '');
  changed('change', 'new-file.md');

  assert.deepEqual(invalidations, ['watcher.unindexed-content-path']);
  assert.deepEqual(names(await service.searchByName({ query: 'new-file' })), [['new-file.md', 'new-file.md']]);
  watcher.shutdown();
});

test('watcher events invalidate immediately, then publish the debounced workspace event', async () => {
  const root = createWorkspace('watcher-event');
  writeFileSync(join(root, 'before.md'), '');
  const { service } = createFileService(root);
  await service.searchByName({ query: 'after' });
  const invalidations = [];
  const published = [];
  let changed;
  const watcher = new watcherModule.WorkspaceChangeWatcherService({
    debounceMs: 5,
    logger: { warn() {} },
    onInvalidate: (workspacePath) => {
      invalidations.push(workspacePath);
      service.invalidateFileNameSnapshot(workspacePath);
    },
    onChange: (event) => { published.push(event); },
    watch: (_path, _options, listener) => {
      changed = listener;
      return { close() {}, on() {} };
    }
  });
  watcher.setWorkspace(root);

  writeFileSync(join(root, 'after.md'), '');
  changed('rename', 'after.md');
  assert.deepEqual(invalidations, [root]);
  assert.deepEqual(names(await service.searchByName({ query: 'after' })), [['after.md', 'after.md']]);
  assert.deepEqual(published, []);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(published.length, 1);
  assert.deepEqual(published[0], { workspacePath: root, relativePath: 'after.md', eventType: 'rename' });
  watcher.shutdown();
});

test('watcher preserves whitespace-prefixed filenames when applying ignored-directory filters', async () => {
  const invalidations = [];
  const published = [];
  let changed;
  const watcher = new watcherModule.WorkspaceChangeWatcherService({
    debounceMs: 5,
    logger: { warn() {} },
    onInvalidate: (workspacePath) => invalidations.push(workspacePath),
    onChange: (event) => { published.push(event); },
    watch: (_path, _options, listener) => {
      changed = listener;
      return { close() {}, on() {} };
    }
  });
  watcher.setWorkspace('/whitespace-workspace');

  changed('rename', ' node_modules');
  assert.deepEqual(invalidations, ['/whitespace-workspace']);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(published, [{
    workspacePath: '/whitespace-workspace',
    relativePath: ' node_modules',
    eventType: 'rename'
  }]);
  watcher.shutdown();
});

test('watcher events under file-search-excluded paths do not invalidate the name snapshot', async () => {
  const invalidations = [];
  const published = [];
  let changed;
  const watcher = new watcherModule.WorkspaceChangeWatcherService({
    debounceMs: 5,
    logger: { warn() {} },
    onInvalidate: (workspacePath) => invalidations.push(workspacePath),
    onChange: (event) => { published.push(event); },
    watch: (_path, _options, listener) => {
      changed = listener;
      return { close() {}, on() {} };
    }
  });
  watcher.setWorkspace('/git-workspace');

  changed('change', '.git/index');
  assert.deepEqual(invalidations, []);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(published, [{
    workspacePath: '/git-workspace',
    relativePath: '.git/index',
    eventType: 'change'
  }]);
  watcher.shutdown();
});

test('watcher invalidates conservatively when the final path component names an ignored directory', () => {
  const invalidations = [];
  let changed;
  const watcher = new watcherModule.WorkspaceChangeWatcherService({
    logger: { warn() {} },
    onInvalidate: (workspacePath) => invalidations.push(workspacePath),
    onChange() {},
    watch: (_path, _options, listener) => {
      changed = listener;
      return { close() {}, on() {} };
    }
  });
  watcher.setWorkspace('/git-workspace');

  changed('change', '.git/index');
  changed('change', '.git');
  changed('rename', 'docs/node_modules');
  assert.deepEqual(invalidations, ['/git-workspace']);
  watcher.shutdown();
});

test('watcher invalidates unknown filenames and unknown event types conservatively', () => {
  const invalidations = [];
  let changed;
  const watcher = new watcherModule.WorkspaceChangeWatcherService({
    logger: { warn() {} },
    isKnownSnapshotPath: (_workspacePath, relativePath) => relativePath === 'known.md',
    onInvalidate: (workspacePath, reason) => invalidations.push([workspacePath, reason]),
    onChange() {},
    watch: (_path, _options, listener) => {
      changed = listener;
      return { close() {}, on() {} };
    }
  });
  watcher.setWorkspace('/unknown-events');

  changed('change', 'known.md');
  changed('rename', null);
  changed('change', Buffer.alloc(0));
  changed('other', 'unknown-event.md');
  changed('rename', 'known.md');
  assert.deepEqual(invalidations, [
    ['/unknown-events', 'watcher.unknown-filename'],
    ['/unknown-events', 'watcher.unknown-filename'],
    ['/unknown-events', 'watcher.unknown-event-type'],
    ['/unknown-events', 'watcher.path-structure']
  ]);
  watcher.shutdown();
});

test('watcher startup and runtime failures invalidate snapshots for reconciliation', () => {
  const invalidations = [];
  const watcher = new watcherModule.WorkspaceChangeWatcherService({
    logger: { warn() {} },
    onInvalidate: (workspacePath, reason) => invalidations.push([workspacePath, reason]),
    onChange() {},
    watch: () => { throw new Error('watch_failed'); }
  });
  watcher.setWorkspace('/startup-failure');
  assert.deepEqual(invalidations, [['/startup-failure', 'watcher.start-failed']]);

  let onError;
  const running = new watcherModule.WorkspaceChangeWatcherService({
    logger: { warn() {} },
    onInvalidate: (workspacePath, reason) => invalidations.push([workspacePath, reason]),
    onChange() {},
    watch: () => ({ close() {}, on: (_event, listener) => { onError = listener; } })
  });
  running.setWorkspace('/runtime-failure');
  onError(new Error('watch_failed'));
  assert.deepEqual(invalidations, [
    ['/startup-failure', 'watcher.start-failed'],
    ['/runtime-failure', 'watcher.runtime-failed']
  ]);
  running.shutdown();
});

test('late callbacks from a closed workspace watcher are ignored', async () => {
  const invalidations = [];
  const published = [];
  const callbacks = new Map();
  const watcher = new watcherModule.WorkspaceChangeWatcherService({
    debounceMs: 5,
    logger: { warn() {} },
    onInvalidate: (workspacePath) => invalidations.push(workspacePath),
    onChange: (event) => { published.push(event); },
    watch: (workspacePath, _options, listener) => {
      callbacks.set(workspacePath, listener);
      return { close() {}, on() {} };
    }
  });
  watcher.setWorkspace('/old-workspace');
  watcher.setWorkspace('/new-workspace');
  callbacks.get('/old-workspace')('rename', 'late.md');
  assert.deepEqual(invalidations, []);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(published, []);

  callbacks.get('/new-workspace')('rename', 'current.md');
  assert.deepEqual(invalidations, ['/new-workspace']);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(published, [{ workspacePath: '/new-workspace', relativePath: 'current.md', eventType: 'rename' }]);
  watcher.shutdown();
});

test('callbacks from an earlier watcher generation stay stale after switching back to its path', () => {
  const invalidations = [];
  const callbacks = [];
  const watcher = new watcherModule.WorkspaceChangeWatcherService({
    logger: { warn() {} },
    onInvalidate: (workspacePath) => invalidations.push(workspacePath),
    onChange() {},
    watch: (_workspacePath, _options, listener) => {
      callbacks.push(listener);
      return { close() {}, on() {} };
    }
  });
  watcher.setWorkspace('/same-workspace');
  watcher.setWorkspace('/away');
  watcher.setWorkspace('/same-workspace');

  callbacks[0]('rename', 'late.md');
  assert.deepEqual(invalidations, []);
  callbacks[2]('rename', 'current.md');
  assert.deepEqual(invalidations, ['/same-workspace']);
  watcher.shutdown();
});
