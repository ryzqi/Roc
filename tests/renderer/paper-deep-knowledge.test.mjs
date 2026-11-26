import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture} from '../unit/fixtures/scientific-search-fixture.mjs';
import {scientificWikiCandidates} from '../unit/fixtures/scientific-wiki-fixture.mjs';

let api, service, fixture, directory, app, page, hold, modelCalls = 0;
const calls = [], errors = [];
before(async () => {
  api = await loadScientificSearchApi(); fixture = await scientificSearchFixture(api, {embedded: false});
  const {ScientificExtractionService} = await importTypeScriptModule('src/main/plugins/research/scientific-extraction-service.ts',
    {platform: 'node', external: ['@napi-rs/canvas'], tempDir: '.runtime/tmp'});
  service = new ScientificExtractionService(fixture.repository, {library: fixture.root, index: null}, async () => ({
    config: {extractorVersion: 'roc-scientific-knowledge/1', promptVersion: 'fixture/1',
      model: {provider: 'fixture', modelId: 'fixture', model: 'fixture', revision: '1'}, inputTokens: 32000, batchTokens: 8000},
    invoke: async (call, signal) => {
      modelCalls++; assert.equal(call.name, 'scientific_deep_reading');
      if (hold) await new Promise((resolve, reject) => {
        hold.release = resolve; signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      });
      const input = JSON.parse(call.messages[1].content), object = input.batch.objects[0];
      if (!object) return {claims: [], relationships: []};
      const dimension = object.objectType === 'Equation' ? 'mathematical_formulation' : 'experiments';
      return {claims: ['author_stated', 'source_derived', 'model_inference'].map((provenance, index) => ({
        id: `claim-${index}`, dimension, aspect: 'summary', objectId: object.objectId, provenance,
        text: provenance === 'model_inference' ? '仅用于理解的解释，结论仍需研究者核验。' : '保留原文对象与来源。',
        evidence: [{kind: 'object', objectType: object.objectType, objectId: object.objectId}]
      })), relationships: []};
    }
  }), () => 'fixture/1', {pollMs: 60000});
  const job = await service.enqueue({projectId: fixture.project.id, documentId: fixture.document.id});
  fixture.repository.scientificExtraction.claim(job.id, fixture.project.id);
  fixture.repository.scientificExtraction.publish(job.id, fixture.project.id, scientificWikiCandidates(fixture.ir), fixture.ir, () => job.snapshot);
  service.start(); await service.idle();
  directory = await mkdtemp(join(tmpdir(), 'roc-paper-deep-ui-'));
  await buildViteRenderer({directory, script: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {PaperDeepKnowledge} from './src/renderer/literature/PaperDeepKnowledge';
    import {ViewActivity} from './src/renderer/shared/view-activity';
    const root=createRoot(document.getElementById('root'));
    const methods=['readPaperDeepKnowledge','requestPaperDeepKnowledge','cancelScientificExtraction','retryScientificExtraction',
      'resolveDocumentParse','readWikiPaperKnowledge'];
    const client={api:{research:Object.fromEntries(methods.map(method=>[method,input=>window.fromMain(method,input)]))}};
    let serial=0;
    window.mount=props=>flushSync(()=>root.render(<ViewActivity active><PaperDeepKnowledge key={++serial} client={client} {...props}/></ViewActivity>));
    window.unmount=()=>flushSync(()=>root.render(null));
  `, style: 'html,body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,sans-serif}#root{width:min(100%,600px);padding:16px;box-sizing:border-box}'});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:850}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('fromMain', async (method, input) => {
    calls.push({method, input});
    try {
      if (method === 'readPaperDeepKnowledge') return {ok: true, data: await service.readDeep(input)};
      if (method === 'requestPaperDeepKnowledge') return {ok: true, data: await service.requestDeep(input)};
      if (method === 'cancelScientificExtraction') return {ok: true, data: service.cancel(input)};
      if (method === 'retryScientificExtraction') return {ok: true, data: await service.retry(input)};
      if (method === 'readWikiPaperKnowledge') return {ok: true, data: await service.readPaperCard(input)};
      if (method === 'resolveDocumentParse') return {ok: false, error: {message: '本测试不打开 PDF；原文定位请求已记录。'}};
      throw new Error(`Unexpected method ${method}`);
    } catch (error) {return {ok: false, error: {message: error.message}};}
  });
});
after(async () => {
  hold?.release?.();
  try {await app?.close(); await service?.shutdown(); await fixture?.close(); api?.dispose();}
  finally {if (directory) await rm(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});
const mount = objectId => page.evaluate(props => window.mount(props), {
  projectId: fixture.project.id, documentId: fixture.document.id, ...(objectId ? {objectId} : {})
});

test('opening is read-only; explicit object deep reading renders provenance, unknown gaps and exact source navigation', async () => {
  await mount(fixture.ir.equations[0].id);
  assert.equal(modelCalls, 0); assert.equal(calls.length, 0);
  const open = page.getByRole('button', {name: '深入阅读此对象'});
  await open.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: '生成深读'})).toBeEnabled(); assert.equal(modelCalls, 0);
  await page.getByRole('button', {name: '生成深读'}).click();
  await expect(page.getByTestId('reading-deep-source-status')).toHaveText('原始来源已校验');
  assert.equal(modelCalls, 1);
  const request = calls.find(call => call.method === 'requestPaperDeepKnowledge').input;
  assert.deepEqual(request.objectIds, [fixture.ir.equations[0].id]); assert.deepEqual(request.dimensions, ['mathematical_formulation']);
  await expect(page.getByText('未经科学审核', {exact: true})).toBeVisible();
  for (const label of ['作者陈述', '原文整理', '模型推断']) await expect(page.getByText(label, {exact: true})).toBeVisible();
  assert.ok(await page.getByText('未知：原文依据不足', {exact: true}).count() > 0);
  await page.getByRole('button', {name: /原文依据 1/}).first().click();
  await expect(page.getByText('本测试不打开 PDF；原文定位请求已记录。', {exact: true})).toBeVisible();
  const source = calls.find(call => call.method === 'resolveDocumentParse').input;
  assert.equal(source.projectId, fixture.project.id); assert.equal(source.parseId, fixture.ir.identity.parseId);
  await page.setViewportSize({width: 380, height: 850});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.ROC_UI_CAPTURE_DIR) {
    await mkdir(process.env.ROC_UI_CAPTURE_DIR, {recursive: true});
    await page.screenshot({path: join(process.env.ROC_UI_CAPTURE_DIR, 'deep-light.png')});
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  if (process.env.ROC_UI_CAPTURE_DIR) await page.screenshot({path: join(process.env.ROC_UI_CAPTURE_DIR, 'deep-dark.png')});
  assert.equal(await page.getByRole('button', {name: '生成深读'}).isEnabled(), true);
});

test('running deep jobs can be cancelled and retried with visible backend status', async () => {
  await mount(); hold = {};
  await page.getByRole('button', {name: '深度阅读', exact: true}).click();
  await expect(page.getByRole('button', {name: '生成深读'})).toBeEnabled();
  await page.getByRole('button', {name: '生成深读'}).click();
  await expect(page.getByRole('button', {name: '取消深读'})).toBeVisible();
  await expect(page.getByRole('button', {name: '生成深读'})).toBeDisabled();
  await page.getByRole('button', {name: '取消深读'}).click();
  await expect(page.getByRole('button', {name: '重试深读'})).toBeVisible();
  await expect(page.getByRole('status').filter({hasText: '深读已取消'})).toBeVisible();
  hold.release?.(); hold = null;
  await page.getByRole('button', {name: '重试深读'}).click();
  await expect(page.getByRole('status').filter({hasText: '深读已生成'})).toBeVisible();
  assert.equal(calls.filter(call => call.method === 'cancelScientificExtraction').length, 1);
  assert.equal(calls.filter(call => call.method === 'retryScientificExtraction').length, 1);
  await fixture.publish(); await service.idle();
  await page.getByRole('button', {name: '刷新深读'}).click();
  await expect(page.getByTestId('reading-deep-source-status')).toContainText('已过期');
  await expect(page.getByRole('button', {name: /原文依据 1/}).first()).toBeDisabled();
  await page.evaluate(() => window.unmount());
});
