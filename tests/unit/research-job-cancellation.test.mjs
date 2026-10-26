import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const { runResearchJob } = await importTypeScriptModule('src/main/plugins/research/research-job.ts', {
  platform: 'node',
  tempDir: join(repositoryRoot, '.runtime/tmp')
});
const { summarizeOcrCleanupErrors, summarizeOcrOperationErrors, withOcrSessionScope } = await importTypeScriptModule(
  'src/main/plugins/research/ocr-session-scope.ts'
);

async function createJobRoot() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-research-job-cancel-'));
  const projectRoot = join(temporaryRoot, 'project');
  await mkdir(projectRoot);
  const sourcePath = join(projectRoot, 'source.txt');
  await writeFile(sourcePath, 'source');
  return { temporaryRoot, projectRoot, sourcePath, outputDir: join(projectRoot, 'output') };
}

test('research job forwards its timeout signal to the running operation', async () => {
  const job = await createJobRoot();
  let operationSignal;
  let finishOperation;
  const operationFinished = new Promise((resolve) => { finishOperation = resolve; });

  try {
    await assert.rejects(runResearchJob({
      projectRoot: job.projectRoot,
      sourcePath: job.sourcePath,
      outputDir: job.outputDir,
      maxSourceBytes: 100,
      sourceExtensions: ['.txt'],
      timeoutMs: 20
    }, async (_paths, signal) => {
      operationSignal = signal;
      return await new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          setImmediate(() => {
            resolve({ completedAfterAbort: true });
            finishOperation();
          });
        }, { once: true });
      });
    }), (error) => error.code === 'research_process_timeout');

    assert.ok(operationSignal instanceof AbortSignal);
    assert.equal(operationSignal.aborted, true);
    await operationFinished;
  } finally {
    await rm(job.temporaryRoot, { recursive: true, force: true });
  }
});

test('research job forwards external cancellation to the running operation', async () => {
  const job = await createJobRoot();
  const controller = new AbortController();
  let operationSignal;
  let finishOperation;
  const operationFinished = new Promise((resolve) => { finishOperation = resolve; });

  try {
    await assert.rejects(runResearchJob({
      projectRoot: job.projectRoot,
      sourcePath: job.sourcePath,
      outputDir: job.outputDir,
      maxSourceBytes: 100,
      sourceExtensions: ['.txt'],
      timeoutMs: 5_000,
      signal: controller.signal
    }, async (_paths, signal) => {
      operationSignal = signal;
      setImmediate(() => controller.abort());
      return await new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          setImmediate(() => {
            resolve({ completedAfterAbort: true });
            finishOperation();
          });
        }, { once: true });
      });
    }), (error) => error.code === 'research_process_cancelled');

    assert.ok(operationSignal instanceof AbortSignal);
    assert.equal(operationSignal.aborted, true);
    await operationFinished;
  } finally {
    await rm(job.temporaryRoot, { recursive: true, force: true });
  }
});

test('research job waits for OCR disposal on abort and exposes release errors', async () => {
  const job = await createJobRoot();
  let runnerSettled = false;
  let runnerSettledAtRelease;
  let inferencePending = false;
  let inferenceWasSettledAtRelease;
  let finishOperation;
  const operationFinished = new Promise((resolve) => { finishOperation = resolve; });
  const releaseError = new Error('release_failed_after_timeout');
  const cancellationError = Object.assign(new Error('research_process_cancelled'), {
    code: 'research_process_cancelled'
  });

  try {
    const resultPromise = runResearchJob({
      projectRoot: job.projectRoot,
      sourcePath: job.sourcePath,
      outputDir: job.outputDir,
      maxSourceBytes: 100,
      sourceExtensions: ['.txt'],
      timeoutMs: 20,
      awaitOperationCleanupOnAbort: true
    }, async (_paths, signal) => await withOcrSessionScope(async (register) => {
      register({ release: async () => {
        runnerSettledAtRelease = runnerSettled;
        inferenceWasSettledAtRelease = !inferencePending;
        throw releaseError;
      } });
      inferencePending = true;
      return await new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => {
            inferencePending = false;
            reject(cancellationError);
          }, 50);
        }, { once: true });
      });
    }).finally(() => finishOperation())).then((result) => {
      runnerSettled = true;
      return result;
    }, (error) => {
      runnerSettled = true;
      return error;
    });

    const error = await resultPromise;
    await operationFinished;
    assert.equal(error.code, 'research_process_timeout');
    assert.equal(runnerSettledAtRelease, false);
    assert.equal(inferenceWasSettledAtRelease, true);
    assert.deepEqual(error.cleanupErrors, [releaseError]);
  } finally {
    await rm(job.temporaryRoot, { recursive: true, force: true });
  }
});

test('research job keeps late operation failures separate from release failures', async () => {
  const job = await createJobRoot();
  const releaseEvents = [];
  const lateOperationError = new Error('late_inference_failed');

  try {
    await assert.rejects(runResearchJob({
      projectRoot: job.projectRoot,
      sourcePath: job.sourcePath,
      outputDir: job.outputDir,
      maxSourceBytes: 100,
      sourceExtensions: ['.txt'],
      timeoutMs: 20,
      awaitOperationCleanupOnAbort: true
    }, async (_paths, signal) => await withOcrSessionScope(async (register) => {
      register({ release: async () => { releaseEvents.push('released'); } });
      return await new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => reject(lateOperationError), 50);
        }, { once: true });
      });
    })), (error) => {
      assert.equal(error.code, 'research_process_timeout');
      assert.deepEqual(error.operationErrors, [lateOperationError]);
      assert.equal(error.cleanupErrors, undefined);
      return true;
    });

    assert.deepEqual(releaseEvents, ['released']);
  } finally {
    await rm(job.temporaryRoot, { recursive: true, force: true });
  }
});

test('research job separates frozen late parse and release failures', async () => {
  const job = await createJobRoot();
  const lateParseError = Object.freeze(new Error('late_parse_failed'));
  const releaseError = new Error('release_failed_after_timeout');

  try {
    await assert.rejects(runResearchJob({
      projectRoot: job.projectRoot,
      sourcePath: job.sourcePath,
      outputDir: job.outputDir,
      maxSourceBytes: 100,
      sourceExtensions: ['.txt'],
      timeoutMs: 20,
      awaitOperationCleanupOnAbort: true
    }, async (_paths, signal) => await withOcrSessionScope(async (register) => {
      register({ release: async () => { throw releaseError; } });
      return await new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => reject(lateParseError), 50);
        }, { once: true });
      });
    })), (error) => {
      assert.equal(error.code, 'research_process_timeout');
      assert.deepEqual(error.operationErrors, [lateParseError]);
      assert.deepEqual(error.cleanupErrors, [releaseError]);
      assert.deepEqual(summarizeOcrOperationErrors(error), ['Error: late_parse_failed']);
      assert.deepEqual(summarizeOcrCleanupErrors(error), ['Error: release_failed_after_timeout']);
      return true;
    });
  } finally {
    await rm(job.temporaryRoot, { recursive: true, force: true });
  }
});
