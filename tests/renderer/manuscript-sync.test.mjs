import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let app, directory, page;
const errors = [];
const hash = 'a'.repeat(64);
const binding = {texPath: 'main.tex', bibPath: 'references.bib'};
const change = {id: 'result-edit', kind: 'claim', label: 'Results 段落', before: 'Mean latency was 3 ms.', after: 'Mean latency was 4 ms.',
  claimId: 'claim-1', evidenceIds: ['old-evidence'], citationKeys: ['source2026']};
const remaining = {id: 'section-edit', kind: 'section', label: '标题变更', before: 'Discussion', after: 'Limitations', claimId: null,
  evidenceIds: [], citationKeys: []};

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-manuscript-sync-ui-'));
  await buildViteRenderer({directory, style: 'html,body,#root{height:100%;margin:0}', script: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {LazyMotion, MotionConfig, domMax} from 'motion/react';
    import {WritingView} from './src/renderer/latex/WritingView';
    import {WorkspaceScopeProvider} from './src/renderer/app/workspace-scope';
    import {researchManuscriptSyncAttachSchema, researchManuscriptSyncApplySchema, researchManuscriptSyncInspectionSchema}
      from './src/shared/schemas/research-manuscript-sync';
    const ok = data => ({ok:true,data});
    const stored = {projectId:'project', artifactId:'original', artifactVersion:${JSON.stringify(hash)}, previewHash:${JSON.stringify(hash)},
      binding:null, canApply:false, status:'unbound', changes:[], issues:[]};
    const changes = ${JSON.stringify([change, remaining])};
    window.calls = [];
    const record = (method, input) => window.calls.push({method, input});
    const inspection = value => ok(researchManuscriptSyncInspectionSchema.parse(value));
    let bound = stored;
    const client = {api:{files:{
      listTree: async () => ok({relativePath:'',truncated:false,entries:[{type:'file', name:'main.tex', relativePath:'main.tex', size:16, updatedAt:'2026-11-20T00:00:00.000Z'}]}),
      preview: async () => ok({relativePath:'main.tex',kind:'text',content:'Saved disk text',sizeBytes:16,truncated:false,mediaType:'text/plain'}),
      writeText: async input => {record('writeText',input); throw new Error('sync must leave editor saves explicit');}
    },research:{
      listArtifacts: async ({projectId}) => {record('listArtifacts',{projectId});return ok([
        {id:'original',title:'Synthetic manuscript',kind:'manuscript',status:'approved'},
        ...(bound.artifactId==='revision'?[{id:'revision',title:'Revised manuscript',kind:'manuscript',status:'draft'}]:[]),
        {id:'figure',title:'Figure hidden from selection',kind:'figure',status:'draft'}]);},
      inspectManuscriptSync: async input => {record('inspect',input);return inspection(bound);},
      attachManuscriptSync: async input => {
        record('attach',researchManuscriptSyncAttachSchema.parse(input));
        bound = {...stored,binding:${JSON.stringify(binding)},canApply:true,status:'changed',changes};
        return inspection(bound);
      },
      listEvidence: async input => {record('evidence',input);return ok([
        {id:'old-evidence',title:'Earlier experiment',locator:'Metric mean',excerpt:'3 ms'},
        {id:'new-evidence',title:'Repeated experiment',locator:'Metric mean',excerpt:'4 ms'}]);},
      applyManuscriptSync: async input => {
        record('apply',researchManuscriptSyncApplySchema.parse(input));
        await new Promise(done=>window.finishApply=done);
        bound = {...bound,artifactId:'revision',artifactVersion:'b'.repeat(64),changes:changes.slice(1)};
        return inspection(bound);
      }
    }}};
    const scope = {client,projectId:'project',workspacePath:'/isolated',workspaceStatus:'ready', writable:true,
      tool:null,openTool:()=>{},openFileInCanvas:path=>record('openFile',path),openArtifact:input=>record('openArtifact',input)};
    const root=createRoot(document.getElementById('root'));
    window.unmount = () => root.unmount();
    root.render(<MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict>
      <WorkspaceScopeProvider value={scope}><WritingView/></WorkspaceScopeProvider>
    </LazyMotion></MotionConfig>);
  `});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1024,height:760}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
});

after(async () => {
  try {
    if (page && !page.isClosed()) await page.evaluate(() => window.unmount?.());
    await app?.close();
  } finally {if (directory) await rm(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});

test('writing canvas preserves the editor draft while applying selected changes to a revision', async () => {
  const editor = page.getByTestId('production-latex-content');
  await editor.fill('Keep this unsaved editor draft.');
  assert.deepEqual(await page.evaluate(() => window.calls), []);
  const opener = page.getByTestId('writing-manuscript-sync');
  await opener.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByTestId('writing-sync-panel');
  await expect(dialog.getByRole('option', {name: /Synthetic manuscript/u})).toBeAttached();
  await expect(dialog.getByRole('option', {name: /Figure hidden/u})).toHaveCount(0);
  await dialog.getByLabel('LaTeX 路径').fill(binding.texPath);
  await dialog.getByLabel('BibTeX 路径').fill(binding.bibPath);
  await dialog.getByRole('button', {name: '绑定已有文件'}).click();
  await expect(dialog.getByText(change.after, {exact: true})).toBeVisible();
  const apply = dialog.getByTestId('writing-sync-apply');
  await expect(apply).toBeDisabled();
  await dialog.getByRole('checkbox', {name: change.label}).check();
  await dialog.getByLabel('添加项目证据').selectOption('new-evidence');
  await dialog.getByRole('button', {name: '移除证据'}).first().click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('artifact-draft-discard')).toBeVisible();
  await page.getByTestId('artifact-draft-discard-cancel').click();
  await expect(dialog.getByRole('checkbox', {name: change.label})).toBeChecked();

  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(620, 740));
  const audit = await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await apply.focus();
    await expect(apply).toBeFocused();
    assert.equal(await dialog.evaluate(panel => panel.scrollWidth > panel.clientWidth), false);
    assert.equal((await page.evaluate(`(${audit})({root:'body',viewport:true})`)).cut, 0);
  }
  await page.keyboard.press('Enter');
  await expect(dialog.getByTestId('writing-sync-close')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  const request = await page.evaluate(() => window.calls.find(call => call.method === 'apply').input);
  assert.deepEqual(request.changes, [{id: change.id, evidenceIds: ['new-evidence']}]);
  assert.equal(request.expectedPreviewHash, hash);
  await page.evaluate(() => window.finishApply());
  await expect(dialog.getByLabel('正文工件')).toHaveValue('revision');
  await expect(dialog.getByRole('checkbox', {name: remaining.label})).not.toBeChecked();
  await dialog.getByRole('button', {name: '核对正文工件'}).click();
  assert.deepEqual(await page.evaluate(() => window.calls.find(call => call.method === 'openArtifact').input), {
    projectId: 'project', artifactId: 'revision', expectedVersion: 'b'.repeat(64)
  });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(editor).toHaveText('Keep this unsaved editor draft.');
  const calls = await page.evaluate(() => window.calls);
  assert.equal(calls.some(call => call.method === 'writeText'), false);
  assert.equal(calls.filter(call => call.method === 'apply').length, 1);
  assert.deepEqual(calls.find(call => call.method === 'attach').input, {projectId: 'project', artifactId: 'original',
    expectedArtifactVersion: hash, mode: 'existing', ...binding});
});
