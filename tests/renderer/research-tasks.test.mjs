import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import { _electron } from '@playwright/test';

let directory, app, page;
const rendererErrors = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/task-ui');

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-renderer-research-tasks-'));
  mkdirSync(artifacts, { recursive: true });
  await esbuild.build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { ResearchTaskProgress } from './src/renderer/assistant/ResearchTaskProgress';
        import { ResearchTasksSection } from './src/renderer/management/sections/ResearchTasksSection';
        const root = createRoot(document.getElementById('root'));
        window.listeners = new Set();
        window.calls = [];
        window.opened = [];
        window.makeData = (projectId = 'project-a', taskId = 'task-a', chatId = 'chat-a') => {
          const association = (kind, executionId, parentKind, parentExecutionId) => ({
            schemaVersion: 1, taskId, projectId, kind, executionId, parentKind, parentExecutionId,
            associationSource: 'direct', manifestHash: 'a'.repeat(64), createdAt: '2026-11-03T00:00:00.000Z'
          });
          const execution = (kind, executionId, parentKind, parentExecutionId, status, artifactIds) => ({
            association: association(kind, executionId, parentKind, parentExecutionId),
            status, stage: kind === 'chat' ? null : kind === 'stage' ? 'discovery' : kind,
            providerId: kind === 'stage' ? 'fixture-provider' : null,
            modelId: kind === 'stage' ? 'fixture-model' : null, error: null, artifactIds,
            startedAt: '2026-11-03T00:00:00.000Z', endedAt: status === 'completed' ? '2026-11-03T00:00:01.000Z' : null
          });
          return {
            task: { schemaVersion: 2, id: taskId, projectId, goal: '验证科研任务 ' + taskId,
              rootAgentRunId: chatId, status: 'active', statusReason: null, deadlineClock: 'continuous',
              budgetPolicyVersion: 1, createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z' },
            budget: {
              tokens: {limit: 1000, settled: 80, unknown: 100, reserved: 50, remaining: 770},
              calls: {models: {limit: 10, total: 3, reserved: 1}, tools: {limit: 20, total: 2, reserved: 0}, children: {limit: 5, total: 1, reserved: 0}},
              cost: {state: 'unknown', limitMicrousd: null, settledMicrousd: 40, reservedMicrousd: 120},
              pricingCatalogVersion: 'fixture', deadlineAt: '2026-11-03T12:00:00.000Z', stopReason: null
            },
            executions: [
              execution('chat', chatId, null, null, 'completed', []),
              execution('stage', 'stage-a', 'chat', chatId, 'running', []),
              execution('figure', 'figure-a', 'stage', 'stage-a', 'completed', ['artifact-figure'])
            ],
            continuationRunId: null, canRestoreApproval: false, externalCost: 'unknown'
          };
        };
        window.deferred = () => {
          let resolve;
          const promise = new Promise(done => { resolve = done; });
          return {promise, resolve};
        };
        window.emit = (taskId = 'task-a', projectId = 'project-a') => {
          for (const listener of [...listeners]) listener({taskId, projectId});
        };
        const record = (method, request, response) => { calls.push({method, request}); return Promise.resolve(response); };
        window.client = {api: {research: {
          getTaskForChat: request => record('chat', request, window.response),
          getTaskDiagnostics: request => record('diagnostics', request, window.response),
          onTaskUpdated: listener => { listeners.add(listener); return () => listeners.delete(listener); },
          getTaskEvents: request => {
            const events = window.eventRows.filter(event => event.sequence > request.afterSequence);
            const slice = events.slice(0, request.limit);
            return record('events', request, {ok: true, data: {
              events: slice, nextSequence: slice.at(-1)?.sequence ?? request.afterSequence, hasMore: events.length > request.limit
            }});
          },
          listTasks: request => record('list', request, window.listResponse),
          pauseTask: request => record('pause', request, window.actionResponse),
          cancelTask: request => record('cancel', request, window.actionResponse),
          continueTask: request => record('continue', request, window.actionResponse),
          restoreTaskApproval: request => record('restore', request, window.actionResponse)
        }}};
        window.mount = (projectId = 'project-a', threadId = 'thread-a', runId = 'chat-a', runStatus = 'running') => flushSync(() => root.render(
          React.createElement(React.StrictMode, null, React.createElement(ResearchTaskProgress, {
            key: projectId + ':' + threadId + ':' + runId, client, projectId, threadId, runId, runStatus,
            onOpenTask: taskId => opened.push(taskId)
          }))
        ));
        window.mountDrawer = (taskId = 'task-a', projectId = 'project-a') => flushSync(() => root.render(
          React.createElement(React.StrictMode, null, React.createElement(ResearchTasksSection, {
            key: projectId, client, projectId, selectedTaskId: taskId,
            onSelectTask: taskId => mountDrawer(taskId, projectId)
          }))
        ));
        window.clear = () => flushSync(() => root.render(null));
        window.reset = () => {
          clear();
          calls = []; opened = [];
          response = {ok: true, data: makeData()};
          actionResponse = {ok: true, data: makeData().task};
          listResponse = {ok: true, data: {tasks: [makeData().task], nextTaskId: 'task-a', hasMore: false}};
          eventRows = Array.from({length: 51}, (_, index) => ({
            sequence: index + 1, taskId: 'task-a', eventType: 'call_settled', executionKind: 'stage',
            executionId: 'stage-a', callId: 'call-' + (index + 1), state: 'settled', reason: null,
            createdAt: '2026-11-03T00:00:01.000Z'
          }));
        };
        reset();
      `,
      resolveDir: process.cwd(), loader: 'js'
    },
    outfile: join(directory, 'tasks.js'), bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent'
  });
  const cssDirectory = join(process.cwd(), 'dist/renderer/assets');
  const css = readdirSync(cssDirectory).filter(name => name.endsWith('.css'))
    .map(name => readFileSync(join(cssDirectory, name), 'utf8')).join('\n');
  writeFileSync(join(directory, 'tasks.css'), css);
  writeFileSync(join(directory, 'index.html'), `<html data-theme="light"><link rel="stylesheet" href="tasks.css">
    <style>body {margin:0;padding:16px;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}
    #root {max-width:680px}</style><div id="root"></div><script src="tasks.js"></script></html>`);
  writeFileSync(join(directory, 'main.cjs'), `
    const {app, BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => {
      const window = new BrowserWindow({show: false, width: 760, height: 680});
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
  try { await app?.close(); }
  finally { if (directory) rmSync(directory, {recursive: true, force: true}); }
  assert.deepEqual(rendererErrors, []);
});

const ready = () => page.getByTestId('task-status').waitFor();

test('assistant reads authoritative budgets and progress, handles keyboard detail entry and scoped notifications', async () => {
  await page.evaluate(() => { reset(); mount(); });
  await ready();
  assert.equal(await page.getByTestId('task-progress').innerText(), '执行已完成 2/3');
  const text = await page.getByTestId('task-budget').innerText();
  for (const expected of ['已知 80', '未知 100', '预留 50', '剩余 770', '模型 3/10']) assert.ok(text.includes(expected));
  const details = page.getByTestId('assistant-task-details');
  await details.focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => opened), ['task-a']);
  const previous = await page.evaluate(() => calls.length);
  await page.evaluate(() => { for (let index = 0; index < 5; index++) mount(); emit('other-task'); emit('task-a', 'other-project'); });
  assert.equal(await page.evaluate(() => calls.length), previous);
  await page.evaluate(() => {
    response = {ok: true, data: {...makeData(), budget: {...makeData().budget,
      tokens: {...makeData().budget.tokens, settled: 95, remaining: 755}}}};
    emit();
  });
  await page.getByText('已知 95', {exact: true}).waitFor();
  await page.evaluate(() => clear());
  assert.equal(await page.evaluate(() => listeners.size), 0);
});

test('first trusted task linkage refreshes an unlinked chat and stale project responses never appear', async () => {
  await page.evaluate(() => { reset(); response = {ok: true, data: null}; mount(); });
  await page.waitForFunction(() => calls.length > 0 && !document.querySelector('[data-testid="assistant-task"]'));
  await page.evaluate(() => { response = {ok: true, data: makeData()}; emit(); });
  await ready();
  await page.evaluate(() => { reset(); window.oldRead = deferred(); response = oldRead.promise; mount(); });
  await page.waitForFunction(() => calls.length > 0);
  await page.evaluate(() => {
    response = {ok: true, data: makeData('project-b', 'task-b', 'chat-b')};
    mount('project-b', 'thread-b', 'chat-b');
  });
  await page.getByText('验证科研任务 task-b', {exact: true}).waitFor();
  await page.evaluate(() => oldRead.resolve({ok: true, data: makeData()}));
  assert.ok(!(await page.getByTestId('assistant-task').innerText()).includes('task-a'));
});

test('cancellation keeps cleanup pending after terminal invalidation and displays persistent cleanup failure', async () => {
  await page.evaluate(() => { reset(); window.cleanup = deferred(); actionResponse = cleanup.promise; mount(); });
  await ready();
  await page.getByTestId('task-cancel').click();
  await page.getByTestId('task-action-pending').waitFor();
  await page.evaluate(() => {
    const data = makeData();
    data.task.status = 'cancelled';
    data.continuationRunId = 'stage-a';
    response = {ok: true, data}; emit();
  });
  await page.getByTestId('task-status').filter({hasText: '已取消'}).waitFor();
  assert.equal(await page.getByTestId('task-continue').isDisabled(), true);
  assert.ok((await page.getByTestId('task-action-pending').innerText()).includes('等待资源清理'));
  await page.evaluate(() => {
    response.data.task.statusReason = 'research_task_cleanup_failed';
    cleanup.resolve({ok: false, error: {message: 'research_task_cleanup_failed'}});
  });
  await page.getByRole('alert').filter({hasText: 'research_task_cleanup_failed'}).waitFor();
  await page.getByTestId('task-reason').waitFor();
  assert.equal(await page.getByTestId('task-action-pending').count(), 0);
  assert.equal(await page.getByTestId('task-continue').count(), 0);
});

test('continuation and approval restoration only dispatch explicit actions with the original task identity', async () => {
  await page.evaluate(() => {
    reset();
    const data = makeData(); data.task.status = 'interrupted'; data.continuationRunId = 'stage-a';
    response = {ok: true, data}; mount();
  });
  await ready();
  assert.equal(await page.evaluate(() => calls.filter(call => call.method === 'continue').length), 0);
  await page.getByTestId('task-continue').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => calls.some(call => call.method === 'continue'));
  const request = await page.evaluate(() => calls.find(call => call.method === 'continue').request);
  assert.equal(request.taskId, 'task-a');
  assert.equal(request.projectId, 'project-a');
  assert.equal(request.runId, 'stage-a');
  assert.match(request.requestId, /^[0-9a-f-]{36}$/u);
  await page.evaluate(() => {
    reset();
    const data = makeData(); data.task.status = 'paused'; data.canRestoreApproval = true; data.continuationRunId = 'stage-a';
    response = {ok: true, data}; mount();
  });
  await ready();
  assert.equal(await page.getByTestId('task-continue').count(), 0);
  await page.getByTestId('task-restore-approval').click();
  await page.waitForFunction(() => calls.some(call => call.method === 'restore'));
  assert.deepEqual(await page.evaluate(() => calls.find(call => call.method === 'restore').request),
    {taskId: 'task-a', projectId: 'project-a'});
  assert.equal(await page.evaluate(() => calls.filter(call => call.method === 'continue').length), 0);
});

test('management renders parent execution tree, artifact IDs and cursor event replay without duplicate calls', async () => {
  await page.evaluate(() => { reset(); mountDrawer(); });
  await ready();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="mgmt-task-event"]').length === 50);
  assert.equal(await page.getByTestId('mgmt-task-execution').count(), 3);
  const tree = await page.getByTestId('mgmt-task-tree').innerText();
  assert.ok(tree.includes('fixture-provider / fixture-model'));
  assert.ok(tree.includes('artifact-figure'));
  assert.ok(tree.includes('耗时 1000 ms'));
  assert.equal(await page.getByTestId('mgmt-task-tree').locator('ol ol ol').count(), 1);
  await page.getByTestId('mgmt-task-events-more').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="mgmt-task-event"]').length === 51);
  const cursors = await page.evaluate(() => calls.filter(call => call.method === 'events').map(call => call.request.afterSequence));
  assert.ok(cursors.includes(50));
  const previous = await page.evaluate(() => calls.length);
  await page.evaluate(() => mountDrawer());
  assert.equal(await page.evaluate(() => calls.length), previous);
  await page.evaluate(() => {
    eventRows.push({...eventRows[0], sequence: 52, callId: 'call-52', eventType: 'call_unknown', state: 'unknown'}); emit();
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="mgmt-task-event"]').length === 52);
  assert.equal(await page.getByText('#52 调用消费未知', {exact: true}).count(), 1);
});

test('null tasks, failed reads and mismatched task identity remain explicit; drawer state clears across projects', async () => {
  await page.evaluate(() => { reset(); response = {ok: false, error: {message: 'task read failed'}}; mount(); });
  await page.getByRole('alert').filter({hasText: 'task read failed'}).waitFor();
  await page.evaluate(() => { response = {ok: true, data: makeData('foreign')}; });
  await page.getByRole('button', {name: '重试读取任务'}).click();
  await page.getByText('research_task_diagnostics_identity_mismatch', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('task-budget').count(), 0);
  await page.evaluate(() => { reset(); mountDrawer(); });
  await ready();
  await page.evaluate(() => {
    listResponse = {ok: true, data: {tasks: [], nextTaskId: null, hasMore: false}};
    mountDrawer(null, 'project-b');
  });
  await page.getByText('当前项目还没有科研任务。', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('mgmt-task-detail').count(), 0);
  assert.ok(!(await page.getByTestId('mgmt-research-tasks').innerText()).includes('artifact-figure'));
});

test('project task cursor loads another page and new-task invalidation refreshes the first page', async () => {
  await page.evaluate(() => {
    reset();
    listResponse.data.hasMore = true;
    mountDrawer(null);
  });
  await page.getByTestId('mgmt-task-list-more').waitFor();
  await page.evaluate(() => {
    listResponse = {ok: true, data: {tasks: [makeData('project-a', 'task-b', 'chat-b').task], nextTaskId: 'task-b', hasMore: false}};
  });
  await page.getByTestId('mgmt-task-list-more').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="mgmt-task-select"] option').length === 3);
  assert.equal(await page.evaluate(() => calls.filter(call => call.method === 'list').at(-1).request.afterTaskId), 'task-a');
  await page.evaluate(() => {
    listResponse = {ok: true, data: {tasks: [makeData('project-a', 'task-c', 'chat-c').task], nextTaskId: 'task-c', hasMore: false}};
    emit('task-c');
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="mgmt-task-select"]').textContent.includes('task-c'));
  assert.equal(await page.evaluate(() => calls.filter(call => call.method === 'list').at(-1).request.afterTaskId), null);
  assert.equal(await page.getByTestId('mgmt-task-select').locator('option[value="task-b"]').count(), 0);
  await page.evaluate(() => { mountDrawer('task-c'); });
  await page.getByText('research_task_diagnostics_identity_mismatch', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('mgmt-task-tree').count(), 0);
});

test('light and dark task layouts remain readable in narrow assistant and scrolling drawer', async () => {
  const auditSource = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  const receipts = [];
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(380, 680));
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; reset(); mount(); }, theme);
    await ready();
    await page.getByTestId('task-pause').hover();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(await page.getByTestId('task-pause').evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 12), true);
    await page.screenshot({path: join(artifacts, 'assistant-' + theme + '.png')});
    receipts.push({theme, surface: 'assistant', ...await page.evaluate(`(${auditSource})({viewport: true, root: '#root'})`)});
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(720, 560));
    await page.evaluate(() => mountDrawer());
    await ready();
    await page.getByTestId('mgmt-task-events-more').scrollIntoViewIfNeeded();
    await page.screenshot({path: join(artifacts, 'drawer-' + theme + '.png')});
    receipts.push({theme, surface: 'drawer', ...await page.evaluate(`(${auditSource})({viewport: true, root: '#root'})`)});
  }
  writeFileSync(join(artifacts, 'clip-audit.json'), JSON.stringify(receipts, null, 2));
  for (const receipt of receipts) assert.equal(receipt.cut, 0);
});
