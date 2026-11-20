import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { importTypeScriptModule } from './lib/bundle-ts.mjs';

const iterations = Number(process.argv[2] ?? 100);
if (!Number.isSafeInteger(iterations) || iterations <= 0) {
  throw new RangeError('file_name_snapshot_watcher_iterations_invalid');
}

const [fileServiceModule, watcherModule] = await Promise.all([
  importTypeScriptModule('src/main/services/file-service.ts', { platform: 'node' }),
  importTypeScriptModule('src/main/services/workspace-change-watcher-service.ts', { platform: 'node' })
]);
const workspacePath = await mkdtemp(join(tmpdir(), 'roc-file-name-watcher-benchmark-'));

try {
  const filePath = join(workspacePath, 'existing-file.md');
  await writeFile(filePath, 'initial');
  const workspace = { path: workspacePath, id: `workspace:${workspacePath}` };
  const workspaceService = { getCurrentWorkspace: () => workspace, requireWorkspace: () => workspace };
  const ripgrep = { isAvailable: () => false, search: async () => { throw new Error('unused'); } };
  const service = new fileServiceModule.FileService({}, { db: null }, workspaceService, ripgrep);
  const visitFiles = service.visitFiles.bind(service);
  let buildCount = 0;
  service.visitFiles = async (...args) => {
    buildCount += 1;
    return await visitFiles(...args);
  };

  let change;
  let invalidationCount = 0;
  const watcher = new watcherModule.WorkspaceChangeWatcherService({
    logger: { warn() {} },
    isKnownSnapshotPath: (path, relativePath) => service.hasFileNamePathSnapshotEntry(path, relativePath),
    onInvalidate: (path) => {
      invalidationCount += 1;
      service.invalidateFileNameSnapshot(path);
    },
    onChange() {},
    watch: (_path, _options, listener) => {
      change = listener;
      return { close() {}, on() {} };
    }
  });
  watcher.setWorkspace(workspacePath);

  const startedAt = performance.now();
  await service.searchByName({ query: 'existing' });
  for (let index = 0; index < iterations; index += 1) {
    await writeFile(filePath, `content-${index}`);
    change('change', 'existing-file.md');
    await service.searchByName({ query: 'existing' });
  }
  const elapsedMs = performance.now() - startedAt;
  watcher.shutdown();

  process.stdout.write(`${JSON.stringify({ iterations, buildCount, invalidationCount, elapsedMs: Number(elapsedMs.toFixed(3)) })}\n`);
} finally {
  await rm(workspacePath, { recursive: true, force: true });
}
