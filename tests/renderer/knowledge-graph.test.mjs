import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import electronPath from 'electron';
import { _electron, expect } from '@playwright/test';
import { buildViteRenderer } from './fixtures/build-vite-renderer.mjs';
import { graphPerformanceFixture } from '../../scripts/lib/research-graph-performance-fixture.mjs';
let directory, app, page;
const errors = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/graph-ui');
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-graph-ui-')); mkdirSync(artifacts, { recursive: true });
  await buildViteRenderer({ directory, script: `
    import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
    import {KnowledgeGraphView} from './src/renderer/literature/KnowledgeGraphView';
    const root=createRoot(document.getElementById('root'));let generation=0;
    window.asked=[];
    window.mount=(input,fresh=true,focusClaimId=null)=>{if(fresh)generation++;
      flushSync(()=>root.render(<main data-testid="fixture-container"><KnowledgeGraphView key={generation} {...input} focusClaimId={focusClaimId} onAskAssistantAboutNode={node=>window.asked.push(node.id)}/></main>));};`,
    style: 'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}main{height:100vh;width:100%;font-size:13px}' });
  writeFileSync(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, 'data'))});app.whenReady().then(()=>new BrowserWindow({show:false,width:1250,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({ executablePath: electronPath, args: [join(directory, 'main.cjs')] });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof mount === 'function');
});
after(async () => { try { await app?.close(); } finally { if (directory) rmSync(directory, { recursive: true, force: true }); } assert.deepEqual(errors, []); });
const button = name => page.getByRole('button', { name, exact: true });
const nodes = () => page.getByTestId('graph-node-list').locator('li button');
const neighbors = () => page.getByTestId('graph-neighbours').locator('li button');
const mount = (count = 1000, fresh = true, focusClaimId = null) => page.evaluate(({ input, fresh, focusClaimId }) => window.mount(input, fresh, focusClaimId), { input: graphPerformanceFixture(count), fresh, focusClaimId });

