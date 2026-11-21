import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import * as yazl from 'yazl';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {createResearchFixture, loadResearchTestApi, unknownExperiment} from '../unit/fixtures/research-test-kit.mjs';

let api, app, page, directory, active, windowId;
const fixtures = [], calls = [], errors = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const routes = {inspectArtifact: 'artifact-inspect', inspectResponseMatrix: 'response-matrix-inspect', importFeedback: 'feedback-import', getFeedback: 'feedback-get',
  listFeedback: 'feedback-list', mergeFeedback: 'feedback-merge', createExternalExperiment: 'external-experiment-create',
  bindExternalExperiment: 'external-experiment-bind', getExternalExperiment: 'external-experiment-get',
  listExternalExperiments: 'external-experiment-list', previewExternalExperimentImport: 'external-experiment-preview-import',
  importExternalExperimentResult: 'external-experiment-import-result', getExternalExperimentResult: 'external-experiment-get-result',
  listExternalExperimentResults: 'external-experiment-list-results', captureExternalExperimentMetric: 'external-experiment-capture',
  deriveExternalExperimentResult: 'external-experiment-derive', prepareExternalExperimentFigure: 'external-experiment-figure'};
before(async () => {
  api = await loadResearchTestApi(); directory = await mkdtemp(join(tmpdir(), 'roc-collaboration-ui-'));
  await buildViteRenderer({directory, style: 'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,sans-serif}', script: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domMax} from 'motion/react';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    const root=createRoot(document.getElementById('root'));
    const client={api:{research:Object.fromEntries(${JSON.stringify(Object.keys(routes))}.map(method=>[method,input=>window.callMain(method,input)]))}};
    function Harness({request}) {
      const [open,setOpen]=useState(true),[locations]=useState(()=>new Map()),[drafts]=useState(()=>new Map());
      return open?<ArtifactInspector client={client} selection={{kind:'stage',request,onReviewContext:()=>{}}} writable
        readingLocations={locations} reviewDrafts={drafts} onClose={()=>setOpen(false)} onOpenTask={()=>{}}/>:null;
    }
    let generation=0;
    window.mount=request=>flushSync(()=>root.render(<MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict>
      <Harness key={++generation} request={request}/></LazyMotion></MotionConfig>));
    window.unmount=()=>flushSync(()=>root.render(null));
  `});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:940,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
});
after(async () => {
  try {await stopApp();} finally {for (const f of fixtures) await f.close(); api?.dispose(); if (directory) await rm(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});
async function launch() {
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message));
  windowId = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('callMain', async (method, input) => {
    const f = active; calls.push({method, input}); api.parseIpcRequestArgs(`roc:research:${routes[method]}`, [input]);
    const result = await f.bridge.invoke(`research.${method}`, [input], windowId);
    if (f.defer === method) await new Promise(done => {f.release = done;});
    return result;
  });
  await page.waitForFunction(() => typeof mount === 'function');
  await page.evaluate(request => window.mount(request), active.request);
  await page.getByTestId('artifact-inspector-content').waitFor();
}
async function stopApp() {
  if (page && !page.isClosed()) await page.evaluate(() => window.unmount?.());
  await app?.close(); app = undefined;
}
function connect(f) {
  const handlers = new Map(), context = {pluginId: 'fixture', capabilities: {register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}}};
  api.registerResearchArtifactInspectorCapability(context, f.repository);
  api.registerResearchResponseMatrixCapabilities(context, f.repository.responseMatrix);
  api.registerResearchFeedbackCapabilities(context, f.repository.feedback);
  api.registerResearchExternalExperimentCapabilities(context, f.repository.externalExperiments,
    new api.ResearchWorkspaceFileService(f.db, f.repository, () => new Date().toISOString()));
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => handlers.get(name)(input)});
}
async function scene() {
  const root = join(directory, 'workspace'); await writeFile(join(directory, 'placeholder'), '');
  const {mkdir} = await import('node:fs/promises'); await mkdir(root);
  const f = createResearchFixture(api, 'writing', root); fixtures.push(f); f.root = root;
  f.repository.knowledge.upsertFromSource({id: 'collaboration-source', projectId: f.project.id, sourceType: 'file', sourceId: 'source.txt', title: 'Synthetic source',
    content: 'Mean: 42 ms.', chunks: [{content: 'Mean: 42 ms.', locator: 'block:0'}], embeddingPolicy: 'none'});
  const evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'collaboration-source:chunk:0'});
  f.artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'writing', kind: 'manuscript', title: 'Collaboration manuscript', path: null});
  f.claims = ['Mean: 42 ms.', 'repeated repeated'].map(content => f.repository.evidence.createClaim({projectId: f.project.id, artifactId: f.artifact.id,
    subjectType: 'paragraph', status: 'supported', content, evidenceIds: [evidence.id], experiment: {...unknownExperiment}}));
  f.repository.manuscripts.saveManuscript({artifactId: f.artifact.id, sections: [{title: 'Results', claimIds: f.claims.map(claim => claim.id)}]});
  f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'fixture_ready');
  f.request = {projectId: f.project.id, artifactId: f.artifact.id, expectedVersion: null};
  connect(f); return f;
}
async function makeFeedback() {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', zip = new yazl.ZipFile(), chunks = [];
  const done = new Promise((resolve, reject) => {zip.outputStream.on('data', chunk => chunks.push(chunk));
    zip.outputStream.on('error', reject); zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));});
  for (const [name, contents] of Object.entries({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p><w:commentRangeStart w:id="1"/><w:r><w:t>Mean: 42 ms.</w:t></w:r><w:commentRangeEnd w:id="1"/>
      <w:commentRangeStart w:id="2"/><w:r><w:t>repeated</w:t></w:r><w:commentRangeEnd w:id="2"/><w:ins w:id="11" w:author="Coauthor"><w:r><w:t>Proposed addition.</w:t></w:r></w:ins></w:p></w:body></w:document>`,
    'word/comments.xml': `<w:comments xmlns:w="${W}"><w:comment w:id="1" w:author="Reviewer"><w:p><w:r><w:t>Report the sample size.</w:t></w:r></w:p></w:comment>
      <w:comment w:id="2"><w:p><w:r><w:t>Clarify repeated wording.</w:t></w:r></w:p></w:comment>
      <w:comment w:id="3"><w:p><w:r><w:t>Unanchored original.</w:t></w:r></w:p></w:comment></w:comments>`
  })) zip.addBuffer(Buffer.from(contents), name);
  zip.end(); return done;
}
async function openExternal() {
  await page.getByTestId('artifact-collaboration-toggle').click();
  await page.getByTestId('artifact-collaboration-external').click();
  await page.getByTestId('artifact-external-experiments').waitFor();
}

