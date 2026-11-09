import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import { _electron } from '@playwright/test';

let directory, app, page;
const rendererErrors = [];

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-renderer-diagnostics-'));
  await esbuild.build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { RunDiagnostics } from './src/renderer/assistant/RunDiagnostics';
        import { createEmptyContextContractAudit, createEmptyTrace } from './src/shared/schemas/run-diagnostics';
        const root = createRoot(document.getElementById('root'));
        window.calls = [];
        window.makeData = (runId = 'run-a', threadId = 'thread-a') => ({
          runId, threadId, providerId: 'fixture-provider', modelId: 'fixture-model',
          totalDurationMs: 80,
          model: {callCount: 2, unknownUsageCallCount: 1, inputTokens: null, outputTokens: 0, totalTokens: null, cacheReadTokens: null, cacheCreationTokens: null},
          tool: {callCount: 3, errorCount: 0},
          subagent: {count: 0, failedCount: 0, maxDepth: 0},
          context: {compactionCount: 0, summaryCount: 0, artifactCount: 0, failureCount: 0, estimatedCount: 0,
            inputTokens: null, capacityTokens: null, lastInputEstimated: null, removedChars: 0, persistedChars: 0,
            contractAudit: createEmptyContextContractAudit()},
          toolAdmission: {acquisitionCount: 0, cancellationCount: 0, contendedCount: 0, fallbackCount: 0,
            wait: {count: 0, totalMs: 0, maxMs: 0}, hold: {count: 0, totalMs: 0, maxMs: 0},
            conflicts: {app_run: 0, background_tasks: 0, global_config: 0, global_fallback: 0, memory: 0, network: 0, research: 0, workspace: 0}},
          trace: createEmptyTrace(), terminalStatus: null
        });
        window.response = {ok: true, data: window.makeData()};
        window.client = {api: {agent: {getRunDiagnostics: request => {
          window.calls.push(request);
          return Promise.resolve(window.response);
        }}}};
        window.mount = (runId = 'run-a', threadId = 'thread-a', runStatus = 'running') => flushSync(() => root.render(
          React.createElement(React.StrictMode, null, React.createElement(RunDiagnostics, {
            key: threadId + ':' + runId, client: window.client, runId, threadId, runStatus
          }))
        ));
        window.clear = () => flushSync(() => root.render(null));
        window.deferred = () => {
          let resolve;
          const promise = new Promise(done => { resolve = done; });
          return {promise, resolve};
        };
      `,
      resolveDir: process.cwd(),
      loader: 'js'
    },
    outfile: join(directory, 'diagnostics.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    logLevel: 'silent'
  });
  writeFileSync(join(directory, 'index.html'), '<div id="root"></div><script src="diagnostics.js"></script>');
  writeFileSync(join(directory, 'main.cjs'), `
    const {app, BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => {
      const window = new BrowserWindow({show: false});
      window.loadFile(${JSON.stringify(join(directory, 'index.html'))});
    });
  `);
  app = await _electron.launch({ executablePath: electronPath, args: [join(directory, 'main.cjs')] });
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.waitForFunction(() => typeof window.mount === 'function');
});

after(async () => {
  try {
    await app?.close();
  } finally {
    if (directory) rmSync(directory, {recursive: true, force: true});
  }
  assert.deepEqual(rendererErrors, []);
});

async function reset() {
  await page.evaluate(() => {
    clear();
    calls = [];
    response = {ok: true, data: makeData()};
    mount();
  });
}

test('diagnostics stays local on demand and disclosure works by keyboard', async () => {
  await reset();
  assert.equal(await page.evaluate(() => calls.length), 0);
  const toggle = page.getByTestId('assistant-diagnostics-toggle');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('assistant-diagnostics-data').waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => calls.length), 1);
  const text = await page.getByTestId('assistant-diagnostics-data').innerText();
  assert.ok(text.includes('未知 / 0'), 'unknown input usage is not rendered as zero');
  assert.equal(await page.getByTestId('assistant-diagnostics-data').locator('dl > div')
    .filter({hasText: 'usage 未知调用'}).locator('dd').innerText(), '1');
  assert.ok(text.includes('尚未压缩'), 'absence of audit is not reported as success');
  const refresh = page.getByTestId('assistant-diagnostics-refresh');
  await refresh.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => calls.length === 2);
  await toggle.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.getByTestId('assistant-diagnostics-region').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'assistant-diagnostics-toggle');
});

test('open disclosure refreshes on lifecycle transition but not unrelated rerenders', async () => {
  await reset();
  await page.getByTestId('assistant-diagnostics-toggle').click();
  await page.getByTestId('assistant-diagnostics-data').waitFor();
  await page.evaluate(() => {
    for (let index = 0; index < 10; index++) mount();
  });
  assert.equal(await page.evaluate(() => calls.length), 1);
  await page.evaluate(() => {
    response = {ok: true, data: {...makeData(), totalDurationMs: 123, terminalStatus: 'completed'}};
    mount('run-a', 'thread-a', 'completed');
  });
  await page.waitForFunction(() => calls.length === 2);
  await page.getByText('123 ms', {exact: true}).waitFor();
});

test('switching thread drops data immediately and late response never appears', async () => {
  await reset();
  await page.evaluate(() => { window.oldRead = deferred(); response = oldRead.promise; });
  await page.getByTestId('assistant-diagnostics-toggle').click();
  await page.waitForFunction(() => calls.length === 1);
  await page.evaluate(() => {
    response = {ok: true, data: makeData('run-b', 'thread-b')};
    mount('run-b', 'thread-b', 'completed');
  });
  assert.equal(await page.getByTestId('assistant-diagnostics-region').count(), 0);
  await page.getByTestId('assistant-diagnostics-toggle').click();
  await page.getByTestId('assistant-diagnostics-data').waitFor();
  await page.evaluate(() => oldRead.resolve({ok: true, data: {...makeData(), providerId: 'stale-provider'}}));
  assert.ok(!(await page.getByTestId('assistant-diagnostics-data').innerText()).includes('stale-provider'));
});

test('null record, backend error, and identity mismatch remain distinct', async () => {
  await reset();
  await page.evaluate(() => { response = {ok: true, data: null}; });
  await page.getByTestId('assistant-diagnostics-toggle').click();
  await page.getByText('该运行没有诊断记录。', {exact: true}).waitFor();
  await page.evaluate(() => { response = {ok: false, error: {message: 'diagnostics unavailable'}}; });
  await page.getByTestId('assistant-diagnostics-refresh').click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('alert').innerText(), 'diagnostics unavailable');
  await page.evaluate(() => { response = {ok: true, data: makeData('wrong-run', 'thread-a')}; });
  await page.getByTestId('assistant-diagnostics-refresh').click();
  await page.getByText('运行诊断身份不匹配', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('assistant-diagnostics-data').count(), 0);
});

test('bounded trace shows correlation, failure, unknown usage, and signed estimate error', async () => {
  await reset();
  await page.evaluate(() => {
    const data = makeData();
    data.context.compactionCount = 1;
    data.context.contractAudit = {...data.context.contractAudit, constraintCount: 2, missingEvidenceLocatorCount: 1};
    data.trace = {
      droppedSpanCount: 4,
      spans: [{
        spanId: 'span-1', operationId: 'operation-1', parentSpanId: null, checkpointId: null,
        operation: 'run', status: 'running', startOffsetMs: 0, durationMs: null,
        estimatedInputTokens: null, actualInputTokens: null, actualOutputTokens: null, estimateApproximate: null
      }, {
        spanId: 'span-2', operationId: 'operation-2', parentSpanId: 'span-1', checkpointId: 'checkpoint-1',
        operation: 'summary_model', status: 'failed', startOffsetMs: 4, durationMs: 12,
        estimatedInputTokens: 20, actualInputTokens: 30, actualOutputTokens: 4, estimateApproximate: true
      }]
    };
    response = {ok: true, data};
  });
  await page.getByTestId('assistant-diagnostics-toggle').click();
  await page.getByTestId('assistant-diagnostics-data').waitFor();
  assert.ok((await page.getByTestId('assistant-diagnostics-data').innerText()).includes('缺失 1 项'));
  const spans = page.getByTestId('assistant-diagnostics-spans');
  await spans.locator('summary').focus();
  await page.keyboard.press('Enter');
  const text = await spans.innerText();
  assert.ok(text.includes('超限未保留 4'));
  assert.ok(text.includes('父级 span-1'));
  assert.ok(text.includes('checkpoint-1'));
  assert.ok(text.includes('失败 / 12 ms'));
  assert.ok(text.includes('误差 -10'));
});