test('empty and no-match states expose only real data', async () => {
  await page.evaluate(() => window.mount({ claims: [], evidence: [], libraryItems: [] }));
  await expect(page.getByTestId('graph-empty')).toBeVisible(); await expect(nodes()).toHaveCount(0);
  await mount(); await page.getByLabel('过滤图谱节点').fill('absent-term');
  await expect(page.getByTestId('graph-no-match')).toBeVisible(); await expect(nodes()).toHaveCount(0);
  await expect(button('下一页节点')).toBeDisabled(); await button('清除节点过滤').click(); await expect(nodes()).toHaveCount(50);
});
test('independent pages show every last item and filter changes reset node pagination', async () => {
  await mount(); await expect(nodes()).toHaveCount(50); await expect(button('上一页节点')).toBeDisabled();
  await expect(page.getByTestId('graph-counts')).toHaveText('1001 节点 / 1000 引用与来源关系');
  await button('下一页节点').click(); await expect(page.getByTestId('graph-nodes-page')).toContainText('2 / 21');
  await page.getByTestId('graph-filter-claim').click(); await expect(page.getByTestId('graph-nodes-page')).toContainText('1 / 20');
  await button('下一页节点').click(); await page.getByLabel('过滤图谱节点').fill('Claim 999');
  await expect(nodes()).toHaveCount(1); await expect(page.getByTestId('graph-nodes-page')).toContainText('1 / 1');
  await page.getByTestId('graph-node-claim:c-999').click();
  await expect(neighbors()).toHaveCount(50); await expect(page.getByTestId('graph-neighbour-count')).toHaveText('相连及共享证据（1000）');
  const ids = [];
  for (let i = 0; i < 20; i++) {
    ids.push(...await neighbors().evaluateAll(elements => elements.map(element => element.dataset.testid)));
    if (i < 19) await button('下一页邻域').click();
  }
  assert.equal(ids.length, 1000); assert.equal(new Set(ids).size, 1000); assert.equal(ids.includes('graph-neighbour-claim:c-999'), false);
  assert.equal(ids.at(-1), 'graph-neighbour-claim:c-998'); await expect(button('下一页邻域')).toBeDisabled();
  await page.getByTestId('graph-neighbour-claim:c-998').click(); await expect(page.getByTestId('graph-detail-id')).toHaveText('claim:c-998');
  await expect(page.getByTestId('graph-neighbours-page')).toContainText('1 / 20');
});
test('shrinking projection clamps pages and removes unavailable selected data', async () => {
  await mount(); for (let i = 0; i < 4; i++) await button('下一页节点').click();
  await page.getByTestId('graph-node-claim:c-200').click(); for (let i = 0; i < 4; i++) await button('下一页邻域').click();
  await mount(10, false); await expect(nodes()).toHaveCount(11); await expect(page.getByTestId('graph-no-selection')).toBeVisible();
  await expect(page.getByTestId('graph-nodes-page')).toContainText('1 / 1'); await expect(button('下一页节点')).toBeDisabled();
  await mount(1000); await page.getByTestId('graph-node-claim:c-0').click(); for (let i = 0; i < 4; i++) await button('下一页邻域').click();
  await mount(10, false); await expect(neighbors()).toHaveCount(10); await expect(page.getByTestId('graph-neighbours-page')).toContainText('1 / 1');
});
test('keyboard follows shared neighbors and invokes the actual assistant callback', async () => {
  await mount(1000, true, 'c-0'); await expect(page.getByTestId('graph-detail-id')).toHaveText('claim:c-0');
  const neighbor = page.getByTestId('graph-neighbour-claim:c-1'); await neighbor.focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('graph-detail-id')).toHaveText('claim:c-1');
  const ask = page.getByTestId('graph-ask-assistant'); await ask.focus(); await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => window.asked.at(-1)), 'claim:c-1');
  await button('下一页邻域').focus(); await page.keyboard.press('Enter'); await expect(page.getByTestId('graph-neighbours-page')).toContainText('2 / 20');
});
test('50k high-degree data paints bounded lists with first-frame evidence', async () => {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const sample = await page.evaluate(async input => {
      const start = performance.now(); window.mount(input, true, 'c-0'); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      return { elapsedMs: performance.now() - start, nodeButtons: document.querySelectorAll('[data-testid="graph-node-list"] li button').length,
        neighborButtons: document.querySelectorAll('[data-testid="graph-neighbours"] li button').length,
        text: document.querySelector('[data-testid="graph-detail-id"]').textContent };
    }, graphPerformanceFixture(50_000));
    assert.equal(sample.nodeButtons, 50); assert.equal(sample.neighborButtons, 50); assert.equal(sample.text, 'claim:c-0'); assert.ok(sample.elapsedMs < 2500);
    samples.push(sample);
  }
  writeFileSync(join(artifacts, 'first-frame.json'), JSON.stringify({ claims: 50_000, samples, electron: process.versions.electron ?? null, fixture: 'research-graph-performance-fixture.mjs', note: 'Two real animation frames after mount; includes derivation and DOM paint, no provider/database IO.' }, null, 2) + '\n');
});
test('light/dark wide/narrow views retain visible details, controls, focus and unclipped states', async () => {
  const clip = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  const evidence = [];
  for (const width of [1250, 1099, 650]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(value => document.documentElement.dataset.theme = value, theme); await mount(1000, true, 'c-0');
    for (const state of ['static', 'hover', 'expanded', 'focus']) {
      const target = button('下一页邻域');
      if (state === 'hover') await target.hover(); if (state === 'expanded') await target.click(); if (state === 'focus') { await target.focus(); await page.keyboard.press('Tab'); }
      await expect(page.getByTestId('graph-detail-id')).toBeVisible(); await expect(page.getByTestId('graph-ask-assistant')).toBeVisible();
      const audit = await page.evaluate(clip => eval(clip)({ root: '[data-testid="fixture-container"]', viewport: true }), clip);
      assert.equal(audit.cut, 0, JSON.stringify(audit));
      const layout = await page.evaluate(() => {
        const visible = ['graph-nodes-pagination', 'graph-neighbours-pagination', 'graph-ask-assistant', 'graph-detail-id'].every(id => {
          const r = document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect(); return r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        }); return { visible, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.deepEqual(layout, { visible: true, overflow: false }); evidence.push({ width, theme, state, ...audit });
    }
    await page.screenshot({ path: join(artifacts, `${theme}-${width}.png`) });
  }
  writeFileSync(join(artifacts, 'clip-states.json'), JSON.stringify(evidence, null, 2));
});
