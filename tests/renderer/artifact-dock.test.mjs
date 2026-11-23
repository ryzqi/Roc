import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {reviewProtocolBodyFixture} from '../unit/fixtures/research-review-protocol.mjs';

let directory, app, page;
const errors = [];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-artifact-dock-'));
  await buildViteRenderer({directory, style: 'html,body,#root{height:100%;margin:0}', script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,domMax,MotionConfig} from 'motion/react';
    import {ArtifactDock} from './src/renderer/app/OverlayHost';
    import {WorkspaceLayout} from './src/renderer/app/WorkspaceLayout';
    import {useLayoutPersistence} from './src/renderer/app/useLayoutPersistence';
    import {requestArtifactInspectorChange} from './src/renderer/artifacts/artifact-interactions';
    import {useReviewProtocolDraftGuard} from './src/renderer/artifacts/review-protocol-draft';
    import {clearUiState} from './src/renderer/app/ui-state';
    clearUiState();
    window.calls=[];
    const client={api:{research:{
      listReviewProtocols:async request=>{calls.push({method:'list',request});return {ok:true,data:[]};},
      saveReviewProtocol:request=>{calls.push({method:'save',request});return new Promise(resolve=>{
        window.finishSave=()=>resolve({ok:false,error:{message:'Synthetic save failure'}});
      });}
    }}};
    function Harness(){
      const [selection,setSelection]=useState(null);
      const [assistant,setAssistant]=useState(true);
      const [readingLocations]=useState(()=>new Map());
      const [reviewDrafts]=useState(()=>new Map());
      useReviewProtocolDraftGuard(reviewDrafts);
      const layout=useLayoutPersistence('research','project-a');
      const close=()=>requestArtifactInspectorChange(()=>setSelection(null));
      const open=()=>{layout.setDrawerOpen(!layout.drawerFloating);requestArtifactInspectorChange(()=>setSelection({
        kind:'review',request:{mode:'manage',projectId:'project-a',versionId:null}
      }));};
      window.closeDock=close;
      window.seedReviewDraft=body=>reviewDrafts.set(JSON.stringify(['project-a',null]),{
        body,deviationReason:'',reviewNote:'',editing:true,saveRequestId:crypto.randomUUID(),freezeRequestId:crypto.randomUUID()
      });
      window.resetDock=()=>flushSync(()=>{setSelection(null);setAssistant(true);reviewDrafts.clear();layout.reset();calls=[];});
      return <div className="flex h-full flex-col">
        <header><button data-testid="titlebar-toggle-sidebar" onClick={layout.toggleDrawer}>上下文</button>
          <button data-testid="titlebar-toggle-assistant" onClick={()=>requestArtifactInspectorChange(()=>{
            setSelection(null);setAssistant(value=>!value);
          })}>助手</button></header>
        <WorkspaceLayout layout={layout} assistantOpen={assistant} onCloseAssistant={()=>setAssistant(false)}
          activityRail={<nav style={{width:52,flexShrink:0}}>导航</nav>}
          contextDrawer={<button>项目文件</button>}
          canvas={<><button data-testid="canvas-open-review" onClick={open}>核查综述</button>
            <input data-testid="canvas-draft" defaultValue="正文草稿"/></>}
          assistant={<input data-testid="assistant-draft" defaultValue="助手草稿"/>}
          inspectorOpen={selection!==null} onCloseInspector={close}
          inspector={<ArtifactDock client={client} projectId="project-a" artifactSelection={selection} projectWritable
            artifactReadingLocations={readingLocations} reviewProtocolDrafts={reviewDrafts}
            onCloseArtifact={()=>setSelection(null)} onOpenTask={()=>{throw Error('unexpected task navigation');}}/>}/>
      </div>;
    }
    const root=createRoot(document.getElementById('root'));
    root.render(<MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict><Harness/></LazyMotion></MotionConfig>);
    window.unmount=()=>flushSync(()=>root.unmount());
  `});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1440,height:900})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('canvas-open-review').waitFor();
});
after(async () => {
  try {await page?.evaluate(() => window.unmount()); await app?.close();}
  finally {if (directory) await rm(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});

async function openReview() {
  await page.getByTestId('canvas-open-review').click();
  await expect(page.getByTestId('artifact-review-new')).toBeEnabled();
}

test('inline artifact dock replaces the assistant without a modal, stealing focus or remounting drafts', async () => {
  await page.getByTestId('assistant-draft').fill('保留助手中的草稿');
  await page.getByTestId('canvas-draft').fill('保留正文中的草稿');
  await page.evaluate(() => {
    window.assistantNode=document.querySelector('[data-testid="assistant-draft"]');
    window.canvasNode=document.querySelector('[data-testid="canvas-draft"]');
  });
  await openReview();
  await expect(page.getByTestId('inspector-column')).toHaveCSS('width', '344px');
  await expect(page.getByTestId('assistant-column')).toHaveCount(0);
  await expect(page.getByTestId('assistant-draft')).toBeHidden();
  await expect(page.getByTestId('canvas-open-review')).toBeFocused();
  await expect(page.getByTestId('artifact-inspector')).toHaveAttribute('data-presentation', 'embedded');
  await expect(page.getByTestId('artifact-inspector-panel')).not.toHaveAttribute('aria-modal');
  await expect(page.getByTestId('artifact-inspector-scrim')).toHaveCount(0);
  assert.equal(await page.locator('#root').getAttribute('aria-hidden'), null);
  await page.getByTestId('canvas-draft').fill('检视时仍可编辑正文');
  await page.getByTestId('artifact-inspector-close').click();
  await expect(page.getByTestId('assistant-column')).toBeVisible();
  await expect(page.getByTestId('canvas-open-review')).toBeFocused();
  await expect(page.getByTestId('assistant-draft')).toHaveValue('保留助手中的草稿');
  assert.equal(await page.evaluate(() => assistantNode===document.querySelector('[data-testid="assistant-draft"]') &&
    canvasNode===document.querySelector('[data-testid="canvas-draft"]')), true);
});

test('review draft and its focused editor survive responsive pane transitions in both themes', async () => {
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({width: 1440, height: 900});
    await page.evaluate(theme => {window.resetDock();document.documentElement.dataset.theme=theme;}, theme);
    await openReview();
    await page.getByTestId('artifact-review-new').click();
    const question=page.getByLabel('研究问题', {exact: true});
    await question.fill('跨布局保留的协议草稿');
    await question.focus();
    await page.evaluate(() => window.editorNode=document.activeElement);
    for (const width of [620, 380, 1440]) {
      await page.setViewportSize({width, height: 900});
      await expect(page.getByTestId(width===1440?'inspector-column':'inspector-drawer')).toBeVisible();
      await expect(question).toHaveValue('跨布局保留的协议草稿');
      await expect(question).toBeFocused();
      assert.equal(await page.evaluate(() => editorNode===document.activeElement), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth), true);
      assert.equal(await page.getByTestId('artifact-inspector-panel').evaluate(element=>element.scrollWidth<=element.clientWidth), true);
      if (process.env.ROC_UI_CAPTURE_DIR) {
        await mkdir(process.env.ROC_UI_CAPTURE_DIR, {recursive: true});
        await page.screenshot({path: join(process.env.ROC_UI_CAPTURE_DIR, 'artifact-dock-'+theme+'-'+width+'.png')});
      }
    }
    await page.setViewportSize({width: 620, height: 900});
    await expect(page.getByTestId('inspector-drawer')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('artifact-inspector')).toHaveCount(0);
    await expect(page.getByTestId('assistant-draft')).toHaveValue('保留助手中的草稿');
    assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', {cancelable: true}))), true);
    // Window-local protocol drafts deliberately survive a close without being committed.
    await page.setViewportSize({width: 1440, height: 900});
    await openReview();
    await page.getByTestId('artifact-review-new').click();
    await expect(question).toHaveValue('跨布局保留的协议草稿');
    await page.getByTestId('artifact-inspector-close').click();
  }
});

test('pending review save blocks dock dismissal and failure retains the original draft', async () => {
  await page.setViewportSize({width: 620, height: 900});
  await page.evaluate(body => {window.resetDock();window.seedReviewDraft(body);}, reviewProtocolBodyFixture());
  // The assistant starts open at this width; dismiss it to reach the canvas entry.
  await page.keyboard.press('Escape');
  await openReview();
  await page.getByTestId('artifact-review-new').click();
  await page.getByTestId('artifact-review-save').click();
  await expect(page.getByTestId('artifact-inspector-close')).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.closeDock());
  await expect(page.getByTestId('inspector-drawer')).toBeVisible();
  assert.equal(await page.evaluate(() => calls.filter(call=>call.method==='save').length), 1);
  await page.evaluate(() => window.finishSave());
  await expect(page.getByRole('alert')).toContainText('Synthetic save failure');
  await expect(page.getByLabel('研究问题', {exact: true})).toHaveValue(reviewProtocolBodyFixture().question);
  await expect(page.getByTestId('artifact-inspector-close')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('artifact-inspector')).toHaveCount(0);
});
