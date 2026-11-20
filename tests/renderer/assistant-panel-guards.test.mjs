import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
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
        getActiveRun: async () => ok(window.activeRun),
        replayRunEvents: async ({runId}) => ok({kind: 'events', runId, events: window.replayEvents}),
        runInputs: async ({runId, threadId}) => ok({runId, threadId, items: window.inputItems.filter(item => item.runId === runId)}),
        correctRun: request => {
          window.correctCalls.push(request);
          return new Promise(resolve => {window.finishCorrect = result => {
            if (result.ok && !window.inputItems.some(item => item.submissionId === request.submissionId)) {
              window.inputItems.push({...request, sequence: result.data.sequence, status: 'queued'});
            }
            resolve(result);
          };});
        },
        cancelRun: runId => {
          window.cancelCalls.push(runId);
          return new Promise(resolve => {window.finishCancel = resolve;});
        },
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
    window.mount = (initialThread, items = [], recovery = null) => {
      for (const threadId of [null, 'a', 'b', 'created']) clearAssistantComposerDraft('fixture-project', threadId);
      window.sendCalls = [];
      window.resumeCalls = [];
      window.correctCalls = [];
      window.cancelCalls = [];
      window.inputItems = recovery?.inputs ?? [];
      window.activeRun = recovery?.activeRun ?? null;
      window.historyItems = items;
      window.replayEvents = recovery?.events ?? [];
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

async function mountRunning() {
  await page.evaluate(() => {
    mount('a');
    emitRunEvent({type: 'run_started', runId: 'input-run', threadId: 'a',
      providerId: 'p', modelId: 'm', mode: 'run', createdAt: 'now'});
  });
  await expect(page.getByTestId('assistant-composer-mode-steer')).toBeVisible();
}

test('running correction guards IME, reuses failed submission identity and shows authoritative consumption', async () => {
  await mountRunning();
  const input = page.getByTestId('assistant-composer-input');
  await input.fill('先核对引用来源');
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
    element.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', isComposing: true, bubbles: true}));
    element.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true}));
    element.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
  });
  assert.equal(await page.evaluate(() => correctCalls.length), 0);
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('先核对引用来源\n');
  await input.press('Meta+Enter');
  await page.waitForFunction(() => correctCalls.length === 1);
  await page.getByTestId('assistant-composer-send').evaluate(button => {button.click(); button.click();});
  assert.equal(await page.evaluate(() => correctCalls.length), 1);
  await expect(page.getByTestId('assistant-composer-stop')).toBeEnabled();
  await page.evaluate(() => finishCorrect({ok: false, error: {message: '提交响应丢失'}}));
  await expect(input).toHaveValue('先核对引用来源\n');
  await input.press('Enter');
  await page.waitForFunction(() => correctCalls.length === 2);
  assert.deepEqual(await page.evaluate(() => correctCalls[0]), await page.evaluate(() => correctCalls[1]));
  assert.deepEqual(await page.evaluate(() => ({...correctCalls[0], submissionId: 'stable'})), {
    runId: 'input-run', threadId: 'a', submissionId: 'stable', content: '先核对引用来源', kind: 'steer'
  });
  await page.evaluate(() => finishCorrect({ok: true, data: {sequence: 1}}));
  await expect(input).toHaveValue('');
  const receipts = page.getByTestId('assistant-run-inputs');
  await receipts.locator('summary').click();
  await expect(page.getByTestId('assistant-run-input')).toContainText('已排队');
  await page.evaluate(() => {inputItems[0].status = 'consumed';});
  await expect(page.getByTestId('assistant-run-input')).toContainText('已送入上下文');
  assert.equal(await page.evaluate(() => sendCalls.length), 0);
});

test('running follow-up uses keyboard selection, retains stop and ignores replies after a thread switch', async () => {
  await mountRunning();
  const input = page.getByTestId('assistant-composer-input');
  await page.getByTestId('assistant-composer-mode-steer').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('assistant-composer-mode-follow_up')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('assistant-composer-mode-follow_up')).toBeFocused();
  await input.fill('结束后整理参考文献');
  await input.press('Enter');
  await page.waitForFunction(() => correctCalls.length === 1);
  assert.equal(await page.evaluate(() => correctCalls[0].kind), 'follow_up');
  await page.evaluate(() => setPanelThread('b'));
  await input.fill('线程 B 的草稿');
  await page.evaluate(() => finishCorrect({ok: true, data: {sequence: 1}}));
  await expect(input).toHaveValue('线程 B 的草稿');
  await expect(page.getByTestId('assistant-run-inputs')).toHaveCount(0);
  assert.equal(await page.evaluate(() => sendCalls.length), 0);
});

test('running stop stays keyboard accessible while a correction is awaiting acceptance', async () => {
  await mountRunning();
  await page.getByTestId('assistant-composer-input').fill('补充说明');
  await page.getByTestId('assistant-composer-send').click();
  await page.waitForFunction(() => correctCalls.length === 1);
  const stop = page.getByTestId('assistant-composer-stop');
  await stop.focus();
  await page.keyboard.press('Enter');
  await stop.evaluate(button => {button.click(); button.click();});
  assert.deepEqual(await page.evaluate(() => cancelCalls), ['input-run']);
  await expect(stop).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('assistant-composer-input')).toBeDisabled();
  await page.evaluate(() => {
    emitRunEvent({type: 'run_cancelled', runId: 'input-run', threadId: 'a', reason: 'user_cancelled'});
    finishCancel({ok: true, data: {runId: 'input-run', cancelled: true}});
    finishCorrect({ok: false, error: {message: '运行已结束'}});
  });
  await expect(page.getByTestId('assistant-run-status')).toHaveAttribute('data-status', 'cancelled');
  await expect(page.getByTestId('assistant-composer-input')).toHaveValue('补充说明');
});