test('Word originals merge explicitly and a waiting external experiment survives actual renderer and SQLite restart', async () => {
  active = await scene(); const f = active, projectId = f.project.id;
  await writeFile(join(f.root, 'review.docx'), await makeFeedback());
  await launch();
  assert.deepEqual(calls.map(call => call.method), ['inspectArtifact']);
  await page.getByTestId('artifact-collaboration-toggle').focus(); await page.keyboard.press('Enter');
  await page.getByTestId('artifact-collaboration-feedback').click();
  const feedback = page.getByTestId('artifact-feedback');
  await feedback.getByLabel('意见文件（工作区 .docx / .pdf 相对路径）', {exact: true}).fill('review.docx');
  await feedback.getByTestId('artifact-feedback-import').click();
  await expect(feedback).toContainText('准确定位'); await expect(feedback).toContainText('多处匹配'); await expect(feedback).toContainText('尚未匹配');
  await feedback.getByRole('checkbox', {name: '批注：Report the sample size.', exact: true}).check();
  f.defer = 'mergeFeedback';
  await feedback.getByTestId('artifact-feedback-merge').click(); await expect(page.getByTestId('artifact-inspector-close')).toBeDisabled();
  await expect.poll(() => typeof f.release).toBe('function'); f.release(); delete f.defer;
  await expect(page.getByTestId('artifact-inspector-refresh')).toBeEnabled();
  assert.deepEqual(f.repository.evidence.listClaims({projectId, artifactId: f.artifact.id}).map(claim => claim.content), f.claims.map(claim => claim.content));
  const response = f.repository.responseMatrix.inspect({projectId, artifactId: f.artifact.id, expectedHash: null});
  assert.equal(response.report.externalComments.length, 1); assert.equal(response.report.externalComments[0].comment, 'Report the sample size.');
  await page.getByTestId('artifact-response-toggle').focus(); await page.keyboard.press('Enter');
  await page.getByTestId('artifact-response-hash').waitFor();
  await page.getByTestId('artifact-response-edit').click();
  const original = page.getByTestId('artifact-response-row');
  await expect(original).toHaveCount(1);
  await expect(original.getByRole('textbox', {name: '审稿人', exact: true})).toHaveValue('Reviewer');
  await expect(original.getByRole('textbox', {name: '原始审稿意见', exact: true})).toHaveValue('Report the sample size.');
  await expect(original.getByRole('textbox', {name: '原始审稿意见', exact: true})).toHaveAttribute('readonly', '');
  await expect(original.getByRole('combobox', {name: '人工处理状态', exact: true})).toHaveValue('open');
  await page.getByTestId('artifact-response-toggle').click();
  await page.getByTestId('artifact-collaboration-external').click();
  const external = page.getByTestId('artifact-external-experiments');
  await external.getByRole('button', {name: '新建外部实验合同', exact: true}).click();
  await external.getByLabel('交接要求', {exact: true}).fill('Report the declared signed measurement with its original CSV.');
  for (const [label, value] of [['指标 1 ID', 'mean'], ['指标 1 名称', 'Mean latency'], ['指标 1 定义', 'All externally recorded observations'], ['指标 1 单位', 'ms']]) {
    await external.getByLabel(label, {exact: true}).fill(value);
  }
  await external.getByRole('combobox', {name: '指标 1 方向', exact: true}).selectOption('neutral');
  await external.getByTestId('artifact-external-contract-save').click();
  await external.getByTestId('artifact-external-contract').waitFor();
  await external.getByLabel('外部执行方', {exact: true}).fill('External laboratory');
  await external.getByLabel('外部任务编号', {exact: true}).fill('external-42');
  await external.getByTestId('artifact-external-bind').click();
  await expect(external).toContainText('等待外部回传');
  const contract = f.repository.externalExperiments.list({projectId, artifactId: f.artifact.id, offset: 0, limit: 10}).items[0];
  assert.equal(contract.status, 'waiting');
  await stopApp();
  const researchPath = join(directory, 'restart-research.sqlite'), agentPath = join(directory, 'restart-agent.sqlite');
  await f.db.backup(researchPath); await f.agentDb.backup(agentPath); await f.close();
  f.db = new Database(researchPath); f.agentDb = new Database(agentPath);
  api.applyResearchDatabaseSchema(f.db); api.applyAgentDatabaseSchema(f.agentDb);
  f.tasks = new api.ResearchTaskRepository(f.agentDb); f.repository = new api.ResearchRepository(f.db, f.tasks);
  f.close = async () => {await Promise.all([f.repository.knowledgeJobs.shutdown(), f.repository.paperCards.shutdown(), f.repository.wiki.shutdown()]); f.db.close(); f.agentDb.close();};
  connect(f); await launch(); await openExternal();
  await page.getByTestId('artifact-external-experiments').getByRole('button', {name: /等待外部回传/u}).click();
  await expect(page.getByTestId('artifact-external-contract')).toContainText('外部编号 external-42');
  const unavailable = {kind: 'unavailable', reason: 'External report did not estimate it.'};
  const report = {schemaVersion: 1, contractId: contract.contract.snapshot.id, contractHash: contract.contract.snapshotHash, externalId: 'external-42',
    environment: {description: 'Reported laboratory environment', reportedBy: 'External operator'},
    method: {name: 'Descriptive mean', rationale: 'Use all observations', assumptions: 'Declared external dataset', limitations: 'Not independently reproduced'},
    result: {schemaVersion: 1, metrics: [{id: 'mean', value: -3, unit: 'ms', sampleSize: 4, uncertainty: unavailable, confidenceInterval: unavailable, effect: unavailable}]}, files: []};
  await writeFile(join(f.root, 'returned.json'), JSON.stringify(report));
  const returned = page.getByTestId('artifact-external-contract');
  await returned.getByLabel('回传报告 JSON（工作区相对路径）', {exact: true}).fill('returned.json');
  await returned.getByTestId('artifact-external-preview').click();
  await expect(returned.getByTestId('artifact-external-preview-result')).toContainText('Reported laboratory environment');
  await expect(returned.getByTestId('artifact-external-import')).toBeDisabled();
  await returned.getByRole('checkbox', {name: '已核对报告的方法、环境及实际回传文件', exact: true}).check();
  await returned.getByTestId('artifact-external-import').click();
  const result = page.getByTestId('artifact-external-result'); await result.waitFor();
  await expect(result).toContainText('未经独立验证'); await expect(result).toContainText('-3 ms');
  await result.getByRole('combobox', {name: '外部证据指标', exact: true}).selectOption('mean');
  await result.getByTestId('artifact-external-capture').click();
  await expect(result.getByRole('status')).toContainText('外部报告证据');
  await result.getByTestId('artifact-external-figure').click();
  const path = result.getByTestId('artifact-external-figure-path'); await path.waitFor();
  const figurePath = await path.innerText(), figureSource = await readFile(join(f.root, figurePath), 'utf8');
  assert.equal(figurePath, `results/${hash(figureSource)}.vl.json`);
  assert.equal(JSON.parse(figureSource).data.values[0].value, -3);
  const last = f.repository.externalExperiments.get({projectId, contractId: contract.contract.snapshot.id});
  const frozen = f.repository.externalExperiments.getResult({projectId, ...last.latestResult});
  assert.equal(frozen.snapshot.verification, 'external_report_not_independently_verified');
  await writeFile(join(f.root, 'returned.json'), '{changed original}');
  assert.deepEqual(f.repository.externalExperiments.getResult({projectId, ...last.latestResult}), frozen);
  assert.equal(f.repository.externalExperiments.list({projectId, offset: 0, limit: 10}).total, 1);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_experiment_executions').pluck().get(), 0);
  const audit = await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(620, 800));
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme); await path.scrollIntoViewIfNeeded();
    assert.equal((await page.evaluate(`(${audit})({root:'body',viewport:true})`)).cut, 0);
  }
});
