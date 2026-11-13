import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-assistant-panel-guards-'));
  await buildViteRenderer({directory, style: 'html,body,#root{height:100%;margin:0}', script: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion, domMax, MotionConfig} from 'motion/react';
    import {AssistantPanel} from './src/renderer/assistant/AssistantPanel';
    import {clearAssistantComposerDraft} from './src/renderer/assistant/composer-draft';
    import {chatRunEventSchema} from './src/shared/schemas/chat';
    import {persistedTaskEventSchema} from './src/shared/schemas/task-event';
    const ok = data => ({ok: true, data});
    window.emitRunEvent = event => liveRun(chatRunEventSchema.parse(event));
    const client = {api: {
      window: {onHidden: () => () => {}},
      settings: {get: async () => ok({defaultModelId: null, providers: [], skills: []})},
      mcp: {getConfig: async () => ok({schemaVersion: 1, approvalMode: 'default', servers: []})},
      research: {onTaskUpdated: () => () => {}, getTaskForChat: async () => ok(null)},
      agent: {getRunDiagnostics: async () => ({ok: false, error: {message: 'No diagnostics in this fixture'}})},
      chat: {
        onRunEvent: callback => {window.liveRun = callback; return () => {};},
        getActiveRun: async () => ok(null),
        replayRunEvents: async ({runId}) => ok({kind: 'events', runId, events: window.replayEvents}),
        startRun: request => {
          window.sendCalls.push(request);
          return new Promise(resolve => {window.finishSend = resolve;});
        },
        resumeRun: request => {
          window.resumeCalls.push(request);
          return new Promise(resolve => {window.finishResume = resolve;});
        }
      },
      tasks: {getThreadMessages: async () => ok({
        items: window.historyItems, hasMoreBefore: false, hasMoreAfter: false,
        oldestSequence: window.historyItems[0]?.sequence ?? null,
        newestSequence: window.historyItems.at(-1)?.sequence ?? null
      })}
    }};
    function Harness({initialThread}) {
      const [threadId, setThreadId] = useState(initialThread);
      const [seed, setSeed] = useState(null);
      window.panelThread = threadId;
      window.setPanelThread = setThreadId;
      window.setPanelSeed = setSeed;
      return <div style={{height: 700, width: 400}}>
        <AssistantPanel client={client} projectId="fixture-project" threadId={threadId}
          onThreadIdChange={setThreadId} workspacePath="/fixture" projectName="Fixture"
          onOpenTask={() => {}} onOpenArtifact={() => {}} onOpenReviewInspector={() => {}}
          onOpenSettings={() => {}} composerSeed={seed} onComposerSeedConsumed={() => setSeed(null)} />
      </div>;
    }
    const root = createRoot(document.getElementById('root'));
    let instance = 0;
    window.mount = (initialThread, items = []) => {
      for (const threadId of [null, 'a', 'b', 'created']) clearAssistantComposerDraft('fixture-project', threadId);
      window.sendCalls = [];
      window.resumeCalls = [];
      window.historyItems = items;
      window.replayEvents = [];
      flushSync(() => root.render(<MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict>
        <Harness key={++instance} initialThread={initialThread} />
      </LazyMotion></MotionConfig>));
    };
    window.checkpointReport = available => ({
      taskId: 'checkpoint-task', runId: 'checkpoint-run', contractVersion: 1, status: 'blocked',
      checkpointResumeAvailable: available, criteria: [], remainingItems: [], blockedBy: ['process_restart'],
      nextSafeAction: '从已保存的检查点继续'
    });
    window.mountCheckpoint = available => window.mount('a', [persistedTaskEventSchema.parse({
      id: 'checkpoint-receipt', sequence: 1, threadId: 'a', runId: 'checkpoint-run',
      createdAt: '2026-11-12T00:00:00.000Z', type: 'task_acceptance',
      payload: window.checkpointReport(available)
    })]);
    window.unmount = () => flushSync(() => root.render(null));
    window.mount('a');
  `});
  await writeFile(join(directory, 'main.cjs'), `
    const {app, BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => new BrowserWindow({show: false, width: 1000, height: 850})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));
  `);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('assistant-composer-input').waitFor();
});
after(async () => {
  try {
    await page?.evaluate(() => window.unmount());
    await app?.close();
  } finally {
    if (directory) await rm(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, [], 'the actual assistant panel must not throw');
});

for (const initialThread of ['a', null]) {
  test(`assistant panel preserves the next seed after sending ${initialThread === null ? 'a new thread' : 'an existing thread'}`, async () => {
    await page.evaluate(threadId => window.mount(threadId), initialThread);
    const input = page.getByTestId('assistant-composer-input');
    await input.fill('第一份草稿');
    await page.getByTestId('assistant-composer-send').click();
    await page.waitForFunction(() => sendCalls.length === 1);
    await page.evaluate(() => setPanelSeed({text: '下一份草稿', nonce: 1}));
    await expect(input).toHaveValue('下一份草稿');
    await page.evaluate(threadId => finishSend({ok: true, data: {
      runId: 'fixture-run', threadId: threadId ?? 'created'
    }}), initialThread);
    await page.waitForFunction(() => !document.querySelector('[data-testid="assistant-composer-input"]').disabled);
    assert.equal(await input.inputValue(), '下一份草稿');
    assert.equal(await page.evaluate(() => panelThread), initialThread ?? 'created');
  });
}

test('assistant panel ignores an old dispatch after switching threads and retains both drafts', async () => {
  await page.evaluate(() => window.mount('a'));
  const input = page.getByTestId('assistant-composer-input');
  await input.fill('线程 A 的草稿');
  await page.getByTestId('assistant-composer-send').click();
  await page.waitForFunction(() => sendCalls.length === 1);
  await page.evaluate(() => setPanelThread('b'));
  await expect(input).toBeEnabled();
  await input.fill('线程 B 的草稿');
  await page.evaluate(() => finishSend({ok: true, data: {runId: 'old-run', threadId: 'a'}}));
  await expect(input).toHaveValue('线程 B 的草稿');
  await page.evaluate(() => setPanelThread('a'));
  await expect(input).toHaveValue('线程 A 的草稿');
});

test('checkpoint continuation follows the latest live availability receipt and stays hidden during execution', async () => {
  await page.evaluate(() => {
    mount('a');
    emitRunEvent({type: 'run_started', runId: 'checkpoint-run', threadId: 'a',
      providerId: 'p', modelId: 'm', mode: 'run', createdAt: 'now'});
    emitRunEvent({type: 'run_failed', runId: 'checkpoint-run', threadId: 'a',
      code: 'process_restart', message: '运行因进程重启中断', retryable: false});
    emitRunEvent({type: 'task_acceptance', runId: 'checkpoint-run', report: checkpointReport(true)});
  });
  const resume = page.getByTestId('assistant-task-resume-checkpoint');
  await expect(resume).toBeVisible();
  await page.evaluate(() => emitRunEvent({
    type: 'task_acceptance', runId: 'checkpoint-run', report: checkpointReport(false)
  }));
  await expect(resume).toHaveCount(0);
  await page.evaluate(() => {
    emitRunEvent({type: 'run_continued', runId: 'checkpoint-run', threadId: 'a', continuedAt: 'now'});
    emitRunEvent({type: 'task_acceptance', runId: 'checkpoint-run', report: checkpointReport(true)});
  });
  await expect(page.getByTestId('assistant-run-status')).toHaveAttribute('data-status', 'running');
  await expect(resume).toHaveCount(0);
});

test('persisted checkpoint continuation guards duplicate requests, preserves refusal and isolates late replies', async () => {
  await page.evaluate(() => mountCheckpoint(false));
  await expect(page.getByTestId('assistant-task-resume-checkpoint')).toHaveCount(0);
  await page.evaluate(() => mountCheckpoint(true));
  const resume = page.getByTestId('assistant-task-resume-checkpoint');
  await expect(resume).toBeVisible();
  await resume.focus();
  await page.keyboard.press('Enter');
  await resume.evaluate(element => {element.click(); element.click();});
  assert.deepEqual(await page.evaluate(() => resumeCalls), [
    {kind: 'checkpoint', runId: 'checkpoint-run', threadId: 'a'}
  ]);
  await expect(resume).toBeDisabled();
  await page.evaluate(() => finishResume({ok: false, error: {message: 'checkpoint bridge refused'}}));
  await expect(page.getByTestId('assistant-errors')).toContainText('checkpoint bridge refused');
  await expect(resume).toBeEnabled();
  await resume.click();
  await page.waitForFunction(() => resumeCalls.length === 2);
  await page.evaluate(() => {
    window.historyItems = [];
    setPanelThread('b');
  });
  await expect(resume).toHaveCount(0);
  await page.evaluate(() => finishResume({ok: false, error: {message: 'late checkpoint reply'}}));
  await expect(page.getByTestId('assistant-errors')).toHaveCount(0);
  await expect(page.getByTestId('assistant-composer-input')).toBeEnabled();
});

for (const approval of [
  {kind: 'tool', name: 'shell_command', args: {command: 'pwd'}, testId: 'assistant-approval'},
  {kind: 'task', name: 'update_background_task', args: {goal: '更新本地任务'}, testId: 'assistant-task-approval'},
   {kind: 'gate', name: 'research_approve_gate', args: {projectId: 'fixture-project', stage: 'reading', artifactLinks: [{
     projectId: 'fixture-project', artifactId: 'reading-a', expectedVersion: 'a'.repeat(64),
     title: '阅读笔记', kind: 'reading_notes'
   }]}, testId: 'assistant-gate'}
]) {
test(`actual assistant ${approval.kind} approval retains focus and shows pending until its decision settles`, async () => {
  await page.evaluate(approval => {
    window.mount('a');
    emitRunEvent({type: 'run_started', runId: 'approval-run', threadId: 'a',
      providerId: 'p', modelId: 'm', mode: 'run', createdAt: 'now'});
    emitRunEvent({type: 'run_interrupted', runId: 'approval-run', threadId: 'a', interruptId: 'approval-a',
      payload: {kind: 'approval', request: {actionRequests: [{name: approval.name, args: approval.args}],
        reviewConfigs: [{actionName: approval.name, allowedDecisions: ['approve', 'reject']}]}}});
  }, approval);
  const approve = page.getByTestId(`${approval.testId}-approve`);
  await approve.click();
  await page.waitForFunction(() => resumeCalls.length === 1);
  const pending = await approve.getAttribute('aria-disabled');
  const focused = await approve.evaluate(element => element === document.activeElement);
  const statusVisible = await page.getByTestId('assistant-approval-pending').count();
  await page.getByTestId(`${approval.testId}-reject`).evaluate(element => element.click());
  if (approval.kind === 'gate') {
    await expect(page.getByTestId('assistant-gate-refresh')).toHaveAttribute('aria-disabled', 'true');
    await page.getByTestId('assistant-gate-refresh').evaluate(element => element.click());
  }
  assert.equal(await page.evaluate(() => resumeCalls.length), 1);
  await page.evaluate(() => finishResume({ok: false, error: {message: 'approval bridge refused'}}));
  await page.getByTestId('assistant-errors').waitFor();
  await expect(approve).toBeEnabled();
  await expect(approve).toHaveAttribute('aria-disabled', 'false');
  assert.equal(pending, 'true');
  assert.equal(focused, true);
  assert.equal(statusVisible, 1);
});
}
