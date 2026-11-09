import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import { _electron, expect } from '@playwright/test';

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
        import { ProjectBudgetSection } from './src/renderer/management/sections/ProjectBudgetSection';
        const root = createRoot(document.getElementById('root'));
        window.listeners = new Set();
        window.budgetListeners = new Set();
        window.chatListeners = new Set();
        window.calls = [];
        window.opened = [];
        window.makeData = (projectId = 'project-a', taskId = 'task-a', chatId = 'chat-a') => {
          const association = (kind, executionId, parentKind, parentExecutionId) => ({
            schemaVersion: 3, taskId, projectId, kind, executionId, parentKind, parentExecutionId,
            nodeBinding: {kind: 'none'}, origin: {kind: 'main', action: 'start', requestId: executionId},
            frozenInputs: {schemaVersion: 1, requestHash: 'a'.repeat(64), manifestHash: 'a'.repeat(64), policyHash: 'a'.repeat(64), versions: []},
            associationState: 'confirmed',
            associationSource: 'direct', manifestHash: 'a'.repeat(64), createdAt: '2026-11-03T00:00:00.000Z'
          });
          const execution = (kind, executionId, parentKind, parentExecutionId, status, artifactIds) => ({
            association: association(kind, executionId, parentKind, parentExecutionId),
            status, stage: kind === 'chat' ? null : kind === 'stage' ? 'discovery' : kind,
            providerId: kind === 'stage' ? 'fixture-provider' : null,
            modelId: kind === 'stage' ? 'fixture-model' : null, error: null, artifacts: artifactIds.map(id => ({id, version: 'a'.repeat(64), versionSource: 'current_inspector', state: 'present'})), telemetry: null,
            startedAt: '2026-11-03T00:00:00.000Z', endedAt: status === 'completed' ? '2026-11-03T00:00:01.000Z' : null
          });
          return {
            task: { schemaVersion: 3, id: taskId, projectId, goal: '验证科研任务 ' + taskId,
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
            graph: {revision: 0, nodes: [], edges: []}, continuationRunId: null, canRestoreApproval: false, externalCost: 'unknown',
            recoveryIssues: [], eventDelivery: {pending: 0, failed: 0}
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
        window.client = {api: {chat: {onRunEvent: listener => {
          chatListeners.add(listener); return () => chatListeners.delete(listener);
        }}, research: {
          getProjectBudget: request => record('budget', request, window.budgetResponse),
          saveProjectBudget: request => record('budget-save', request, window.budgetActionResponse),
          onProjectBudgetUpdated: listener => { budgetListeners.add(listener); return () => budgetListeners.delete(listener); },
          getTaskForChat: request => record('chat', request, window.response),
          getTaskDiagnostics: request => record('diagnostics', request, window.response),
          getTaskExecutionDiagnostics: request => {
            calls.push({method: 'observations', request});
            if (window.observationResponse !== null) return Promise.resolve(window.observationResponse);
            const callsPage = window.observationCalls.filter(call => call.sequence > request.afterCallSequence);
            const eventsPage = window.observationEvents.filter(event => event.sequence > request.afterEventSequence);
            const selectedCalls = callsPage.slice(0, request.limit), selectedEvents = eventsPage.slice(0, request.limit);
            return Promise.resolve({ok: true, data: {
              telemetry: window.observationTelemetry, resources: null,
              calls: {calls: selectedCalls, nextSequence: selectedCalls.at(-1)?.sequence ?? request.afterCallSequence, hasMore: callsPage.length > request.limit},
              replay: {events: selectedEvents, nextSequence: selectedEvents.at(-1)?.sequence ?? request.afterEventSequence,
                hasMore: eventsPage.length > request.limit, gap: request.afterEventSequence === 0 ? {throughSequence: 10, historyComplete: false} : null}
            }});
          },
          exportTaskDiagnostics: request => record('diagnostics-export', request, window.exportResponse),
          getTaskFacts: request => record('facts', request, window.factsResponse),
          saveTaskFacts: request => {
            calls.push({method: 'facts-save', request});
            if (window.factSaveDeferred) return window.factSaveDeferred.promise;
            if (window.factSaveError) return Promise.resolve({ok: false, error: {message: window.factSaveError}});
            const snapshot = {contractVersion: 1, taskId: request.taskId, projectId: request.projectId,
              revision: request.expectedRevision + 1, entries: request.entries, createdAt: '2026-11-06T00:00:00.000Z',
              savedBy: {kind: 'user', id: 'window:71'}, snapshotHash: 'a'.repeat(64)};
            window.factHistory.unshift(snapshot);
            window.factsResponse = {ok: true, data: {snapshot, freshness: request.entries.flatMap(entry =>
              entry.sources.map((source, sourceIndex) => ({entryId: entry.id, sourceIndex, state: 'current', reason: null}))),
              authority: 'research_data_only'}};
            return Promise.resolve({ok: true, data: snapshot});
          },
          getTaskFactsHistory: request => record('facts-history', request, {ok: true, data: {
            snapshots: window.factHistory, nextRevision: null, hasMore: false
          }}),
          onTaskUpdated: listener => { listeners.add(listener); return () => listeners.delete(listener); },
          getTaskEvents: request => {
            const events = window.eventRows.filter(event => event.sequence > request.afterSequence);
            const slice = events.slice(0, request.limit);
            return record('events', request, {ok: true, data: {
              events: slice, nextSequence: slice.at(-1)?.sequence ?? request.afterSequence, hasMore: events.length > request.limit, gap: null
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
        window.mountBudget = (projectId = 'project-a') => flushSync(() => root.render(
          React.createElement(React.StrictMode, null, React.createElement(ProjectBudgetSection, {key: projectId, client, projectId}))
        ));
        window.makeProjectBudget = (projectId = 'project-a', revision = 1) => ({
          projectId, policyVersion: 1, revision, limits: {maxTotalTokens: 200, maxModelCalls: 2, maxConcurrentModelCalls: 1, maxCostMicrousd: null},
          tokens: {settled: 80, unknown: 100, reserved: 0, remaining: 20},
          models: {total: 1, reserved: 0}, cost: {state: 'unknown', settledMicrousd: 40, reservedMicrousd: 100},
          stopReason: null, updatedAt: '2026-11-03T00:00:00.000Z'
        });
        window.clear = () => flushSync(() => root.render(null));
        window.reset = () => {
          clear();
          calls = []; opened = [];
          budgetResponse = {ok: true, data: null};
          budgetActionResponse = {ok: true, data: makeProjectBudget()};
          response = {ok: true, data: makeData()};
          actionResponse = {ok: true, data: makeData().task};
          factSaveError = null; factSaveDeferred = null; factHistory = [];
          observationResponse = null; observationTelemetry = null;
          exportResponse = {ok: true, data: {path: '/local/diagnostics/task.json', size: 512, sha256: 'c'.repeat(64),
            createdAt: '2026-11-06T00:00:00.000Z', redacted: true, externalTrace: 'not_exported'}};
          observationCalls = Array.from({length: 51}, (_, i) => ({sequence: i + 1, runId: 'chat-a', callId: 'measured-call-' + (i + 1),
            kind: 'model', state: 'unknown', reservedTokens: 100, actualTokens: null, reservedCostMicrousd: 60,
            actualCostMicrousd: null, pricingVersion: null, createdAt: '2026-11-06T00:00:00.000Z', settledAt: null,
            invocation: i === 0 ? {startedAt: '2026-11-06T00:00:00.000Z', durationMs: 17, status: 'failed'} : null}));
          observationEvents = Array.from({length: 51}, (_, i) => ({sequence: i + 11, type: 'assistant_block',
            toolCallId: 'tool-call-' + (i + 1), status: 'error', failed: true, createdAt: '2026-11-06T00:00:00.000Z'}));
          factsResponse = {ok: true, data: {snapshot: null, freshness: [], authority: 'research_data_only'}};
          listResponse = {ok: true, data: {tasks: [makeData().task], nextTaskId: 'task-a', hasMore: false}};
          eventRows = Array.from({length: 51}, (_, index) => ({
            schemaVersion: 1, eventId: 'event-' + (index + 1), streamId: 'task:task-a', projectId: 'project-a',
            taskId: 'task-a', runId: 'stage-a', sequence: index + 1, eventType: 'call_settled',
            actor: {kind: 'main', id: 'task-ledger'}, correlationId: 'task-a', causationId: null,
            payloadHash: 'a'.repeat(64), payloadRef: null,
            payload: {taskId: 'task-a', executionKind: 'stage', executionId: 'stage-a',
              callId: 'call-' + (index + 1), state: 'settled', reason: null},
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
    eventRows.push({...eventRows[0], eventId: 'event-52', sequence: 52, eventType: 'call_unknown',
      payload: {...eventRows[0].payload, callId: 'call-52', state: 'unknown'}}); emit();
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

test('project budget requires explicit configuration and saving preserves integer amounts and original revision', async () => {
  await page.evaluate(() => { reset(); mountBudget(); });
  await page.getByText('尚未配置项目预算，模型调用已禁用。', {exact: true}).waitFor();
  await page.getByTestId('mgmt-project-budget-edit').click();
  assert.equal(await page.getByTestId('mgmt-project-budget-save').isDisabled(), true);
  await page.getByTestId('mgmt-project-budget-tokens').fill('200');
  await page.getByTestId('mgmt-project-budget-models').fill('2');
  await page.getByTestId('mgmt-project-budget-concurrency').fill('1');
  await page.evaluate(() => { window.pendingSave = deferred(); budgetActionResponse = pendingSave.promise; });
  await page.getByTestId('mgmt-project-budget-save').click();
  assert.equal(await page.getByTestId('mgmt-project-budget-tokens').isDisabled(), true);
  await page.evaluate(() => {
    budgetResponse = {ok: true, data: makeProjectBudget()};
    pendingSave.resolve({ok: true, data: makeProjectBudget()});
  });
  await page.getByTestId('mgmt-project-budget-data').waitFor();
  assert.deepEqual(await page.evaluate(() => calls.find(call => call.method === 'budget-save').request), {
    projectId: 'project-a', expectedRevision: 0,
    limits: {maxTotalTokens: 200, maxModelCalls: 2, maxConcurrentModelCalls: 1, maxCostMicrousd: null}
  });
  assert.ok((await page.getByTestId('mgmt-project-budget-data').innerText()).includes('未知 100'));
  await page.evaluate(() => clear());
  assert.equal(await page.evaluate(() => listeners.size + budgetListeners.size + chatListeners.size), 0);
});

test('project budget draft keeps its original revision through live updates and rejects invalid integer inputs', async () => {
  await page.evaluate(() => { reset(); budgetResponse = {ok: true, data: makeProjectBudget()}; mountBudget(); });
  await page.getByTestId('mgmt-project-budget-data').waitFor();
  await page.getByTestId('mgmt-project-budget-edit').click();
  await page.getByTestId('mgmt-project-budget-tokens').fill('1.5');
  assert.equal(await page.getByTestId('mgmt-project-budget-save').isDisabled(), true);
  await expect(page.getByRole('textbox', {name: '项目 Token 总额', exact: true})).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('mgmt-project-budget-tokens')).toHaveAccessibleDescription('请输入有效的正整数');
  await page.getByTestId('mgmt-project-budget-tokens').fill('300');
  await expect(page.getByTestId('mgmt-project-budget-tokens')).not.toHaveAttribute('aria-invalid', 'true');
  await page.getByTestId('mgmt-project-budget-cost').fill('-1');
  await expect(page.getByTestId('mgmt-project-budget-cost')).toHaveAttribute('aria-invalid', 'true');
  assert.equal(await page.getByTestId('mgmt-project-budget-save').isDisabled(), true);
  await page.getByTestId('mgmt-project-budget-cost').fill('100000');
  await expect(page.getByRole('textbox', {name: '费用上限', exact: true})).toHaveAccessibleDescription('单位：微美元；留空表示未设置。');
  await page.evaluate(() => {
    budgetResponse = {ok: true, data: makeProjectBudget('project-a', 2)};
    budgetActionResponse = {ok: false, error: {message: 'research_project_budget_revision_conflict'}};
    for (const listener of budgetListeners) listener({projectId: 'project-a'});
  });
  await page.getByTestId('mgmt-project-budget-save').click();
  await page.getByText('research_project_budget_revision_conflict', {exact: true}).waitFor();
  const request = await page.evaluate(() => calls.find(call => call.method === 'budget-save').request);
  assert.equal(request.expectedRevision, 1);
  assert.equal(request.limits.maxCostMicrousd, 100000);
  assert.equal(await page.getByTestId('mgmt-project-budget-tokens').inputValue(), '300');
  await page.evaluate(() => { budgetResponse = {ok: true, data: makeProjectBudget('project-b')}; mountBudget('project-b'); });
  await page.getByTestId('mgmt-project-budget-data').waitFor();
  assert.equal(await page.getByTestId('mgmt-project-budget-tokens').count(), 0);
  assert.equal(await page.getByRole('alert').count(), 0);
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

test('review queries show truthful task execution status and only complete coverage counts as finished', async () => {
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(720, 680));
  for (const [status, label, completed] of [
    ['complete', '检索完成', 2], ['partial', '检索覆盖不完整', 1], ['cancelling', '正在取消', 1]
  ]) {
    await page.evaluate(status => {
      reset();
      const data = makeData();
      data.executions[2] = {
        ...data.executions[2], association: {
          ...data.executions[2].association, kind: 'review_search', executionId: 'actual-query-id',
          parentKind: 'chat', parentExecutionId: 'chat-a', associationSource: 'chat_dispatch'
        }, status, stage: null, artifacts: [],
        endedAt: status === 'cancelling' ? null : '2026-11-03T00:00:01.000Z'
      };
      response = {ok: true, data};
      mountDrawer();
    }, status);
    const execution = page.getByText('actual-query-id', {exact: true}).locator('..');
    await execution.getByText('综述查询', {exact: true}).waitFor();
    assert.ok((await execution.innerText()).includes(label));
    assert.ok((await page.getByTestId('task-progress').innerText()).includes(`${completed}/3`));
    assert.equal(await execution.getByRole('list', {name: '工件'}).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.getByText('actual-query-id', {exact: true}).scrollIntoViewIfNeeded();
  await page.screenshot({path: join(artifacts, 'review-query-cancelling.png')});
});

test('facts panel saves user corrections with fixed revision, retains history and exposes source expiry', async () => {
  await page.evaluate(() => {reset(); mountDrawer();});
  await page.getByTestId('mgmt-task-fact-content').waitFor();
  await page.getByTestId('mgmt-task-fact-kind').selectOption('correction');
  await page.getByTestId('mgmt-task-fact-content').fill('评估阈值纠正为 5，保留负面结果。');
  await page.getByTestId('mgmt-task-fact-save').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('mgmt-task-fact').waitFor();
  const saved = await page.evaluate(() => calls.find(row => row.method === 'facts-save').request);
  assert.equal(saved.expectedRevision, 0);
  assert.deepEqual(Object.keys(saved).sort(), ['entries', 'expectedRevision', 'projectId', 'taskId']);
  assert.equal(saved.entries[0].kind, 'correction');
  assert.equal(saved.entries[0].sources[0].kind, 'user');
  assert.equal(await page.getByTestId('mgmt-task-fact-content').inputValue(), '');
  await page.getByRole('button', {name: '标记已替代', exact: true}).click();
  await page.getByText('已替代', {exact: true}).waitFor();
  await page.getByRole('button', {name: '修订历史', exact: true}).click();
  await page.getByTestId('mgmt-task-facts-history').getByText(/版本 2/).waitFor();
  assert.equal(await page.getByTestId('mgmt-task-facts-history').locator('details').count(), 2);
  await page.evaluate(() => {
    const entry = factsResponse.data.snapshot.entries[0];
    entry.sources = [{kind: 'artifact', artifactId: 'source-artifact', version: 'b'.repeat(64)}];
    factsResponse.data.freshness = [{entryId: entry.id, sourceIndex: 0, state: 'expired', reason: 'artifact_version_changed'}];
    emit();
  });
  await page.getByText('出处已失效：工件版本已改变', {exact: true}).waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => {document.documentElement.dataset.theme = theme;}, theme);
    await page.getByTestId('mgmt-task-facts').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({path: join(artifacts, `facts-${theme}.png`)});
  }
});

test('facts conflict keeps draft; pending save and late reads cannot cross task/project scopes', async () => {
  await page.evaluate(() => {reset(); factSaveError = 'research_task_facts_revision_conflict'; mountDrawer();});
  await page.getByTestId('mgmt-task-fact-content').fill('保留这个纠正草稿');
  await page.getByTestId('mgmt-task-fact-save').click();
  await page.getByRole('alert').filter({hasText: 'research_task_facts_revision_conflict'}).waitFor();
  assert.equal(await page.getByTestId('mgmt-task-fact-content').inputValue(), '保留这个纠正草稿');
  await page.evaluate(() => {factSaveError = null; factSaveDeferred = deferred();});
  await page.getByTestId('mgmt-task-fact-save').click();
  await page.getByRole('button', {name: '保存中…', exact: true}).waitFor();
  assert.equal(await page.getByTestId('mgmt-task-fact-content').isDisabled(), true);
  await page.evaluate(() => {response = {ok: true, data: makeData('project-b', 'task-b')}; mountDrawer('task-b', 'project-b');});
  await page.getByTestId('mgmt-task-fact-content').waitFor();
  assert.equal(await page.getByTestId('mgmt-task-fact-content').inputValue(), '');
  await page.evaluate(() => factSaveDeferred.resolve({ok: true, data: {revision: 1}}));
  const late = await page.evaluate(() => calls.filter(row => row.method === 'facts').map(row => row.request));
  assert.equal(late.at(-1).projectId, 'project-b');
  await page.evaluate(() => {
    reset(); window.oldFactsRead = deferred(); factsResponse = oldFactsRead.promise; mountDrawer();
    factsResponse = {ok: true, data: {snapshot: null, freshness: [], authority: 'research_data_only'}};
    response = {ok: true, data: makeData('project-b', 'task-b')}; mountDrawer('task-b', 'project-b');
    oldFactsRead.resolve({ok: true, data: {snapshot: {revision: 99, entries: [{id: 'old', kind: 'constraint', state: 'active', content: 'OLD PRIVATE FACT', sources: []}]}, freshness: []}});
  });
  await page.getByText('尚无任务事实。', {exact: true}).waitFor();
  assert.equal(await page.getByText('OLD PRIVATE FACT', {exact: true}).count(), 0);
});

test('execution drill is lazy and keyboard accessible, pages calls/events independently and refreshes true telemetry', async () => {
  await page.evaluate(() => {reset(); mountDrawer();});
  await ready();
  assert.equal(await page.evaluate(() => calls.filter(row => row.method === 'observations').length), 0);
  const summary = page.getByText('调用与观测', {exact: true}).first();
  await summary.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="mgmt-task-call"]').length === 50);
  const panel = page.getByTestId('mgmt-task-observations');
  // Mounted rows can precede the native details content becoming visible.
  await expect(panel).toContainText('17 ms / failed', {useInnerText: true});
  assert.ok((await panel.innerText()).includes('已结算 未知'));
  await page.getByTestId('mgmt-task-replay-gap').waitFor();
  await panel.getByRole('button', {name: '下一页调用', exact: true}).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="mgmt-task-call"]').length === 1);
  assert.equal(await panel.getByText('调用 measured-call-51', {exact: true}).count(), 1);
  assert.equal(await panel.getByRole('list', {name: '事件重放'}).locator('li').count(), 50);
  await panel.getByRole('button', {name: '下一页事件', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="事件重放"]').children.length === 1);
  assert.equal(await page.getByTestId('mgmt-task-call').count(), 1);
  assert.equal(await page.getByTestId('mgmt-task-replay-gap').count(), 0);
  await page.evaluate(() => {
    observationTelemetry = {firstOutputMs: 40, toolCalls: 2, toolErrors: 1,
      admission: {acquisitions: 1, cancellations: 0, waitMs: 3, holdMs: 5}, trace: {spans: [{
        spanId: 'span-1', operationId: 'operation-1', parentSpanId: null, checkpointId: null,
        operation: 'approval_wait', status: 'completed', startOffsetMs: 0, durationMs: 15,
        estimatedInputTokens: null, actualInputTokens: null, actualOutputTokens: null, estimateApproximate: null
      }], droppedSpanCount: 0}};
  });
  await panel.getByRole('button', {name: '刷新观测', exact: true}).click();
  await panel.getByText(/首次输出 40 ms/).waitFor();
  assert.ok((await panel.innerText()).includes('等待审批 / completed / 15 ms'));
  const last = await page.evaluate(() => calls.filter(row => row.method === 'observations').at(-1).request);
  assert.equal(last.afterCallSequence, 50); assert.equal(last.afterEventSequence, 60);
  await summary.click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="mgmt-task-observations"]'));
});

test('diagnostic errors, pending exports and late replies stay within the selected task', async () => {
  await page.evaluate(() => {reset(); observationResponse = {ok: false, error: {message: 'resource_report_changed'}}; mountDrawer();});
  await page.getByText('调用与观测', {exact: true}).first().click();
  await page.getByRole('alert').filter({hasText: 'resource_report_changed'}).waitFor();
  await page.evaluate(() => {observationResponse = null;});
  await page.getByRole('button', {name: '刷新观测', exact: true}).click();
  await page.getByTestId('mgmt-task-call').first().waitFor();
  await page.evaluate(() => {window.oldObservation = deferred(); observationResponse = oldObservation.promise;});
  await page.getByRole('button', {name: '刷新观测', exact: true}).click();
  await page.getByText('读取观测中…', {exact: true}).waitFor();
  await page.evaluate(() => {window.oldExport = deferred(); exportResponse = oldExport.promise;});
  const exportPanel = page.getByTestId('mgmt-task-diagnostics-export');
  await exportPanel.getByRole('button', {name: '导出离线诊断', exact: true}).focus();
  await page.keyboard.press('Enter');
  await exportPanel.getByRole('button', {name: '导出中…', exact: true}).waitFor();
  assert.equal(await exportPanel.getByRole('button').isDisabled(), true);
  assert.equal(await page.evaluate(() => calls.filter(row => row.method === 'diagnostics-export').length), 1);
  await page.evaluate(() => {
    response = {ok: true, data: makeData('project-b', 'task-b', 'chat-b')}; observationResponse = null;
    mountDrawer('task-b', 'project-b');
    oldObservation.resolve({ok: true, data: {telemetry: null, resources: null, replay: null,
      calls: {calls: [{sequence: 999, callId: 'OLD PRIVATE CALL'}], hasMore: false, nextSequence: 999}}});
    oldExport.resolve({ok: true, data: {path: 'OLD PRIVATE EXPORT', size: 1, sha256: 'a'.repeat(64)}});
    exportResponse = {ok: false, error: {message: 'diagnostics_source_changed'}};
  });
  await page.getByText('验证科研任务 task-b', {exact: true}).waitFor();
  assert.equal(await page.getByText('OLD PRIVATE CALL').count(), 0);
  assert.equal(await page.getByText('OLD PRIVATE EXPORT').count(), 0);
  await page.getByTestId('mgmt-task-diagnostics-export').getByRole('button').click();
  await page.getByRole('alert').filter({hasText: 'diagnostics_source_changed'}).waitFor();
  await page.evaluate(() => {
    exportResponse = {ok: true, data: {path: '/local/diagnostics/task-b.json', size: 512,
      sha256: 'c'.repeat(64), createdAt: '2026-11-06T00:00:00.000Z', redacted: true, externalTrace: 'not_exported'}};
  });
  await page.getByTestId('mgmt-task-diagnostics-export').getByRole('button').click();
  await page.getByText('/local/diagnostics/task-b.json', {exact: true}).waitFor();
  assert.deepEqual(await page.evaluate(() => calls.filter(row => row.method === 'diagnostics-export').at(-1).request),
    {projectId: 'project-b', taskId: 'task-b'});
});

test('expanded diagnostics and export receipts fit light/dark narrow desktop layouts without clipped shadows', async () => {
  const auditSource = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  const receipts = [];
  for (const theme of ['light', 'dark']) {
    for (const width of [720, 380]) {
      await app.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setSize(width, 680), width);
      await page.evaluate(theme => {document.documentElement.dataset.theme = theme; reset(); mountDrawer();}, theme);
      await ready();
      const summary = page.getByText('调用与观测', {exact: true}).first();
      receipts.push({theme, width, state: 'closed', ...await page.evaluate(`(${auditSource})({viewport: true, root: '#root'})`)});
      await summary.click();
      const panel = page.getByTestId('mgmt-task-observations');
      await page.getByTestId('mgmt-task-call').first().waitFor();
      await panel.getByRole('button', {name: '刷新观测', exact: true}).hover();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      receipts.push({theme, width, state: 'expanded-hover', ...await page.evaluate(`(${auditSource})({viewport: true, root: '#root'})`)});
      await panel.getByRole('button', {name: '下一页调用', exact: true}).click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="mgmt-task-call"]').length === 1);
      await panel.getByRole('button', {name: '下一页事件', exact: true}).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="事件重放"]').children.length === 1);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({path: join(artifacts, `observations-${theme}-${width}.png`)});
      await page.getByTestId('mgmt-task-diagnostics-export').getByRole('button').click();
      await page.getByText('/local/diagnostics/task.json', {exact: true}).waitFor();
      receipts.push({theme, width, state: 'exported', ...await page.evaluate(`(${auditSource})({viewport: true, root: '#root'})`)});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  }
  writeFileSync(join(artifacts, 'observations-clip-audit.json'), JSON.stringify(receipts, null, 2));
  for (const receipt of receipts) assert.equal(receipt.cut, 0);
});

test('task drawer shows dependency waits and keyboard-accessible lease and result details in both themes', async () => {
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({width: 560, height: 840});
    await page.evaluate(theme => {
      reset(); document.documentElement.dataset.theme = theme;
      const data = makeData();
      const base = {schemaVersion: 1, taskId: 'task-a', projectId: 'project-a', graphRevision: 3,
        revision: 1, inputHash: 'a'.repeat(64), operationKey: 'b'.repeat(64), readonly: true,
        attempt: 1, generation: 1, outputRevision: 0, lease: null, output: null,
        createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z'};
      data.graph = {revision: 3, nodes: [
        {...base, id: 'reviewer', executionId: 'stage-reviewer', stage: 'review', role: '证据审稿',
          status: 'done', reason: null, outputRevision: 1,
          output: {revision: 1, hash: 'c'.repeat(64), artifactIds: ['report-a'], schemaVersion: 1}},
        {...base, id: 'reducer', executionId: 'stage-reducer', stage: 'review', role: '审稿汇总',
          status: 'pending', reason: 'research_node_dependency_pending', readonly: false, attempt: 0, generation: 0}
      ], edges: [{prerequisite: 'reviewer', dependent: 'reducer'}]};
      response = {ok: true, data}; mountDrawer();
    }, theme);
    const graph = page.getByTestId('mgmt-task-graph');
    await graph.getByText('等待前置结果被接受').waitFor();
    assert.equal(await graph.getByTestId('mgmt-task-node').count(), 2);
    await graph.getByText('前置：证据审稿').waitFor();
    const details = graph.locator('summary').first();
    await details.focus(); await page.keyboard.press('Enter');
    await graph.getByText('工件 report-a').waitFor();
    await graph.getByText('当前无执行租约').first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await graph.screenshot({path: join(artifacts, `dag-${theme}.png`)});
  }
  await page.setViewportSize({width: 760, height: 680});
});
