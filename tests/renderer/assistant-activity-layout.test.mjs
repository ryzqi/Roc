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
      const [streaming, setStreaming] = useState(false);
      const [instance, setInstance] = useState(0);
      const [draft, setDraft] = useState({text: '', attachments: []});
      window.setActivity = (next, live = false) => flushSync(() => {setBlocks(next); setStreaming(live);});
      window.resetActivity = (next, live = false) => flushSync(() => {
        setBlocks(next); setStreaming(live); setInstance(value => value + 1);
      });
      return <main style={{width: 320}} data-testid="assistant-layout-fixture">
        <StatusPillHeader projectName="研究项目" conversationTitle="需要完整显示的科研任务标题与上下文"
          runStatus="running" statusLabel="运行中" messageCount={128} timelineOpen={false}
          onToggleTimeline={noop} onNewThread={noop} onResetWidth={noop} />
        <ReviewLinkActionsProvider value={scope}>
          <ChatMessageRow key={instance} message={{key:'answer', source:'persisted',role:'assistant',content:'',
            reasoning:null,blocks,interrupts:[],isStreaming:streaming}}
            onOpenArtifact={noop} onReadGateContext={noop} />
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

test('compact header and layered composer fit both themes with no clipped shadows', async t => {
  await page.evaluate(() => window.setActivity([]));
  const clipSource = await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');
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
