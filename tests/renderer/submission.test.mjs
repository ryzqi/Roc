import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {createResearchFixture, loadResearchTestApi, unknownExperiment} from '../unit/fixtures/research-test-kit.mjs';
import {syntheticExportPublicationReview} from '../fixtures/research-export-publication.mjs';

let api, app, page, directory, active, windowId;
const fixtures = [], errors = [], calls = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const routes = {getExport: ['roc:research:export-get', 'research.getExport'],
  listSubmissionProfiles: ['roc:research:submission-profile-list', 'research.listSubmissionProfiles'],
  getSubmissionProfile: ['roc:research:submission-profile-get', 'research.getSubmissionProfile'],
  prepareSubmission: ['roc:research:submission-prepare', 'research.prepareSubmission'],
  getSubmission: ['roc:research:submission-get', 'research.getSubmission'],
  listSubmissions: ['roc:research:submission-list', 'research.listSubmissions'],
  deliverSubmission: ['roc:research:submission-deliver', 'research.deliverSubmission']};
before(async () => {
  api = await loadResearchTestApi(); directory = await mkdtemp(join(tmpdir(), 'roc-submission-ui-'));
  await buildViteRenderer({directory, style: 'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,sans-serif}main{max-width:760px;padding:16px}', script: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domMax} from 'motion/react';
    import {ExportExecutionReceipt} from './src/renderer/artifacts/ExportExecutionReceipt';
    import {ArtifactEditorBoundary,useArtifactEditorActivity,useArtifactEditorGuard} from './src/renderer/artifacts/artifact-editor-guard';
    const root=createRoot(document.getElementById('root'));
    const client={api:{research:Object.fromEntries(${JSON.stringify(Object.keys(routes))}.map(method=>[method,input=>window.callMain(method,input)]))}};
    function Harness({record}) {
      const activity=useArtifactEditorActivity('导出'),guard=useArtifactEditorGuard();
      return <main><button type="button" data-testid="fixture-close" disabled={guard.busy()} onClick={()=>guard.request(()=>{})}>关闭</button>
        <ExportExecutionReceipt client={client} record={record} writable onDirty={activity.setDirty} onPending={activity.setPending}/></main>;
    }
    window.mount=record=>flushSync(()=>root.render(<MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict>
      <ArtifactEditorBoundary projectId={record.projectId}><Harness record={record}/></ArtifactEditorBoundary>
    </LazyMotion></MotionConfig>));
    window.unmount=()=>flushSync(()=>root.render(null));
  `});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:900,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
  windowId = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('callMain', async (method, input) => {
    const f = active; calls.push({method, input}); api.parseIpcRequestArgs(routes[method][0], [input]);
    const result = await f.bridge.invoke(routes[method][1], [input], windowId);
    if (f.defer === method) await new Promise(done => {f.release = done;});
    return result;
  });
  await page.waitForFunction(() => typeof mount === 'function');
});
after(async () => {
  try {if (page && !page.isClosed()) await page.evaluate(() => window.unmount?.()); await app?.close();}
  finally {for (const f of fixtures) {await f.submissions?.shutdown(); await f.close();} api?.dispose(); if (directory) await rm(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});

async function scene() {
  const root = join(directory, 'material'); await mkdir(root);
  const f = createResearchFixture(api, 'writing', root); fixtures.push(f);
  const projectId = f.project.id;
  f.repository.knowledge.upsertFromSource({id: 'submission-source', projectId, sourceType: 'file', sourceId: 'synthetic.txt', title: 'Source',
    content: 'Measured difference was -4 ms.', chunks: [{content: 'Measured difference was -4 ms.', locator: 'block:0'}], embeddingPolicy: 'none'});
  const evidence = f.repository.evidence.capture({projectId, chunkId: 'submission-source:chunk:0'});
  const manuscript = f.withWorker(() => f.repository.runs.complete(f.run.id, projectId, {title: 'Submission manuscript', markdown: 'Synthetic',
    claims: [{experiment: {...unknownExperiment}, subjectType: 'paragraph', status: 'supported', content: 'Ada Example reported a difference of -4 ms.', evidenceIds: [evidence.id]}],
    sections: [{title: 'Results', claimIndexes: [0]}], verdict: 'ready'})).outputArtifactIds[0];
  const claim = f.repository.evidence.listClaims({projectId, artifactId: manuscript})[0];
  const source = f.repository.evidence.inspectEvidence(evidence.id, projectId);
  const relation = f.repository.evidence.relations.propose({projectId, claimId: claim.id, expectedClaimVersion: claim.version, evidenceId: evidence.id,
    expectedSourceDigest: api.relationSourceDigest(source), kind: 'supports', condition: null, supersedesRelationId: null}, {kind: 'user', id: 'fixture-reviewer'});
  f.repository.evidence.relations.review({projectId, relationId: relation.id, expectedVersion: relation.version, expectedClaimVersion: claim.version,
    expectedSourceDigest: relation.sourceDigest, decision: 'confirm', note: 'Synthetic original inspected.'}, {kind: 'user', id: 'fixture-reviewer'});
  f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(manuscript);
  f.db.prepare("UPDATE research_projects SET current_stage='export' WHERE id=?").run(projectId);
  f.db.prepare(`INSERT INTO research_review_cycles(project_id,origin_artifact_id,manuscript_artifact_id,revision_round,status,report_artifact_ids_json,updated_at)
    VALUES(?,?,?,0,'accepted','[]',?)`).run(projectId, manuscript, manuscript, new Date().toISOString());
  const sources = new api.ResearchExportSourceService(f.repository, {verify: async () => assert.fail('no figures')},
    {snapshot: async () => assert.fail('no experiment')}, {files: async () => assert.fail('default template')});
  const selection = {projectId, manuscriptArtifactId: manuscript, figureIds: [], template: {kind: 'default', language: 'en'}};
  const frozen = await sources.capture(selection, new AbortController().signal);
  const candidates = await sources.inputs(selection, new AbortController().signal);
  // The approved parent and compiler are controlled test adapters; all derivative storage,
  // PDF parsing, archive verification, capability checks and delivery use production code.
  const parent = {id: 'frozen-export', projectId, request: {...selection, requestId: 'parent', title: 'Ada Example findings',
    publicationReview: syntheticExportPublicationReview(candidates)}, ownerRunId: null, status: 'ready', sources: frozen, sourceHash: hash(JSON.stringify(frozen)),
    toolchainHash: hash('fixture'), files: [], archive: null, artifactId: null, approval: 'approved', replacesExportId: null, error: null,
    createdAt: new Date().toISOString(), endedAt: new Date().toISOString()};
  f.repository.exports.root = () => root;
  let compiles = 0;
  f.submissions = new api.ResearchSubmissionService(f.db, f.repository, {inspect: async () => parent}, {
    status: async () => ({available: true, versions: {}, error: null}), identity: async () => parent.toolchainHash,
    compile: async input => {
    compiles++;
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText('Measured difference was -4 ms. Data availability.', {x: 40, y: 700, font, size: 12});
    await writeFile(join(input.outputDir, 'main.pdf'), await pdf.save());
    return {exitCode: 0, stdout: '', stderr: ''};
  }}, join(root, 'submissions'));
  const profile = api.withResearchHumanContext({projectId, capability: 'research.submissionProfiles.save', windowId: 73},
    () => f.repository.submissionProfiles.save({projectId, requestId: 'profile', profileId: null, parent: null,
      profile: {journal: 'Synthetic journal', articleType: 'Article', submissionStage: 'Initial', version: '1', revisionDate: '2026-11-22',
        dateAuthority: 'human_transcription', retrievedAt: '2026-11-22T00:00:00.000Z', rules: [{id: 'manual', label: 'Synthetic requirement',
          sourceUrl: 'https://example.org/rules', excerpt: 'Synthetic engineering policy.', authority: 'required', kind: 'manual', area: 'structure'}]},
      requirements: {maximumPages: 2, anonymous: true, requiredDeclarations: ['Data availability'], minimumEditableTables: 0, supplementPaths: []}}));
  const handlers = new Map(), context = {pluginId: 'fixture', capabilities: {register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}}};
  api.registerResearchSubmissionProfileCapabilities(context, f.repository.submissionProfiles);
  api.registerResearchSubmissionCapabilities(context, f.submissions);
  handlers.set('research.export.get', async () => parent);
  const destination = join(root, 'delivered.zip');
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => handlers.get(name)(input)}, async id => {
    assert.equal(id, windowId); return f.pickDestination ?? null;
  });
  return Object.assign(f, {root, parent, profile, destination, compiles: () => compiles});
}

test('submission UI derives an anonymous bundle, keeps masked manual preflight and delivers only through the native destination', async () => {
  active = await scene(); const f = active;
  await page.evaluate(parent => window.mount(parent), f.parent);
  await page.getByTestId('artifact-submission-toggle').waitFor();
  assert.deepEqual(calls.map(call => call.method), ['getExport']);
  await page.getByTestId('artifact-submission-toggle').focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('artifact-submission-toggle')).toHaveAttribute('aria-expanded', 'true');
  const panel = page.getByTestId('artifact-submission');
  await expect(panel).toBeVisible();
  await panel.getByRole('combobox', {name: '投稿配置', exact: true}).selectOption(f.profile.snapshot.id);
  await panel.getByRole('combobox', {name: '投稿版本', exact: true}).selectOption('anonymous');
  await panel.getByLabel('待替换的身份词（每行一项）', {exact: true}).fill('Ada Example');
  f.defer = 'prepareSubmission';
  await panel.getByTestId('artifact-submission-prepare').click();
  await expect(page.getByTestId('fixture-close')).toBeDisabled();
  await expect.poll(() => typeof f.release).toBe('function'); f.release(); delete f.defer;
  const receipt = panel.getByTestId('artifact-submission-receipt'); await receipt.waitFor();
  await expect(receipt).toContainText('实际编译 PDF：1 页');
  await expect(receipt).toContainText('需人工核对');
  assert.equal(await panel.getByLabel('待替换的身份词（每行一项）', {exact: true}).inputValue(), '');
  const stored = f.submissions.list({projectId: f.project.id, offset: 0, limit: 10}).items[0];
  assert.equal(stored.record.status, 'ready', JSON.stringify(stored));
  assert.equal(stored.record.preflight.status, 'manual');
  assert.equal(JSON.stringify(stored).includes('Ada Example'), false);
  const row = f.db.prepare('SELECT root_path FROM research_submissions WHERE id=?').get(stored.record.id);
  const manuscript = await readFile(join(row.root_path, 'bundle/source/manuscript.tex'), 'utf8');
  assert.match(manuscript, /Anonymous reported/u); assert.equal(manuscript.includes('Ada Example'), false);
  const deliver = receipt.getByTestId('artifact-submission-deliver'); await expect(deliver).toBeDisabled();
  await receipt.getByLabel('人工投稿核对说明', {exact: true}).fill('Inspected every manual journal item and the generated anonymous files.');
  await deliver.click();
  await expect(deliver).toBeEnabled();
  assert.equal(f.db.prepare('SELECT count(*) FROM research_submission_deliveries').pluck().get(), 0);
  f.pickDestination = f.destination;
  const audit = await readFile('scripts/ui-audit/clip-audit.js', 'utf8');
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(620, 800));
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme); await deliver.focus();
    assert.equal((await page.evaluate(`(${audit})({root:'main',viewport:true})`)).cut, 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await deliver.click(); await expect(receipt.getByRole('status')).toContainText('已保存到');
  assert.equal(hash(await readFile(f.destination)), stored.record.archive.sha256);
  assert.equal(f.compiles(), 1);
  const wireRequests = calls.filter(call => call.method === 'deliverSubmission').map(call => call.input);
  assert.ok(wireRequests.every(input => !Object.hasOwn(input, 'destinationPath')));
  assert.equal(f.parent.request.title, 'Ada Example findings');
});
