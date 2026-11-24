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
  directory = await mkdtemp(join(tmpdir(), 'roc-assistant-activity-layout-'));
  await buildViteRenderer({directory, style: 'html,body{margin:0}#root{padding:24px}', script: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion, domMax, MotionConfig} from 'motion/react';
    import {ChatMessageRow} from './src/renderer/assistant/blocks/message-row';
    import {ReviewLinkActionsProvider} from './src/renderer/assistant/blocks/review-link-actions';
    import {StatusPillHeader} from './src/renderer/assistant/StatusPillHeader';
    import {AssistantComposer} from './src/renderer/assistant/composer';
    const noop = () => {};
    const scope = {projectId: 'project', open: noop};
    function Harness() {
      const [blocks, setBlocks] = useState([]);
      const [history, setHistory] = useState([]);
      const [streaming, setStreaming] = useState(false);
      const [instance, setInstance] = useState(0);
      const [draft, setDraft] = useState({text: '', attachments: []});
      window.setActivity = (next, live = false) => flushSync(() => {setBlocks(next); setStreaming(live);});
      window.setHistory = next => flushSync(() => setHistory(next));
      window.resetActivity = (next, live = false) => flushSync(() => {
        setBlocks(next); setStreaming(live); setInstance(value => value + 1);
      });
      return <main style={{width: 320}} data-testid="assistant-layout-fixture">
        <StatusPillHeader projectName="研究项目" conversationTitle="需要完整显示的科研任务标题与上下文"
          runStatus="running" statusLabel="运行中" messageCount={128} timelineOpen={false}
          onToggleTimeline={noop} onNewThread={noop} onResetWidth={noop} />
        <ReviewLinkActionsProvider value={scope}>
          {history.length === 0 ? null : <section data-testid="assistant-history-fixture">
            <ChatMessageRow message={{key:'history',source:'persisted',role:'assistant',content:'',
              reasoning:null,blocks:history,interrupts:[],isStreaming:false}}
              onOpenArtifact={noop} onReadGateContext={noop} />
          </section>}
          <section data-testid="assistant-current-fixture">
            <ChatMessageRow key={instance} message={{key:'answer',source:streaming?'live':'persisted',role:'assistant',content:'',
              reasoning:null,blocks,interrupts:[],isStreaming:streaming}}
              onOpenArtifact={noop} onReadGateContext={noop} />
          </section>
        </ReviewLinkActionsProvider>
        <AssistantComposer mode="chat" onModeChange={noop} draft={draft} onDraftChange={setDraft}
          model={{choices:[],currentKey:null,label:'Very long provider and model name for the current project',
            pending:false,error:null,onSelect:noop,onOpenSettings:noop}}
          skills={[]} imageInputSupported={true} sending={false} running={true} replyMode={false}
          onSend={async () => true} onStop={noop} />
      </main>;
    }
    const root = createRoot(document.getElementById('root'));
    root.render(<MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict><Harness /></LazyMotion></MotionConfig>);
    window.unmount = () => flushSync(() => root.unmount());
  `});
  await writeFile(join(directory, 'main.cjs'), `
    const {app, BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => new BrowserWindow({show:false,width:800,height:900})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));
  `);
  app = await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('assistant-composer-input').waitFor();
});
after(async () => {
  try {
    await page?.evaluate(() => window.unmount());
    assert.deepEqual(errors, []);
  } finally {
    await app?.close();
    await rm(directory, {recursive:true,force:true});
  }
});

const tool = (id, status = 'end', output = {result:'完整工具回执'}) =>
  ({id,kind:'tool_call',name:id,status,input:{query:id},output,error:status === 'error' ? '工具执行失败' : null});

test('completed tool history mounts on demand, retains order and supports keyboard disclosure', async () => {
  await page.evaluate(blocks => window.resetActivity(blocks), Array.from({length:500}, (_, i) => tool(`tool-${i}`)));
  const group = page.getByTestId('assistant-completed-tools');
  await expect(group).toContainText('500 项已完成');
  assert.equal(await page.getByTestId('assistant-activity-tool').count(), 0);
  assert.ok(await group.locator('*').count() < 20, 'collapsed history keeps DOM bounded');
  await group.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('assistant-activity-tool')).toHaveCount(500);
  await expect(page.getByTestId('assistant-activity-tool-summary').first()).toContainText('tool-0');
  await expect(page.getByTestId('assistant-activity-tool-summary').last()).toContainText('tool-499');
  await page.getByTestId('assistant-activity-tool-summary').first().click();
  await expect(page.getByTestId('assistant-tool-data-输出')).toContainText('完整工具回执');
  await group.locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('assistant-tool-data-输出')).toBeHidden();
});

test('streaming, errors, reasoning and navigable receipts remain directly visible', async () => {
  const completed = [tool('first'),tool('second'),tool('third')];
  await page.evaluate(blocks => window.resetActivity(blocks, true), completed);
  await expect(page.getByTestId('assistant-completed-tools')).toHaveCount(0);
  await expect(page.getByTestId('assistant-activity-tool')).toHaveCount(3);
  const review = tool('review', 'end', {reviewLinks:[{projectId:'project',title:'查看综述协议',
    target:{kind:'protocol',versionId:'version',expectedVersionHash:'a'.repeat(64),expectedFreezeHash:null}}]});
  const blocks = [...completed, tool('failed','error'), tool('running','progress'),
    {id:'thinking',kind:'reasoning',content:'正在核对来源',isStreaming:true}, review];
  await page.evaluate(blocks => window.resetActivity(blocks), blocks);
  await expect(page.getByTestId('assistant-completed-tools')).toHaveCount(1);
  await expect(page.getByTestId('assistant-tool-data-错误')).toContainText('工具执行失败');
  await expect(page.getByTestId('assistant-activity-tool-summary').filter({hasText:'running'})).toContainText('执行中');
  await expect(page.getByTestId('assistant-reasoning-body')).toContainText('正在核对来源');
  await expect(page.getByTestId('assistant-review-link')).toBeVisible();
});

test('finishing a streamed message preserves the focused tool and expanded payload', async () => {
  const blocks = [tool('first'),tool('second'),tool('third')];
  await page.evaluate(blocks => window.resetActivity(blocks, true), blocks);
  const summary = page.getByTestId('assistant-activity-tool-summary').first();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('assistant-tool-data-输出')).toBeVisible();
  await page.evaluate(() => {
    window.focusedStreamingTool = document.activeElement;
    window.expandedStreamingTool = document.querySelector('[data-testid="assistant-tool-body"]');
  });
  await page.evaluate(blocks => window.setActivity(blocks), blocks);
  assert.equal(await page.evaluate(() => document.activeElement === window.focusedStreamingTool), true,
    'completion preserves the exact focused summary node');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="assistant-tool-body"]') === window.expandedStreamingTool), true,
    'completion preserves the exact expanded payload node');
  await expect(page.getByTestId('assistant-tool-data-输出')).toBeVisible();
  await expect(page.getByTestId('assistant-completed-tools')).toHaveCount(0);
});

test('a live tool failure reveals its receipt once without moving focus or overriding later disclosure', async () => {
  await page.evaluate(block => window.resetActivity([block], true), tool('live-failure', 'progress', null));
  const receipt = page.getByTestId('assistant-activity-tool');
  const summary = page.getByTestId('assistant-activity-tool-summary');
  await expect(receipt).not.toHaveAttribute('open');
  const composer = page.getByTestId('assistant-composer-input');
  await composer.fill('保留正在输入的草稿');
  await composer.focus();
  await page.evaluate(block => window.setActivity([block], true), tool('live-failure', 'error', {savedFile: 'result.txt'}));
  await expect(receipt).toHaveAttribute('open', '');
  await expect(page.getByTestId('assistant-tool-data-输入')).toContainText('live-failure');
  await expect(page.getByTestId('assistant-tool-data-输出')).toContainText('result.txt');
  await expect(page.getByTestId('assistant-tool-data-错误')).toContainText('工具执行失败');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('保留正在输入的草稿');

  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(receipt).not.toHaveAttribute('open');
  await page.evaluate(block => window.setActivity([block]),
    {...tool('live-failure', 'error', {savedFile: 'result.txt'}), error: '工具执行失败，已保存部分结果'});
  await expect(summary).toBeFocused();
  await expect(receipt).not.toHaveAttribute('open');
  await expect(page.getByTestId('assistant-tool-data-错误')).toBeHidden();

  // A retry is a new state transition. Its failure is important new information.
  await page.evaluate(block => window.setActivity([block], true), tool('live-failure', 'progress', null));
  await page.evaluate(block => window.setActivity([block], true), tool('live-failure', 'error'));
  await expect(receipt).toHaveAttribute('open', '');
  await expect(summary).toBeFocused();
});

test('live Hook failures and blocks reveal their authoritative reason and remain user collapsible', async () => {
  const hook = status => ({id: 'hook-live', kind: 'hook_call', status, event: 'PreToolUse',
    commandDisplay: 'check workspace policy', handlerId: 'policy-handler', durationMs: status === 'running' ? null : 30,
    message: status === 'failed' ? '策略检查失败' : status === 'blocked' ? '目标路径不在授权范围' : null,
    additionalContext: null, requestContinue: null});
  for (const status of ['failed', 'blocked']) {
    await page.evaluate(block => window.resetActivity([block], true), hook('running'));
    const receipt = page.getByTestId('assistant-activity-hook');
    await expect(receipt).not.toHaveAttribute('open');
    await page.evaluate(block => window.setActivity([block], true), hook(status));
    await expect(receipt).toHaveAttribute('open', '');
    await expect(page.getByTestId('assistant-hook-body')).toContainText(hook(status).message);
    await page.getByTestId('assistant-activity-hook-summary').click();
    await expect(receipt).not.toHaveAttribute('open');
    await page.evaluate(block => window.setActivity([block]), hook(status));
    await expect(receipt).not.toHaveAttribute('open');
  }
});

test('only current messages and running ancestors keep busy feedback, with reduced motion support', async () => {
  const agent = (id, status, blocks, children = [], parentSubagentId = null) => ({
    id, kind: 'subagent', identity: {subagentId:id,parentSubagentId,name:id,
      depth:parentSubagentId === null ? 0 : 1,
      path:parentSubagentId === null ? [id] : [parentSubagentId,id],execution:'sync',taskInput:null},
    status, summary:null, error:null, blocks, children
  });
  const parent = agent('parent', 'started', [tool('nested', 'progress', null)],
    [agent('child', 'running', [tool('deep', 'start', null)], [], 'parent')]);
  const blocks = [tool('starting', 'start', null), tool('working', 'progress'), parent];
  const current = page.getByTestId('assistant-current-fixture');
  const history = page.getByTestId('assistant-history-fixture');
  const icons = '[data-testid^="assistant-activity-"][data-testid$="-icon"]';
  const animationNames = scope => scope.locator(icons).evaluateAll(elements =>
    elements.map(element => getComputedStyle(element).animationName));
  await page.emulateMedia({reducedMotion:'no-preference'});
  try {
    await page.evaluate(blocks => {
      window.setHistory(blocks);
      window.resetActivity(blocks, true);
    }, blocks);
    await expect(current.getByTestId('assistant-activity-tool')).toHaveCount(4);
    await expect(current.locator('[aria-busy="true"]')).toHaveCount(6);
    await expect(current.getByRole('status')).toHaveCount(6);
    assert.deepEqual(await animationNames(current), Array(6).fill('spin'));
    await expect(current.getByTestId('assistant-activity-subagent').first()).toHaveAttribute('open', '');
    await expect(current.getByTestId('assistant-activity-subagent').last()).toHaveAttribute('open', '');

    await expect(history.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(history.getByRole('status')).toHaveCount(0);
    await expect(history.getByTestId('assistant-activity-tool-summary').first()).toContainText('开始');
    await expect(history.getByTestId('assistant-activity-tool-summary').last()).toContainText('执行中');
    await expect(history.getByTestId('assistant-activity-subagent')).not.toHaveAttribute('open');
    await expect(history.getByTestId('assistant-subagent-body')).toHaveCount(0);
    await history.getByTestId('assistant-activity-subagent-summary').first().click();
    await history.getByTestId('assistant-activity-subagent-summary').last().click();
    await expect(history.getByTestId('assistant-activity-tool')).toHaveCount(4);
    await expect(history.getByTestId('assistant-activity-subagent-summary').last()).toContainText('运行中');
    await expect(history.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(history.getByRole('status')).toHaveCount(0);
    assert.deepEqual(await animationNames(history), Array(6).fill('none'));

    await page.emulateMedia({reducedMotion:'reduce'});
    await expect(current.locator('[aria-busy="true"]')).toHaveCount(6);
    await expect(current.getByRole('status')).toHaveCount(6);
    assert.deepEqual(await animationNames(current), Array(6).fill('none'));
    await page.emulateMedia({reducedMotion:'no-preference'});

    const summary = current.getByTestId('assistant-activity-tool-summary').filter({hasText:'working'});
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(current.getByTestId('assistant-tool-data-输出')).toBeVisible();
    await current.evaluate(element => {
      window.busyActivitySummary = document.activeElement;
      window.busyActivityPayload = element.querySelector('[data-testid="assistant-tool-body"]');
    });
    const finished = [blocks[0], {...blocks[1],status:'end'}, {...parent,status:'completed'}];
    await page.evaluate(blocks => window.setActivity(blocks, true), finished);
    await expect(summary).toContainText('成功');
    await expect(current.locator('[aria-busy="true"]')).toHaveCount(1);
    await expect(current.getByRole('status')).toHaveCount(1);
    await expect(current.getByTestId('assistant-activity-subagent').first()).not.toHaveAttribute('aria-busy');
    await expect(current.getByTestId('assistant-activity-subagent').last()).not.toHaveAttribute('aria-busy');
    await expect(current.getByTestId('assistant-activity-subagent-summary').last()).toContainText('运行中');

    await page.evaluate(blocks => window.setActivity(blocks), finished);
    await expect(current.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(current.getByRole('status')).toHaveCount(0);
    assert.deepEqual(await animationNames(current), Array(6).fill('none'));
    await expect(current.getByTestId('assistant-activity-tool-summary').first()).toContainText('开始');
    await expect(summary).toBeFocused();
    await expect(current.getByTestId('assistant-tool-data-输出')).toBeVisible();
    assert.equal(await current.evaluate(element =>
      document.activeElement === window.busyActivitySummary &&
      element.querySelector('[data-testid="assistant-tool-body"]') === window.busyActivityPayload), true,
    'completion preserves the focused summary and expanded receipt nodes');
  } finally {
    await page.evaluate(() => {window.setHistory([]); window.setActivity([]);});
    await page.emulateMedia({reducedMotion:null});
  }
});

test('compact header and layered composer fit both themes with no clipped shadows', async t => {
  await page.evaluate(() => window.setActivity([]));
  const clipSource = await readFile('scripts/ui-audit/clip-audit.js', 'utf8');
  for (const theme of ['light','dark']) {
    await page.evaluate(theme => {document.documentElement.dataset.theme = theme;}, theme);
    for (const width of [320,400]) {
      await page.getByTestId('assistant-layout-fixture').evaluate((element, width) => {element.style.width = width + 'px';}, width);
      const result = await page.getByTestId('assistant-layout-fixture').evaluate(element => {
        const frame = element.getBoundingClientRect();
        return [...element.querySelectorAll('button,textarea')].filter(control => control.getClientRects().length > 0)
          .filter(control => {const box = control.getBoundingClientRect(); return box.left < frame.left || box.right > frame.right;})
          .map(control => control.getAttribute('data-testid'));
      });
      assert.deepEqual(result, [], `${theme} ${width}px control overflow`);
      const actions = await page.getByTestId('assistant-composer-actions').boundingBox();
      const options = await page.getByTestId('assistant-composer-options').boundingBox();
      const send = await page.getByTestId('assistant-composer-send').boundingBox();
      assert.ok(options.y >= actions.y + actions.height, 'model and attachments have their own row');
      assert.ok(Math.abs(send.x + send.width - actions.x - actions.width) < 1, 'send stays at the trailing edge when modes wrap');
      await expect(page.getByTestId('assistant-status-pill')).toHaveAccessibleName('运行中，128 条消息');
      const audit = await page.evaluate(`(${clipSource})({root:'[data-testid="assistant-layout-fixture"]',viewport:true})`);
      assert.equal(audit.cut, 0, JSON.stringify(audit));
      t.diagnostic(`${theme} ${width}px: cut=0`);
    }
  }
});
