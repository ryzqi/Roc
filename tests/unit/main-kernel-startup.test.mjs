import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

test('failed kernel startup flushes application logs before immediate process exit', async () => {
  await mkdir(join(process.cwd(), '.runtime'), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), '.runtime/startup-regression-'));
  try {
    const entry = join(root, 'startup.mjs');
    await build({
      stdin: {
        contents: `
          import { createMainKernelBootstrap } from './src/main/main-kernel-bootstrap';
          const kernel = createMainKernelBootstrap({
            dataRoot: process.argv[2],
            safeStorage: {},
            plugins: []
          });
          kernel.runtime.start = async () => {
            throw new Error('fixture_startup_failure');
          };
          try {
            await kernel.start();
            process.exit(0);
          } catch (error) {
            console.error(error.message);
            process.exit(42);
          }
        `,
        resolveDir: process.cwd()
      },
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      loader: { '.c': 'text' },
      plugins: [{
        name: 'unused-electron-dialog',
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }));
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: 'export const dialog = { showOpenDialog() { throw new Error("unexpected_dialog"); } };'
          }));
        }
      }],
      logLevel: 'silent'
    });
    const dataRoot = join(root, 'data');
    const result = spawnSync(process.execPath, [entry, dataRoot], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.error, undefined);
    assert.doesNotMatch(result.stderr, /sonic boom is not ready yet/u);
    assert.equal(result.status, 42, result.stderr);
    assert.match(result.stderr, /fixture_startup_failure/u);
    const events = (await readFile(join(dataRoot, 'logs/app.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(event => event.level === 'error' && event.error?.message === 'fixture_startup_failure'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
