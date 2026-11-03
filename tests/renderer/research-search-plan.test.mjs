import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import { _electron } from '@playwright/test';
import { researchSearchPlanFixture } from '../unit/fixtures/research-test-kit.mjs';

let directory, app, page, gateResult, finishGate;
const gateRequests=[];
let deferGate=false;
const errors = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/search-plan-ui');
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-search-plan-ui-'));
  mkdirSync(artifacts, {recursive: true});
  await esbuild.build({stdin: {contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {ResearchGateApprovalCard} from './src/renderer/assistant/blocks/approval-cards';
    const root = createRoot(document.getElementById('root'));
    window.decisions = [];
    window.mount = (searchPlan, searchPlanHash, artifactLinks = [{projectId:'synthetic-project',artifactId:'synthetic-artifact',expectedVersion:'a'.repeat(64),title:'检索计划',kind:'search_strategy'}]) => flushSync(() => root.render(React.createElement(ResearchGateApprovalCard, {
      approval: {kind: 'approval', interruptId: 'plan-gate', actionRequests: [{name: 'research_approve_gate',
        args: {projectId:'synthetic-project',stage: 'discovery', summary: '确认本阶段产物是否可以进入下一阶段。', artifactLinks,
          ...(searchPlan === null ? {} : {searchPlan}), searchPlanHash}}],
        reviewConfigs: [{actionName: 'research_approve_gate', allowedDecisions: ['approve', 'reject']}]},
      onOpenArtifact: request => window.openedArtifact=request,
      onReadGateContext: request => window.readGateFromMain(request),
      onApprovalDecision: (id, values) => decisions.push({id, values})
    })));
  `, resolveDir: process.cwd(), loader: 'js'}, outfile: join(directory, 'app.js'),
    bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent'});
  const assets = join(process.cwd(), 'dist/renderer/assets');
  writeFileSync(join(directory, 'app.css'), readdirSync(assets).filter(name => name.endsWith('.css'))
    .map(name => readFileSync(join(assets, name), 'utf8')).join('\n'));
  writeFileSync(join(directory, 'index.html'), `<html data-theme="light"><link rel="stylesheet" href="app.css">
    <style>body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}
      #root{width:min(420px,100%)}</style><div id="root"></div><script src="app.js"></script>`);
  writeFileSync(join(directory, 'main.cjs'), `
    const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:720}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));
  `);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('readGateFromMain',async request=>{
    gateRequests.push(request);
    assert.notEqual(gateResult,undefined,'test must configure explicit gate response');
    const result=gateResult;
    if(deferGate)return new Promise(resolve=>{finishGate=()=>resolve(result);});
    return result;
  });
  await page.waitForFunction(() => typeof window.mount === 'function');
});
after(async () => {
  try { await app?.close(); } finally { if (directory) rmSync(directory, {recursive: true, force: true}); }
  assert.deepEqual(errors, []);
});

test('approval card displays complete query scopes and returns the reviewed hash through keyboard approval', async () => {
  const plan = researchSearchPlanFixture('原始研究问题：怎样复现合成实验？', [
    {query: 'synthetic replication', sources: ['openalex', 'crossref'], limit: 10, maxPages: 2, yearFrom: 2020, yearTo: 2026}
  ]);
  plan.excludedTerms = ['病例报告'];
  const hash = 'a'.repeat(64);
  await page.evaluate(({plan, hash}) => { decisions = []; mount(plan, hash); }, {plan, hash});
  const content = page.locator('[data-testid="assistant-gate-search-plan"]');
  await content.waitFor();
  assert.match(await content.innerText(), /原始研究问题：怎样复现合成实验/u);
  assert.match(await content.innerText(), /建议研究问题/u);
  assert.match(await content.innerText(), /病例报告/u);
  assert.match(await content.innerText(), /2020 至 2026/u);
  assert.match(await content.innerText(), /每来源最多 2 页，每页 10 条，最终最多 10 篇/u);
  await page.screenshot({path: join(artifacts, 'plan-review.png')});
  await page.locator('[data-testid="assistant-gate-approve"]').focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => decisions), [{id: 'plan-gate', values: [{type: 'approve', reviewedSearchPlanHash: hash,
    reviewedArtifactVersions: [{artifactId:'synthetic-artifact',version:'a'.repeat(64)}]}]}]);
});

test('missing plan or invalid hash disables approval while retaining the reject action', async () => {
  for (const [plan, hash] of [[null, 'a'.repeat(64)], [researchSearchPlanFixture('Question'), 'invalid']]) {
    await page.evaluate(({plan, hash}) => { decisions = []; mount(plan, hash); }, {plan, hash});
    assert.equal(await page.locator('[data-testid="assistant-gate-approve"]').isDisabled(), true);
    assert.match(await page.locator('[role="alert"]').innerText(), /检索计划缺失或无效/u);
    await page.locator('[data-testid="assistant-gate-reject"]').focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => decisions), [{id: 'plan-gate', values: [{type: 'reject',
      reviewedArtifactVersions: [{artifactId:'synthetic-artifact',version:'a'.repeat(64)}]}]}]);
  }
});

