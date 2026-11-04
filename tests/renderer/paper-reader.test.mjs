import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';

let api, directory, app, page, active;
const fixtures = [], calls = [], errors = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr07-reader-selection');
const hash = value => createHash('sha256').update(value).digest('hex');
before(async () => {
  api = await loadResearchTestApi();
  directory = await mkdtemp(join(tmpdir(), 'roc-paper-reader-'));
  await mkdir(artifacts, {recursive: true});
  await build({stdin: {contents: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {PaperReader} from './src/renderer/literature/PaperReader';
    import {WorkspaceScopeProvider} from './src/renderer/app/workspace-scope';
    const root=createRoot(document.getElementById('root'));
    const client={api:{research:{
      resolveDocumentParse:input=>window.readFromHost('resolveDocumentParse',input),
      getModelsStatus:async()=>({ok:true,data:{ready:false,error:null,models:[],downloading:false,selectedPack:'compact'}})
    }}};
    const loadDocumentContent=input=>window.readFromHost('getDocumentContent',input);
    function Harness({initial,initialFocus}) {
      const [snapshot,setSnapshot]=useState(initial),[focus,setFocus]=useState(initialFocus);
      window.updateReader=(snapshot,focus)=>flushSync(()=>{setSnapshot(snapshot);setFocus(focus);});
      const store={client,...snapshot,loadDocumentContent,action:{pending:false,error:null},
        assistant:{pending:false,error:null},parseInFlight:null};
      const scope={client,projectId:snapshot.projectId,workspacePath:'/tmp/synthetic-reader',writable:true,
        workspaceStatus:'ready',workspaceError:null,openFileInCanvas:()=>{}};
      return <WorkspaceScopeProvider value={scope}><PaperReader literature={store}
        onClearFocus={()=>setFocus({parseId:null,locator:null})}
        openInFilesView={()=>{}} focusParseId={focus.parseId} focusLocator={focus.locator}/></WorkspaceScopeProvider>;
    }
    let generation=0;
    window.mountReader=(snapshot,focus)=>flushSync(()=>root.render(<Harness key={++generation} initial={snapshot} initialFocus={focus}/>));
  `,resolveDir: process.cwd(), loader: 'tsx'}, outfile: join(directory, 'app.js'),
    bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent'});
  const assets = join(process.cwd(), 'dist/renderer/assets');
  const styles = await Promise.all((await readdir(assets)).filter(file => file.endsWith('.css')).map(file => readFile(join(assets, file), 'utf8')));
  await writeFile(join(directory, 'app.css'), styles.join('\n'));
  await writeFile(join(directory, 'index.html'), `<html data-theme="light"><link rel="stylesheet" href="app.css"><style>
    html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}
    </style><div id="root"></div><script src="app.js"></script></html>`);
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:850}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('readFromHost', async (method, input) => {
    const f = active;
    calls.push({fixture: f.project.id, method, input});
    api.parseIpcRequestArgs(method === 'getDocumentContent' ? 'roc:research:document-content' : 'roc:research:document-resolve-parse', [input]);
    const result = await f.bridge.invoke(`research.${method}`, [input], 98);
    if (f.mismatchedResult && result.ok && method === 'getDocumentContent') result.data.run.id = 'wrong-returned-parse';
    if (f.defer === method) return new Promise(resolve => {f.finish = () => resolve(result); f.deferReady();});
    return result;
  });
});
after(async () => {
  await app?.close();
  for (const fixture of fixtures) fixture.close();
  api?.dispose();
  if (directory) await rm(directory, {recursive: true, force: true});
});

function scene() {
  const f = createResearchFixture(api, 'reading'); fixtures.push(f);
  const original = 'Explicit synthetic reader source. No scientific claim.';
  f.first = f.repository.documents.import({id: 'first-document', libraryItemId: null, projectId: f.project.id,
    filename: 'first.pdf', mediaType: 'application/pdf', sourcePath: 'documents/first.pdf', sourceHash: hash(original), size: original.length,
    entry: {metadata: {id: 'reader-literature', source: 'local', externalId: 'reader-fixture', doi: null, title: 'Synthetic reader versions',
      authors: ['Synthetic Author'], abstract: null, publishedYear: 2026, citationCount: null, url: null, openAccessUrl: null,
      importedAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z'},
      bibliography: {citationKey: 'reader2026', entryType: 'article', fields: {title: 'Synthetic reader versions'}, preambles: [],
        csl: null, title: 'Synthetic reader versions', authors: ['Synthetic Author'], doi: null, publishedYear: 2026, abstract: null, url: null}}
  }, false).document;
  f.second = f.repository.documents.import({id: 'second-document', libraryItemId: f.first.libraryItemId, projectId: f.project.id,
    filename: 'second.pdf', mediaType: 'application/pdf', sourcePath: 'documents/second.pdf', sourceHash: hash(original + 'second'),
    size: original.length + 6, entry: null}, false).document;
  f.publish = (document, parseId, text, locators = ['page:1']) => {
    const blocks = locators.map((locator, index) => ({id: `${parseId}-block-${index}`, kind: 'paragraph', label: 'Synthetic paragraph',
      text: `${text}${index === 0 ? '' : ' repeated block'}`, locator, imageAssetId: null,
      locations: [{page: 1, bbox: [1, 2, 30, 40], coordinateOrigin: 'TOPLEFT'}]}));
    const data = {outputPath: 'synthetic-reader-output', files: {}, content: {
      contractVersion: 4, engine: 'paddleocr.js', engineVersion: 'synthetic-reader', parserVersion: 'roc-research-parser/2',
      parserFingerprint: hash('synthetic-reader-parser'), modelManifest: '', runtime: {node: 'synthetic'}, tier: 'compact',
      parseMode: 'native-text', device: 'cpu', sourceHash: document.sourceHash, pageCount: 1,
      content: blocks.map(block => block.text).join('\n\n'), blocks, assets: [],
      artifacts: {middleJson: 'artifacts/middle.json', markdown: 'artifacts/document.md', structuredContent: 'artifacts/structured.json'}, warnings: []
    }};
    f.repository.documents.begin(document.id, parseId);
    f.repository.documents.complete(document.id, parseId, data, null);
  };
  f.publish(f.first, 'old-first-parse', 'Old first snapshot.', ['page:1:section1']);
  f.publish(f.first, 'current-first-parse', 'Current first snapshot.', ['page:1:section1.2']);
  f.publish(f.second, 'current-second-parse', 'Current second snapshot.', ['page:1:section1']);
  const service = new api.ResearchDocumentService(f.repository, {}, null);
  const registry = new api.CapabilityRegistry();
  for (const descriptor of api.researchDocumentCapabilities) registry.declare('research', descriptor);
  api.registerResearchDocumentCapabilities({pluginId: 'research', capabilities: registry}, f.repository.documents, service);
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
  f.snapshot = () => ({projectId: f.project.id, selected: f.repository.library.get(f.first.libraryItemId),
    documents: [f.repository.documents.get(f.first.id), f.repository.documents.get(f.second.id)]});
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  return f;
}

async function mount(f, focus = {parseId: null, locator: null}) {
  active = f; calls.length = 0;
  await page.evaluate(({snapshot, focus}) => window.mountReader(snapshot, focus), {snapshot: f.snapshot(), focus});
}
async function textEquals(text) {
  await page.waitForFunction(text => document.querySelector('[data-testid="reader-blocks"]')?.textContent.includes(text), text);
}

test('actual reader requests currentParseId even when repository run order is newest first and old history exists', async () => {
  const f = scene(), before = f.changes();
  assert.deepEqual(f.repository.documents.runs(f.first.id).map(run => run.id), ['current-first-parse', 'old-first-parse']);
  await mount(f); await textEquals('Current first snapshot.');
  assert.equal(await page.locator('[data-testid="reader-blocks"]').innerText().then(text => text.includes('Old first snapshot.')), false);
  assert.deepEqual(calls.filter(call => call.method === 'getDocumentContent').map(call => call.input.parseId), ['current-first-parse']);
  assert.equal(calls[0].input.projectId, f.project.id); assert.equal(calls[0].input.sourceHash, f.first.sourceHash);
  assert.equal(f.changes(), before);
});

test('historical parse resolves its actual document and exact block instead of opening another current parse', async () => {
  const f = scene(), before = f.changes();
  await mount(f, {parseId: 'old-first-parse', locator: 'page:1:section1'});
  await textEquals('Old first snapshot.');
  assert.deepEqual(calls.map(call => call.method), ['resolveDocumentParse', 'getDocumentContent']);
  assert.equal(calls[1].input.parseId, 'old-first-parse'); assert.equal(calls[1].input.documentId, f.first.id);
  assert.equal(await page.locator('[data-block-id="old-first-parse-block-0"]').getAttribute('data-focused'), 'true');
  assert.equal(f.changes(), before);
});

test('missing, foreign and superseded parses produce errors without content requests or near-location fallback', async () => {
  const f = scene();
  await mount(f, {parseId: 'missing-parse', locator: 'page:1'});
  await page.getByTestId('error-blocked').waitFor();
  assert.equal(calls.some(call => call.method === 'getDocumentContent'), false);
  assert.equal(await page.locator('[data-testid="reader-blocks"]').count(), 0);
  const other = f.repository.createProject({title: 'Other reader project', description: '', workspacePath: '/tmp/reader-other'});
  const before = f.changes();
  active = f;
  await page.evaluate(({snapshot, focus}) => window.updateReader(snapshot, focus), {
    snapshot: {...f.snapshot(), projectId: other.id}, focus: {parseId: 'old-first-parse', locator: 'page:1'}
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="error-blocked"]')?.textContent.includes('未关联'));
  assert.equal(await page.locator('[data-testid="reader-blocks"]').count(), 0);
  f.db.prepare("UPDATE research_document_parses SET status='failed',error='research_document_parse_superseded' WHERE id='old-first-parse'").run();
  const after = f.changes();
  await mount(f, {parseId: 'old-first-parse', locator: 'page:1'});
  await page.waitForFunction(() => document.querySelector('[data-testid="error-blocked"]')?.textContent.includes('失效'));
  assert.equal(await page.locator('[data-testid="reader-blocks"]').count(), 0);
  assert.equal(f.changes(), after); assert.ok(after > before);
});

test('locator prefixes and ambiguous exact locations remain unmatched in the selected parse', async () => {
  const f = scene();
  await mount(f, {parseId: 'current-first-parse', locator: 'page:1:section1'});
  await textEquals('Current first snapshot.');
  await page.getByTestId('reader-jump-missed').waitFor();
  assert.equal(await page.locator('[data-focused="true"]').count(), 0);
  f.publish(f.first, 'ambiguous-parse', 'Ambiguous paragraph.', ['page:1', 'page:1']);
  await mount(f, {parseId: 'ambiguous-parse', locator: 'page:1'});
  await textEquals('Ambiguous paragraph.');
  assert.equal(await page.locator('[data-focused="true"]').count(), 0);
  await page.getByTestId('reader-jump-missed').waitFor();
});

test('native document-tab keys clear historical focus and choose the target current version', async () => {
  const f = scene();
  await mount(f, {parseId: 'old-first-parse', locator: 'page:1:section1'});
  await textEquals('Old first snapshot.');
  const first = page.getByTestId('reader-document-tab-first-document');
  await first.focus(); await page.keyboard.press('ArrowRight');
  await textEquals('Current second snapshot.');
  assert.equal(await page.getByTestId('reader-document-tab-second-document').evaluate(element => element === document.activeElement), true);
  assert.equal(calls.at(-1).input.parseId, 'current-second-parse');
  await page.keyboard.press('Home');
  await textEquals('Current first snapshot.');
  assert.equal(calls.at(-1).input.parseId, 'current-first-parse');
});

test('late content response cannot publish old project or document text under the new reader header', {timeout: 10000}, async () => {
  const f = scene(), next = scene();
  next.publish(next.first, 'next-project-parse', 'Next project snapshot.');
  const pending = new Promise(resolve => {f.deferReady = resolve;});
  f.defer = 'getDocumentContent';
  await mount(f);
  await pending;
  active = next;
  await page.evaluate(snapshot => window.updateReader(snapshot, {parseId: null, locator: null}), next.snapshot());
  await textEquals('Next project snapshot.');
  const before = next.changes();
  f.finish();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByTestId('paper-reader').getAttribute('data-library-item'), next.first.libraryItemId);
  assert.equal(await page.getByTestId('reader-blocks').innerText().then(text => text.includes('Current first snapshot.')), false);
  assert.equal(calls.at(-1).input.projectId, next.project.id);
  assert.equal(next.changes(), before);
});

test('wrong returned parse identity is rejected; selected layouts preserve readable content and reduced motion', async () => {
  const f = scene();
  f.mismatchedResult = true;
  await mount(f);
  await page.waitForFunction(() => document.querySelector('[data-testid="error-blocked"]')?.textContent.includes('版本不一致'));
  assert.equal(await page.locator('[data-testid="reader-blocks"]').count(), 0);
  f.mismatchedResult = false;
  await page.getByRole('button', {name: '重试', exact: true}).click();
  await textEquals('Current first snapshot.');
  await page.emulateMedia({reducedMotion: 'reduce'});
  for (const [width, theme] of [[1100, 'light'], [1099, 'dark'], [800, 'light']]) {
    await app.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setSize(width, 850), width);
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const layout = await page.getByTestId('reader-content-area').evaluate(element => ({
      width: element.clientWidth, overflow: element.scrollWidth - element.clientWidth, height: element.clientHeight
    }));
    assert.ok(layout.width > 0 && layout.height > 0); assert.equal(layout.overflow, 0);
    await page.screenshot({path: join(artifacts, `reader-${theme}-${width}.png`)});
  }
  assert.deepEqual(errors, []);
  await writeFile(join(artifacts, 'selection-requests.json'), JSON.stringify({
    transport: 'actual renderer component and generated registry/adapter via Node-host seam; explicit synthetic parse snapshots and window98',
    calls
  }, null, 2));
});