test('opening an active thread restores queued and consumed input receipts without resubmission', async () => {
  await page.evaluate(() => mount('a', [], {
    activeRun: {runId: 'restored-run', threadId: 'a', status: 'running'},
    events: [{sequence: 1, event: {type: 'run_started', runId: 'restored-run', threadId: 'a',
      providerId: 'p', modelId: 'm', mode: 'run', createdAt: 'now'}}],
    inputs: [
      {runId: 'restored-run', submissionId: 'restored-1', sequence: 1, content: '只用原始研究', kind: 'steer', status: 'consumed'},
      {runId: 'restored-run', submissionId: 'restored-2', sequence: 2, content: '最后列出局限', kind: 'follow_up', status: 'queued'}
    ]
  }));
  const receipts = page.getByTestId('assistant-run-inputs');
  await receipts.locator('summary').click();
  await expect(page.getByTestId('assistant-run-input')).toHaveCount(2);
  await expect(page.getByTestId('assistant-run-input').nth(0)).toContainText('已送入上下文');
  await expect(page.getByTestId('assistant-run-input').nth(1)).toContainText('已排队');
  assert.deepEqual(await page.evaluate(() => correctCalls), []);
});

test('uncertain correction retains its submission ID after the assistant remounts', async () => {
  await mountRunning();
  const input = page.getByTestId('assistant-composer-input');
  await input.fill('保留所有原始结果');
  await input.press('Enter');
  await page.waitForFunction(() => correctCalls.length === 1);
  const submissionId = await page.evaluate(() => correctCalls[0].submissionId);
  await page.evaluate(() => finishCorrect({ok: false, error: {message: '响应未确认'}}));
  await expect(input).toBeEnabled();
  await mountRunning();
  await input.fill('保留所有原始结果');
  await input.press('Enter');
  await page.waitForFunction(() => correctCalls.length === 1);
  assert.equal(await page.evaluate(() => correctCalls[0].submissionId), submissionId);
  await page.evaluate(() => finishCorrect({ok: true, data: {sequence: 1}}));
  await expect(input).toHaveValue('');
});

test('a correction racing with run completion never dispatches another run', async () => {
  await mountRunning();
  const input = page.getByTestId('assistant-composer-input');
  await input.fill('补查缺失证据');
  await input.press('Enter');
  await page.waitForFunction(() => correctCalls.length === 1);
  await page.evaluate(() => {
    emitRunEvent({type: 'run_failed', runId: 'input-run', threadId: 'a', code: 'test_terminal',
      message: '运行已结束', retryable: false});
    finishCorrect({ok: false, error: {message: '运行已结束，补充未接收'}});
  });
  await expect(input).toHaveValue('补查缺失证据');
  await expect(page.getByTestId('assistant-errors')).toContainText('补充未接收');
  assert.equal(await page.evaluate(() => sendCalls.length), 0);
});

test('running controls fit the minimum assistant width in light and dark themes', async t => {
  await mountRunning();
  await page.getByTestId('assistant-panel').evaluate(element => {element.parentElement.style.width = '320px';});
  const clipAudit = await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');
  const audit = async state => {
    for (const area of ['assistant-composer', 'assistant-run-inputs']) {
      const result = await page.evaluate(`(${clipAudit})({root:'[data-testid="${area}"]',viewport:true})`);
      assert.equal(result.cut, 0, `${state} ${area}: ${JSON.stringify(result)}`);
      assert.equal(result.hidden, 0, `${state} ${area}: ${JSON.stringify(result)}`);
    }
    t.diagnostic(`${state}: new composer controls and input receipts cut=0, hidden=0`);
  };
  const input = page.getByTestId('assistant-composer-input');
  await input.fill('请先核对引用来源，再继续汇总分析。'.repeat(5));
  await input.press('Enter');
  await page.waitForFunction(() => correctCalls.length === 1);
  await page.evaluate(() => finishCorrect({ok: true, data: {sequence: 1}}));
  await expect(page.getByTestId('assistant-run-inputs')).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => {document.documentElement.dataset.theme = theme;}, theme);
    const bounds = await page.getByTestId('assistant-composer').evaluate(element => {
      const composer = element.getBoundingClientRect();
      return [...element.querySelectorAll('textarea, button')].filter(control => control.getClientRects().length > 0)
        .map(control => {const box = control.getBoundingClientRect(); return {
          label: control.getAttribute('aria-label') ?? control.textContent,
          fits: box.left >= composer.left && box.right <= composer.right
        };});
    });
    assert.ok(bounds.every(control => control.fits), `${theme}: ${JSON.stringify(bounds)}`);
    await expect(page.getByTestId('assistant-composer-stop')).toBeVisible();
    await expect(page.getByTestId('assistant-composer-mode-follow_up')).toBeVisible();
    await audit(`${theme} default`);
    await page.getByTestId('assistant-composer-mode-follow_up').hover();
    await audit(`${theme} hover`);
    await page.getByTestId('assistant-run-inputs').locator('summary').click();
    await input.fill('补充核对来源与证据\n'.repeat(12));
    await audit(`${theme} expanded and long content at final layout`);
    await page.getByTestId('assistant-run-inputs').locator('summary').click();
    await input.fill('');
  }
  await page.evaluate(() => {document.documentElement.dataset.theme = 'light';});
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
  await expect(page.getByTestId('assistant-composer-input')).toBeDisabled();
  await expect(page.getByTestId('assistant-composer-mode-steer')).toHaveCount(0);
  assert.equal(await page.evaluate(() => correctCalls.length), 0);
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
