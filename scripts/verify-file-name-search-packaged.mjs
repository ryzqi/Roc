import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const packageRoot = resolve(process.argv[2] ?? '.artifacts/pr3-packaged-app/mac-arm64/Roc.app');
const executablePath = join(packageRoot, 'Contents', 'MacOS', 'Roc');
const outputPath = resolve(process.argv[3] ?? '.artifacts/pr3-file-name-search-invalidation.json');
if (!existsSync(executablePath)) throw new Error(`packaged_app_executable_missing:${executablePath}`);
if (existsSync(outputPath)) throw new Error(`verification_output_already_exists:${outputPath}`);

const tempRoot = mkdtempSync(join(tmpdir(), 'roc-pr3-name-search-'));
const workspacePath = join(tempRoot, 'workspace');
const dataRoot = join(tempRoot, 'data');
const command = `node scripts/verify-file-name-search-packaged.mjs ${process.argv[2] ?? '.artifacts/pr3-packaged-app/mac-arm64/Roc.app'} ${process.argv[3] ?? '.artifacts/pr3-file-name-search-invalidation.json'}`;
mkdirSync(workspacePath);
let app = null;
let verificationError = null;
const cleanupErrors = [];
const results = {};

async function search(page, query) {
  return await page.evaluate(async (searchQuery) => {
    const result = await window.roc.files.searchByName({ query: searchQuery });
    if (!result.ok) throw new Error(`name_search_failed:${result.error.code}`);
    return result.data.matches.map((match) => match.relativePath);
  }, query);
}

async function waitForSearch(page, query, expectedPaths) {
  const startedAt = Date.now();
  const deadline = startedAt + 5_000;
  let actualPaths = [];
  while (Date.now() < deadline) {
    actualPaths = await search(page, query);
    if (JSON.stringify(actualPaths) === JSON.stringify(expectedPaths)) {
      return { elapsedMs: Date.now() - startedAt, paths: actualPaths };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  assert.deepEqual(actualPaths, expectedPaths, `search did not converge for ${query}`);
}

try {
  app = await electron.launch({
    executablePath,
    args: [],
    env: {
      ...process.env,
      ROC_SMOKE: '1',
      ROC_DATA_ROOT: dataRoot,
      ROC_SMOKE_API_KEY: 'smoke-test-key'
    }
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  const selected = await page.evaluate(async (path) => await window.roc.workspace.select({ path }), workspacePath);
  if (!selected.ok) throw new Error(`workspace_select_failed:${selected.error.code}`);
  assert.deepEqual(await search(page, 'watcher-created-marker'), []);

  writeFileSync(join(workspacePath, 'watcher-created-marker.txt'), 'created');
  results.create = await waitForSearch(page, 'watcher-created-marker', ['watcher-created-marker.txt']);

  const stagedPath = join(workspacePath, 'atomic-save-staging.tmp');
  const finalPath = join(workspacePath, 'atomic-save-final-document.md');
  writeFileSync(stagedPath, 'saved');
  renameSync(stagedPath, finalPath);
  results.atomicRename = await waitForSearch(page, 'atomic-save-final', ['atomic-save-final-document.md']);

  unlinkSync(finalPath);
  results.delete = await waitForSearch(page, 'atomic-save-final', []);
} catch (error) {
  verificationError = error;
} finally {
  try {
    if (app !== null) await app.close();
  } catch (error) {
    cleanupErrors.push(error);
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
}

function serializeError(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
}

const failure = verificationError ?? cleanupErrors[0] ?? null;
const artifact = {
  measuredAt: new Date().toISOString(),
  command,
  workingDirectory: process.cwd(),
  appBundle: packageRoot,
  platform: `${process.platform}-${process.arch}`,
  status: failure === null ? 'passed' : 'failed',
  results,
  ...(verificationError === null ? {} : { error: serializeError(verificationError) }),
  ...(cleanupErrors.length === 0 ? {} : { cleanupErrors: cleanupErrors.map(serializeError) })
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, status: artifact.status, results }, null, 2));
if (failure !== null) throw failure;