test('long plan remains readable with keyboard scrolling in light and dark modes across the drawer boundary', async () => {
  const plan = researchSearchPlanFixture('原始研究指令。'.repeat(200), [
    {query: 'long-query-'.repeat(70), sources: ['openalex', 'crossref'], limit: 10, maxPages: 3, yearFrom: 2020}
  ]);
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.evaluate(plan => mount(plan, 'b'.repeat(64)), plan);
  const shadowAudit = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  const audits = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1100, 1099, 800]) {
      await page.setViewportSize({width, height: 720});
      const content = page.locator('[data-testid="assistant-gate-search-plan"]');
      await content.focus();
      await page.keyboard.press('End');
      await page.waitForFunction(() => document.querySelector('[data-testid="assistant-gate-search-plan"]').scrollTop > 0);
      const state = await content.evaluate(element => ({
        scrollable: element.scrollHeight > element.clientHeight, scrolled: element.scrollTop > 0,
        horizontalOverflow: element.scrollWidth > element.clientWidth,
        outlineWidth: getComputedStyle(element).outlineWidth,
        bodyOverflow: document.body.scrollWidth > document.body.clientWidth
      }));
      assert.equal(state.scrollable, true);
      assert.equal(state.scrolled, true);
      assert.equal(state.horizontalOverflow, false);
      assert.equal(state.bodyOverflow, false);
      assert.notEqual(state.outlineWidth, '0px');
      await page.screenshot({path: join(artifacts, `${theme}-${width}.png`)});
      const audit = await page.evaluate(`(${shadowAudit})({root: '#root', viewport: true})`);
      assert.equal(audit.cut, 0);
      audits.push({theme, width, audit});
    }
  }
  writeFileSync(join(artifacts, 'shadow-audit.json'), JSON.stringify(audits, null, 2));
});


test('malformed artifact links explicitly disable all gate decisions', async () => {
  for (const links of [null, [], [{title:'Title without identity'}]]) {
    await page.evaluate(links => {decisions=[];mount(null, 'a'.repeat(64), links);}, links);
    assert.equal(await page.getByTestId('assistant-gate-approve').isDisabled(), true);
    assert.equal(await page.getByTestId('assistant-gate-reject').isDisabled(), true);
    assert.match(await page.locator('[role="alert"]').first().innerText(), /闸门决定已禁用/u);
    assert.deepEqual(await page.evaluate(()=>decisions), []);
  }
});


test('explicit whole-stage refresh repairs malformed links, blocks decisions during failed reads and uses newly displayed plan and versions', async () => {
  const plan=researchSearchPlanFixture('新的完整检索问题',[{query:'New explicit query',sources:['crossref'],limit:3,maxPages:2}]);
  gateResult={ok:false,error:{code:'gate_read_failed',message:'实际阶段读取失败',category:'internal',retryable:true}};
  await page.evaluate(()=>{decisions=[];mount(null,'invalid',null);});
  await page.getByTestId('assistant-gate-refresh').focus();await page.keyboard.press('Enter');
  await page.getByText('实际阶段读取失败',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('assistant-gate-approve').isDisabled(),true);
  assert.equal(await page.getByTestId('assistant-gate-reject').isDisabled(),true);
  gateResult={ok:true,data:{projectId:'synthetic-project',stage:'discovery',artifactLinks:[{
    projectId:'synthetic-project',artifactId:'new-artifact',expectedVersion:'c'.repeat(64),title:'新计划',kind:'search_strategy'}],
    searchPlan:plan,searchPlanHash:'d'.repeat(64),readAt:'2026-11-04T00:00:00.000Z'}};
  deferGate=true;
  await page.getByTestId('assistant-gate-refresh').click();
  await page.getByText('正在读取全部阶段工件…',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('assistant-gate-approve').isDisabled(),true);
  assert.equal(await page.getByTestId('assistant-gate-reject').isDisabled(),true);
  while(typeof finishGate!=='function')await new Promise(resolve=>setTimeout(resolve,5));
  deferGate=false;finishGate();
  await page.getByTestId('assistant-gate-reviewed-at').waitFor();
  assert.match(await page.getByTestId('assistant-gate-search-plan').innerText(),/New explicit query/u);
  assert.equal(await page.getByTestId('assistant-gate-approve').isDisabled(),false);
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
  assert.deepEqual(gateRequests.at(-1),{projectId:'synthetic-project',expectedStage:'discovery',artifactId:null});
  await page.getByTestId('assistant-gate-approve').focus();await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(()=>decisions),[{id:'plan-gate',values:[{type:'approve',
    reviewedArtifactVersions:[{artifactId:'new-artifact',version:'c'.repeat(64)}],reviewedSearchPlanHash:'d'.repeat(64)}]}]);
});
