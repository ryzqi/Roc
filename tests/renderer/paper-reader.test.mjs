import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api, directory, app, page, active;
const fixtures = [], calls = [], errors = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr07-reader-selection');
const hash = value => createHash('sha256').update(value).digest('hex');
before(async () => {
  api = await loadResearchTestApi();
  directory = await mkdtemp(join(tmpdir(), 'roc-paper-reader-'));
  await mkdir(artifacts, {recursive: true});
  await buildViteRenderer({directory,script:`
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {PaperReader} from ${JSON.stringify(join(process.cwd(),'src/renderer/literature/PaperReader'))};
    import {WorkspaceScopeProvider} from ${JSON.stringify(join(process.cwd(),'src/renderer/app/workspace-scope'))};
    import {ArtifactEvidenceSource} from ${JSON.stringify(join(process.cwd(),'src/renderer/artifacts/ArtifactEvidenceSource'))};
    import {ModalShell} from ${JSON.stringify(join(process.cwd(),'src/renderer/shell/ModalShell'))};
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    const root=createRoot(document.getElementById('root'));
    const client={api:{research:{
      resolveDocumentParse:input=>window.readFromHost('resolveDocumentParse',input),
      previewDocument:input=>window.readFromHost('previewDocument',input),
      getDocumentContent:input=>window.readFromHost('getDocumentContent',input),
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
    function SourceHarness({initial}) {
      const [source,setSource]=useState(initial),[open,setOpen]=useState(true);
      window.updateSource=source=>flushSync(()=>setSource(source));
      return <MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
        <ModalShell open={open} kind="drawer" title="固定来源验证" testId="source-inspector"
          widthClassName="w-[560px]" onClose={()=>setOpen(false)}>
          <ArtifactEvidenceSource client={client} source={source} canDecide={false} onChanged={()=>{}}/>
        </ModalShell>
      </LazyMotion></MotionConfig>;
    }
    window.mountSource=source=>flushSync(()=>root.render(<SourceHarness key={++generation} initial={source}/>));
  `,style:`
    html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}
  `,setup:`
      const NativeWorker=window.Worker;window.liveWorkers=0;window.createdWorkers=0;
      window.workerUrls=[];
      window.Worker=class extends NativeWorker{constructor(...args){super(...args);window.liveWorkers++;window.createdWorkers++;window.workerUrls.push(String(args[0]));this.closed=false;}
        terminate(){if(!this.closed){this.closed=true;window.liveWorkers--;}super.terminate();}};
  `});
  await build({entryPoints: ['src/main/pdf-preview-protocol.ts'], outfile: join(directory, 'protocol.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent'});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    const protocol=require(${JSON.stringify(join(directory, 'protocol.cjs'))});protocol.registerPdfPreviewScheme();
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>{
      protocol.registerPdfPreviewProtocol(()=>({invokeCapability:async(name,input)=>{
        if(name!=='research.document.source') throw new Error('unsupported test resource');
        const result=await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.readFromHost(\"source\",'+JSON.stringify(input)+')');
        if(!result.ok) throw new Error(result.message);
        return new Response(new Uint8Array(result.bytes),{headers:result.headers});
      }}),null);
      return new BrowserWindow({show:false,width:1100,height:850}).loadFile(${JSON.stringify(join(directory, 'index.html'))});
    });`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('readFromHost', async (method, input) => {
    const f = active;
    calls.push({fixture: f.project.id, method, input});
    if (method === 'source') {
      try {
        const response = await f.registry.invoke('research.document.source', input);
        return {ok: true, bytes: Array.from(new Uint8Array(await response.arrayBuffer())), headers: Object.fromEntries(response.headers)};
      } catch (error) {return {ok: false, message: error.message};}
    }
    const channel = {getDocumentContent: 'roc:research:document-content', resolveDocumentParse: 'roc:research:document-resolve-parse',
      previewDocument: 'roc:research:document-preview'}[method];
    api.parseIpcRequestArgs(channel, [input]);
    const result = await f.bridge.invoke(`research.${method}`, [input], 98);
    if (f.mismatchedResult && result.ok && method === 'getDocumentContent') result.data.run.id = 'wrong-returned-parse';
    if (f.defer === method) return new Promise(resolve => {f.finish = () => resolve(result); f.deferReady();});
    return result;
  });
});
after(async () => {
  await app?.close();
  for (const fixture of fixtures) fixture.close();
  for (const fixture of fixtures) if (fixture.root) await rm(fixture.root, {recursive: true, force: true});
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
  f.registry = registry;
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
  f.snapshot = () => ({projectId: f.project.id, selected: f.repository.library.get(f.first.libraryItemId),
    documents: [f.repository.documents.get(f.first.id), f.repository.documents.get(f.second.id)]});
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  return f;
}

function generatedPdf({pageCount = 1, crop = [0,0,612,792], rotation = 0, userUnit = 1} = {}) {
  const font = 3 + 2*pageCount;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({length:pageCount},(_,i)=>`${3+2*i} 0 R`).join(' ')}] /Count ${pageCount} >>`];
  for(let i=0;i<pageCount;i++){
    const stream = `BT /F1 12 Tf 40 600 Td (Synthetic group A mean is 2. Original generated page ${i+1}.) Tj 0 -24 Td (Synthetic group B mean is 4. Independent source review.) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [${crop.join(' ')}] /Rotate ${rotation} /UserUnit ${userUnit} /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4+2*i} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let text='%PDF-1.7\n';const offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(text);
  text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

async function realPdfScene({pageOnly = false, pdfOptions = null, pageRange = '1'} = {}) {
  const f = scene();
  f.root = await realpath(await mkdtemp(join(tmpdir(), 'roc-reader-original-')));
  const source = pdfOptions === null ? await readFile('tests/fixtures/research-workflow/source.pdf') : generatedPdf(pdfOptions);
  const path = join(f.root, 'source.pdf'); await writeFile(path, source);
  const {parseResearchDocument} = await importTypeScriptModule('src/main/plugins/research/document-parser.ts', {
    platform: 'node', external: ['@napi-rs/canvas', 'onnxruntime-node', 'paddleocr', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/tmp'
  });
  const {collectDocumentContent} = await importTypeScriptModule('src/main/plugins/research/document-files.ts', {
    platform: 'node', external: ['zod'], tempDir: '.runtime/tmp'
  });
  const raw = await parseResearchDocument({projectRoot: f.root, sourcePath: path, outputDir: join(f.root, 'output'),
    options: {tier: 'compact', device: 'cpu', pageRange}, modelFiles: null, modelManifest: ''});
  const collected = await collectDocumentContent(f.root, join(f.root, 'output'), raw);
  const document = f.repository.documents.import({id: 'actual-original', libraryItemId: f.first.libraryItemId, projectId: f.project.id,
    filename: 'source.pdf', mediaType: 'application/pdf', sourcePath: 'source.pdf', sourceHash: hash(source), size: source.length, entry: null}, false).document;
  f.repository.documents.begin(document.id, 'actual-original-parse');
  f.repository.documents.complete(document.id, 'actual-original-parse', collected.data, pageOnly ? null : collected.coordinates);
  f.actual = document; f.collected = collected;
  const registry = new api.CapabilityRegistry();
  for (const descriptor of api.researchDocumentCapabilities) registry.declare('research', descriptor);
  api.registerResearchDocumentCapabilities({pluginId: 'research', capabilities: registry}, f.repository.documents,
    new api.ResearchDocumentService(f.repository, {}, f.root));
  f.registry = registry;
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name,input) => registry.invoke(name,input)});
  f.snapshot = () => ({projectId: f.project.id, selected: f.repository.library.get(document.libraryItemId),
    documents: [f.repository.documents.get(document.id)]});
  return f;
}

/** Explicit synthetic block layout; original bytes and measured PDF viewports are real. */
async function publishReverseLayout(f, {crossPage = false, pageOnly = false} = {}) {
  const data=structuredClone(f.collected.data), frame=f.collected.coordinates.pages[0].frame;
  const template=data.content.blocks[0], w=frame.width, h=frame.height;
  const location=bbox=>({page:1,bbox,coordinateOrigin:'TOPLEFT'});
  const upperLeft=location([0,0,w/2,h/2]), upperRight=location([w/2,0,w,h/2]);
  const make=(id,label,locations)=>({...template,id,label,text:`Explicit synthetic ${label} region.`,locator:`synthetic:${id}`,locations});
  const leftLocations=[upperLeft];
  if(crossPage) {
    const second=f.collected.coordinates.pages.find(page=>page.page===2).frame;
    leftLocations.push({page:2,bbox:[0,0,second.width,second.height],coordinateOrigin:'TOPLEFT'});
  }
  data.content.blocks=[make('reverse-left','Left',leftLocations),make('reverse-right','Right',[upperRight]),
    make('reverse-overlap','Overlap',[upperLeft])];
  data.content.content=data.content.blocks.map(block=>block.text).join('\n\n');
  data.content.parserVersion='synthetic-reverse-layout/v1';
  data.content.parserFingerprint=hash('synthetic-reverse-layout/v1');
  data.content.artifacts.structuredContent='artifacts/synthetic-reverse.json';
  const artifact=Buffer.from(JSON.stringify({seam:'explicit synthetic blocks on actual measured original',
    blocks:data.content.blocks,coordinateFrames:f.collected.coordinates.pages}));
  await writeFile(join(f.root,data.outputPath,data.content.artifacts.structuredContent),artifact);
  const coordinates={...f.collected.coordinates,parseHash:hash(JSON.stringify(data.content)),
    artifact:{path:data.content.artifacts.structuredContent,sha256:hash(artifact),size:artifact.length}};
  f.repository.documents.begin(f.actual.id,'synthetic-reverse-parse');
  f.repository.documents.complete(f.actual.id,'synthetic-reverse-parse',data,pageOnly ? null : coordinates);
  f.reverse={data,coordinates};
}

async function mount(f, focus = {parseId: null, locator: null}) {
  active = f; calls.length = 0;
  await page.evaluate(({snapshot, focus}) => window.mountReader(snapshot, focus), {snapshot: f.snapshot(), focus});
}
function captureOriginalSource(f) {
  const evidence=f.repository.evidence.capture({projectId:f.project.id,chunkId:'document:actual-original-parse:chunk:0'});
  return f.repository.evidence.inspectEvidence(evidence.id,f.project.id);
}
async function mountSource(f, source) {
  active=f;calls.length=0;
  await page.evaluate(source=>window.mountSource(source),source);
  const summary=page.locator('summary').first();
  await summary.focus();await page.keyboard.press('Enter');
  const open=page.getByTestId(`artifact-document-source-toggle-${source.evidence.id}`);
  await open.waitFor();await open.focus();await page.keyboard.press('Enter');
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

async function waitForOriginal() {
  await page.waitForFunction(() => {
    const canvas=document.querySelector('[data-testid="reader-pdf-canvas"]');
    return canvas !== null && canvas.width > 0 && canvas.height > 0 && canvas.parentElement.style.visibility === 'visible' &&
      getComputedStyle(canvas).visibility === 'visible';
  });
}
test('actual PDF comparison opens sealed bytes lazily with one native worker and measured region projection', async () => {
  const f = await realPdfScene(), before = f.changes();
  await mount(f); await textEquals('Synthetic group A mean is 2');
  assert.equal(await page.evaluate(() => window.liveWorkers), 0);
  assert.equal(calls.some(call => call.method === 'previewDocument'), false);
  await page.getByTestId('reader-block-source').first().click();
  await waitForOriginal();
  assert.equal(await page.evaluate(() => window.liveWorkers), 1);
  const workerUrls=await page.evaluate(()=>window.workerUrls);
  assert.match(workerUrls.at(-1),/\/assets\/pdf\.worker\.min-[^/]+\.js$/u);
  await page.getByTestId('reader-pdf-region').waitFor();
  assert.deepEqual(calls.filter(call => call.method === 'previewDocument').map(call => call.input.parseId), ['actual-original-parse']);
  assert.equal(calls.find(call => call.method === 'previewDocument').input.parseHash, hash(JSON.stringify(f.collected.data.content)));
  assert.equal(calls.find(call => call.method === 'source').input.sourceHash, f.actual.sourceHash);
  const bitmap = await page.getByTestId('reader-pdf-canvas').evaluate(canvas => {
    const context = canvas.getContext('2d'), image = context.getImageData(0,0,canvas.width,canvas.height);
    let ink=0; for(let i=0;i<image.data.length;i+=4) if(image.data[i]<200 && image.data[i+3]>0) ink++;
    return {width: canvas.width, height: canvas.height, ink};
  });
  assert.ok(bitmap.ink > 100, 'actual PDF worker paints source text, not an empty canvas');
  assert.ok(bitmap.width * bitmap.height <= 4_000_000);
  const normalWidth=await page.getByTestId('reader-pdf-canvas').evaluate(canvas=>canvas.getBoundingClientRect().width);
  await page.getByRole('button',{name:'放大 PDF',exact:true}).click();
  await page.getByRole('button',{name:'放大 PDF',exact:true}).click();await waitForOriginal();
  const enlarged=await page.getByTestId('reader-pdf-canvas').evaluate(canvas=>({width:canvas.getBoundingClientRect().width,pixels:canvas.width*canvas.height}));
  assert.ok(Math.abs(enlarged.width/normalWidth-1.5)<0.01);assert.ok(enlarged.pixels<=4_000_000);
  assert.equal(await page.evaluate(()=>window.liveWorkers),1);
  await page.getByRole('button',{name:'PDF 适宽',exact:true}).click();await waitForOriginal();
  assert.equal(f.changes(), before);
  await page.getByTestId('reader-compare-pdf').click();
  await page.waitForFunction(() => window.liveWorkers === 0);
  assert.equal(await page.getByTestId('reader-pdf-canvas').count(), 0);
  await writeFile(join(artifacts,'actual-pdf-bitmap.json'),JSON.stringify({
    bitmap, workerUrls, sourceHash:f.actual.sourceHash, coordinateSnapshot:f.collected.coordinates,
    transport:'actual component/PDF.js worker/Chromium protocol with Node-host registry bridge; synthetic sender98', calls
  },null,2));
});

test('uncaptured coordinate history provides page-only positioning; invalid page input and source corruption remain errors', async () => {
  const f = await realPdfScene({pageOnly:true});
  await mount(f); await textEquals('Synthetic group A mean is 2');
  await page.getByTestId('reader-block-source').first().click(); await waitForOriginal();
  await page.getByTestId('reader-pdf-page-only').waitFor();
  assert.equal(await page.getByTestId('reader-pdf-region').count(),0);
  await page.getByRole('spinbutton',{name:'PDF 页码'}).fill('99');
  await page.getByRole('button',{name:'前往',exact:true}).click();
  assert.equal(await page.getByRole('spinbutton',{name:'PDF 页码'}).evaluate(input=>input.validity.rangeOverflow),true);
  assert.ok(await page.getByRole('spinbutton',{name:'PDF 页码'}).evaluate(input=>input.validationMessage.length>0));
  assert.equal(await page.getByTestId('reader-pdf-canvas').getAttribute('aria-label'),'原 PDF 第 1 页');
  await page.getByTestId('reader-compare-pdf').click();
  await page.waitForFunction(() => window.liveWorkers===0);
  await writeFile(join(f.root,'source.pdf'),'Task-owned changed original.');
  const before=f.changes();
  await page.getByTestId('reader-compare-pdf').click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="reader-pdf"] [data-testid="error-blocked"]')?.textContent.includes('版本不一致'));
  assert.equal(await page.evaluate(()=>window.liveWorkers),0);
  assert.equal(await page.getByTestId('reader-pdf-canvas').isVisible(),false);
  assert.equal(f.changes(),before);
});

test('comparison remains readable at shell width boundaries and unload cancels pending preview before worker allocation', {timeout:10000}, async()=>{
  const f=await realPdfScene();
  const auditSource=await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8');
  const audits=[];
  const audit=async state=>{
    const result=await page.evaluate(source=>(0,eval)(source)({root:'#root',viewport:true}),auditSource);
    audits.push({state,...result});assert.equal(result.cut,0);
  };
  await mount(f);await textEquals('Synthetic group A mean is 2');
  await page.getByTestId('reader-compare-pdf').click();await waitForOriginal();
  for(const [width,theme] of [[1100,'light'],[1099,'dark'],[800,'light']]){
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,850),width);
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await waitForOriginal();
    const layout=await page.getByTestId('paper-reader').evaluate(element=>({overflow:element.scrollWidth-element.clientWidth,
      canvas:element.querySelector('canvas').width*element.querySelector('canvas').height,
      canvases:element.querySelectorAll('canvas').length}));
    assert.equal(layout.overflow,0);assert.ok(layout.canvas<=4_000_000);assert.equal(layout.canvases,1);
    await audit(`expanded-${theme}-${width}`);
    await page.getByRole('button',{name:'放大 PDF',exact:true}).hover();
    await audit(`hover-${theme}-${width}`);
    await page.screenshot({path:join(artifacts,`comparison-${theme}-${width}.png`)});
  }
  await page.getByRole('button',{name:'放大 PDF',exact:true}).click();await waitForOriginal();
  await audit('zoom-final');
  await writeFile(join(artifacts,'comparison-clip-audit.json'),JSON.stringify(audits,null,2));
  await page.getByTestId('reader-compare-pdf').click();await page.waitForFunction(()=>window.liveWorkers===0);
  const ready=new Promise(resolve=>{f.deferReady=resolve;});f.defer='previewDocument';
  await page.getByTestId('reader-compare-pdf').click();await ready;
  await page.getByTestId('reader-compare-pdf').click();
  f.finish();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(()=>window.liveWorkers),0);
  assert.equal(await page.getByTestId('reader-pdf').count(),0);
  assert.deepEqual(errors,[]);
});

test('actual crop rotation and UserUnit project the retained full-page region onto the rendered original',async()=>{
  const f=await realPdfScene({pdfOptions:{crop:[20,30,500,700],rotation:90,userUnit:2}});
  await mount(f);await textEquals('Synthetic group A mean is 2');
  await page.getByTestId('reader-block-source').first().click();await waitForOriginal();
  await page.getByTestId('reader-pdf-region').waitFor();
  const frame=f.collected.coordinates.pages[0].frame;
  assert.deepEqual(frame.viewport.viewBox,[20,30,500,700]);assert.equal(frame.viewport.rotation,90);assert.equal(frame.viewport.userUnit,2);
  const geometry=await page.evaluate(()=>{
    const canvas=document.querySelector('[data-testid="reader-pdf-canvas"]').getBoundingClientRect();
    const region=document.querySelector('[data-testid="reader-pdf-region"]').getBoundingClientRect();
    return {left:region.left-canvas.left,top:region.top-canvas.top,width:region.width,height:region.height,
      canvasWidth:canvas.width,canvasHeight:canvas.height};
  });
  assert.ok(Math.abs(geometry.left)<1 && Math.abs(geometry.top)<1);
  assert.ok(Math.abs(geometry.width-geometry.canvasWidth)<1 && Math.abs(geometry.height-geometry.canvasHeight)<1);
  assert.ok(Math.abs(geometry.canvasWidth/geometry.canvasHeight-670/480)<0.001);
  await writeFile(join(artifacts,'rotated-original-projection.json'),JSON.stringify({frame,geometry},null,2));
  await page.getByTestId('reader-compare-pdf').click();await page.waitForFunction(()=>window.liveWorkers===0);
});

test('32-page original retains one visible bitmap across real page navigation and releases worker and canvases on close',async()=>{
  const f=await realPdfScene({pdfOptions:{pageCount:32}});
  await mount(f);await textEquals('Synthetic group A mean is 2');
  await page.getByTestId('reader-compare-pdf').click();await waitForOriginal();
  await page.evaluate(()=>{
    window.visibleUnpaintedPdf=[];
    window.pdfPaintObserver=new MutationObserver(()=>{
      const canvas=document.querySelector('[data-testid="reader-pdf-canvas"]');
      if(canvas !== null && canvas.parentElement.style.visibility==='visible' && canvas.width===300 && canvas.height===150) {
        window.visibleUnpaintedPdf.push({page:canvas.getAttribute('aria-label'),width:canvas.width,height:canvas.height});
      }
    });
    window.pdfPaintObserver.observe(document.querySelector('[data-testid="reader-pdf"]'),{childList:true,subtree:true,attributes:true});
  });
  const initial=await app.evaluate(({app})=>app.getAppMetrics().map(({type,memory})=>({type,memory})));
  const samples=[];
  for(const pageNumber of [2,8,16,24,32,1]){
    const start=Date.now();
    await page.getByRole('spinbutton',{name:'PDF 页码'}).fill(String(pageNumber));
    await page.getByRole('button',{name:'前往',exact:true}).click();await waitForOriginal();
    await page.waitForFunction(pageNumber=>document.querySelector('[data-testid="reader-pdf-canvas"]')?.getAttribute('aria-label')===`原 PDF 第 ${pageNumber} 页`,pageNumber);
    const snapshot=await page.waitForFunction(pageNumber=>{
      const canvas=document.querySelector('[data-testid="reader-pdf-canvas"]');
      if(canvas?.getAttribute('aria-label')!==`原 PDF 第 ${pageNumber} 页` || canvas.width === 0 || canvas.height === 0 ||
        canvas.parentElement.style.visibility!=='visible' || getComputedStyle(canvas).visibility!=='visible') return false;
      return {pixels:canvas.width*canvas.height,canvases:document.querySelectorAll('canvas').length,workers:window.liveWorkers};
    },pageNumber);
    const sample=await snapshot.jsonValue();await snapshot.dispose();
    assert.ok(sample.pixels>0 && sample.pixels<=4_000_000);assert.equal(sample.canvases,1);assert.equal(sample.workers,1);
    samples.push({page:pageNumber,elapsedMs:Date.now()-start,...sample});
  }
  const steady=await app.evaluate(({app})=>app.getAppMetrics().map(({type,memory})=>({type,memory})));
  const unpainted=await page.evaluate(()=>{window.pdfPaintObserver.disconnect();return window.visibleUnpaintedPdf;});
  await writeFile(join(artifacts,'visible-unpainted-pdf.json'),JSON.stringify(unpainted,null,2));
  assert.deepEqual(unpainted,[],'an earlier paint cannot make a new default canvas visible');
  await page.getByTestId('reader-compare-pdf').click();await page.waitForFunction(()=>window.liveWorkers===0);
  assert.equal(await page.locator('canvas').count(),0);
  const closed=await app.evaluate(({app})=>app.getAppMetrics().map(({type,memory})=>({type,memory})));
  await writeFile(join(artifacts,'large-original-resources.json'),JSON.stringify({pageCount:32,
    sourceHash:f.actual.sourceHash,parsedPages:f.collected.coordinates.pages.map(page=>page.page),
    initial,steady,closed,samples,limits:'one DOM canvas, <=4M pixels per page, explicit worker teardown; no claim of process RSS hard cap'},null,2));
});

test('actual rotated PDF hit chooses a unique block while overlap and absent regions require explicit selection',async()=>{
  const f=await realPdfScene({pdfOptions:{crop:[20,30,500,700],rotation:90,userUnit:2}});
  const auditSource=await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8'), audits=[];
  const audit=async state=>{
    const result=await page.evaluate(source=>(0,eval)(source)({root:'#root',viewport:true}),auditSource);
    audits.push({state,...result});assert.equal(result.cut,0);
  };
  await publishReverseLayout(f);const before=f.changes();
  await mount(f);await textEquals('Explicit synthetic Left');
  await page.getByTestId('reader-compare-pdf').click();await waitForOriginal();
  const canvas=page.getByTestId('reader-pdf-canvas');
  const clickAt=async(x,y)=>{
    const size=await canvas.evaluate(canvas=>({width:canvas.getBoundingClientRect().width,height:canvas.getBoundingClientRect().height}));
    await canvas.click({position:{x:size.width*x,y:size.height*y}});
  };
  await clickAt(.75,.25);
  await page.waitForFunction(()=>document.activeElement?.getAttribute('data-block-id')==='reverse-right' &&
    document.activeElement.dataset.focused==='true');
  await waitForOriginal();await clickAt(.25,.25);
  assert.equal(await page.getByTestId('reader-pdf-block-candidate').count(),2);
  assert.equal(await page.locator('[data-block-id="reverse-left"]').getAttribute('data-focused'),null);
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await waitForOriginal();
    await audit(`overlap-${theme}`);
    await page.getByTestId('reader-pdf-block-candidate').first().hover();await audit(`hover-${theme}`);
    await page.screenshot({path:join(artifacts,`reverse-overlap-${theme}.png`)});
  }
  const target=page.getByRole('button',{name:'定位到Overlap synthetic:reverse-overlap 位置1',exact:true});
  await target.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.activeElement?.getAttribute('data-block-id')==='reverse-overlap' &&
    document.activeElement.dataset.focused==='true');
  assert.equal(await page.getByTestId('reader-pdf-block-candidates').count(),0);
  await audit('keyboard-destination-focus');
  await writeFile(join(artifacts,'reverse-clip-audit.json'),JSON.stringify(audits,null,2));
  await waitForOriginal();await clickAt(.75,.75);
  await page.getByTestId('reader-pdf-block-candidates').waitFor();
  assert.equal(await page.getByTestId('reader-pdf-block-candidate').count(),0);
  assert.match(await page.getByTestId('reader-pdf-block-candidates').innerText(),/没有已记录/);
  assert.equal(await page.locator('[data-block-id="reverse-overlap"]').getAttribute('data-focused'),'true');
  assert.equal(f.changes(),before);
  await page.getByTestId('reader-compare-pdf').click();await page.waitForFunction(()=>window.liveWorkers===0);
});

test('keyboard PDF page-block selection retains the exact cross-page location and group focus',async()=>{
  const f=await realPdfScene({pdfOptions:{pageCount:2},pageRange:'1-2'});
  await publishReverseLayout(f,{crossPage:true});const before=f.changes();
  await mount(f);await textEquals('Explicit synthetic Left');
  await page.locator('[data-block-id="reverse-left"] [data-testid="reader-block-source"]').click();await waitForOriginal();
  await page.getByRole('combobox',{name:'解析块位置'}).selectOption('1');await waitForOriginal();
  assert.equal(await page.getByRole('spinbutton',{name:'PDF 页码'}).inputValue(),'2');
  const open=page.getByTestId('reader-pdf-page-blocks');
  await open.focus();await page.keyboard.press('Enter');
  assert.equal(await page.getByTestId('reader-pdf-block-candidate').count(),1);
  const target=page.getByRole('button',{name:'定位到Left synthetic:reverse-left 位置2',exact:true});
  await target.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.activeElement?.getAttribute('data-block-id')==='reverse-left' &&
    document.activeElement.dataset.focused==='true');
  await waitForOriginal();
  assert.equal(await page.getByRole('spinbutton',{name:'PDF 页码'}).inputValue(),'2');
  assert.equal(await page.getByRole('combobox',{name:'解析块位置'}).inputValue(),'1');
  assert.equal(f.changes(),before);
  await page.getByTestId('reader-compare-pdf').click();await page.waitForFunction(()=>window.liveWorkers===0);
});

test('PDF without measured regions offers page-block choices and never infers a spatial match',async()=>{
  const f=await realPdfScene();
  await publishReverseLayout(f,{pageOnly:true});const before=f.changes();
  await mount(f);await textEquals('Explicit synthetic Left');
  await page.getByTestId('reader-compare-pdf').click();await waitForOriginal();
  await page.getByTestId('reader-pdf-canvas').click({position:{x:10,y:10}});
  assert.equal(await page.locator('[data-focused="true"]').count(),0);
  assert.equal(await page.getByTestId('reader-pdf-block-candidate').count(),3);
  assert.match(await page.getByTestId('reader-pdf-block-candidates').innerText(),/仅有页定位/);
  await page.getByRole('button',{name:'定位到Right synthetic:reverse-right 位置1',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.getAttribute('data-block-id')==='reverse-right');
  await waitForOriginal();await page.getByTestId('reader-pdf-page-only').waitFor();
  assert.equal(await page.getByTestId('reader-pdf-region').count(),0);
  assert.equal(f.changes(),before);
  await page.getByTestId('reader-compare-pdf').click();await page.waitForFunction(()=>window.liveWorkers===0);
  assert.deepEqual(errors,[]);
});

test('captured Evidence opens its original parse and source even after a new parse supersedes its reference',async()=>{
  const f=await realPdfScene(), original=captureOriginalSource(f);
  await publishReverseLayout(f);
  const source=f.repository.evidence.inspectEvidence(original.evidence.id,f.project.id), before=f.changes();
  assert.equal(source.referenceStatus,'superseded');
  assert.equal(source.sourceLocator.parseId,'actual-original-parse');
  await mountSource(f,source);await waitForOriginal();
  await page.waitForFunction(()=>{
    const panel=document.querySelector('[data-testid="source-inspector-panel"]');
    return panel && getComputedStyle(panel).opacity==='1' && getComputedStyle(panel).transform==='none';
  });
  assert.equal(await page.getByTestId('artifact-document-source-block').innerText().then(text=>text.includes('Explicit synthetic Left')),false);
  assert.match(await page.getByTestId('artifact-document-source-block').innerText(),/Synthetic group A mean is 2/);
  for(const call of calls.filter(call=>call.method==='getDocumentContent'||call.method==='previewDocument')) {
    assert.equal(call.input.parseId,source.sourceLocator.parseId);assert.equal(call.input.sourceHash,source.sourceLocator.sourceHash);
    assert.equal(call.input.parseHash,source.sourceLocator.parseHash);assert.equal(call.input.projectId,f.project.id);
  }
  assert.ok(calls.some(call=>call.method==='source'));
  const auditSource=await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8'),audits=[];
  for(const [width,theme] of [[1100,'light'],[1099,'dark'],[800,'light']]) {
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,850),width);
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await waitForOriginal();
    await page.getByTestId('reader-pdf-page-blocks').hover();
    const audit=await page.evaluate(source=>(0,eval)(source)({root:'body',viewport:true}),auditSource);
    assert.equal(audit.cut,0);audits.push({width,theme,...audit});
    const layout=await page.getByTestId('source-inspector-panel').evaluate(panel=>({overflow:panel.scrollWidth-panel.clientWidth,
      bounds:panel.getBoundingClientRect().toJSON()}));
    assert.equal(layout.overflow,0);
    await page.screenshot({path:join(artifacts,`evidence-original-${theme}-${width}.png`)});
  }
  await page.getByTestId('reader-pdf-page-blocks').click();
  const target=page.getByTestId('reader-pdf-block-candidate').first();await target.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.activeElement?.getAttribute('data-testid')==='artifact-document-source-block');
  await writeFile(join(artifacts,'evidence-original-clip-audit.json'),JSON.stringify(audits,null,2));
  assert.equal(f.changes(),before);
  await page.getByTestId(`artifact-document-source-toggle-${source.evidence.id}`).click();
  await page.waitForFunction(()=>window.liveWorkers===0);
  assert.equal(await page.getByTestId('artifact-document-source').count(),0);
  await writeFile(join(artifacts,'evidence-fixed-original.json'),JSON.stringify({source,calls,
    seam:'actual captured Evidence, superseding parse and generated readonly bridge/PDF protocol; synthetic Node-host window98'},null,2));
});

test('fixed-source reader rejects foreign project, parse hash, parser, block text and captured region mismatches',async()=>{
  const f=await realPdfScene(), source=captureOriginalSource(f), before=f.changes();
  const foreign=f.repository.createProject({title:'Unlinked source project',description:'',workspacePath:'/tmp/source-unlinked'});
  const variants=[
    value=>{value.evidence.projectId=foreign.id;},
    value=>{value.sourceLocator.documentId='missing-captured-document';},
    value=>{value.sourceLocator.sourceHash='b'.repeat(64);},
    value=>{value.sourceLocator.parseHash='b'.repeat(64);},
    value=>{value.sourceLocator.parserFingerprint='b'.repeat(64);},
    value=>{value.sourceLocator.blockId='missing-captured-block';},
    value=>{value.evidence.excerpt+=' Changed text';},
    value=>{value.sourceLocator.locations[0].bbox[0]+=1;}
  ];
  for(const mutate of variants) {
    const value=structuredClone(source);mutate(value);
    await mountSource(f,value);
    await page.getByTestId('error-blocked').waitFor();
    assert.equal(await page.getByTestId('artifact-document-source-block').count(),0);
    assert.equal(await page.getByTestId('reader-pdf').count(),0);
    assert.equal(await page.evaluate(()=>window.liveWorkers),0);
    assert.equal(calls.some(call=>call.method==='previewDocument'||call.method==='source'),false);
  }
  // The added independent project is the only write in this scenario.
  const afterProject=f.changes();
  await mountSource(f,source);await waitForOriginal();
  assert.equal(f.changes(),afterProject);
  assert.ok(afterProject>before);
  await page.getByTestId(`artifact-document-source-toggle-${source.evidence.id}`).click();await page.waitForFunction(()=>window.liveWorkers===0);
});

test('late fixed-source reads cannot publish the previous project under a new Evidence selection',async()=>{
  const f=await realPdfScene(), next=await realPdfScene({pdfOptions:{pageCount:2}});
  const oldSource=captureOriginalSource(f), nextSource=captureOriginalSource(next);
  const ready=new Promise(resolve=>{f.deferReady=resolve;});f.defer='getDocumentContent';
  await mountSource(f,oldSource);await ready;
  active=next;
  await page.evaluate(source=>window.updateSource(source),nextSource);
  await waitForOriginal();
  const before=next.changes();f.finish();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.notEqual(oldSource.sourceLocator.parseHash,nextSource.sourceLocator.parseHash);
  assert.equal(await page.getByTestId('artifact-document-source').innerText().then(text=>text.includes(oldSource.sourceLocator.parseHash)),false);
  assert.match(await page.getByTestId('artifact-document-source-block').innerText(),/Original generated page 1/);
  const previewCalls=calls.filter(call=>call.method==='previewDocument');
  assert.equal(previewCalls.length,1);assert.equal(previewCalls[0].input.projectId,next.project.id);
  assert.equal(await page.evaluate(()=>window.liveWorkers),1);assert.equal(next.changes(),before);
  await page.getByTestId(`artifact-document-source-toggle-${nextSource.evidence.id}`).click();await page.waitForFunction(()=>window.liveWorkers===0);
  assert.deepEqual(errors,[]);
});

test('captured cross-page source preserves its selected location through original PDF context navigation',async()=>{
  const f=await realPdfScene({pdfOptions:{pageCount:2},pageRange:'1-2'});
  await publishReverseLayout(f,{crossPage:true});
  const evidence=f.repository.evidence.capture({projectId:f.project.id,chunkId:'document:synthetic-reverse-parse:chunk:0'});
  const source=f.repository.evidence.inspectEvidence(evidence.id,f.project.id),before=f.changes();
  assert.equal(source.sourceLocator.locations.length,2);
  await mountSource(f,source);await waitForOriginal();
  await page.getByRole('combobox',{name:'证据原文位置',exact:true}).selectOption('1');await waitForOriginal();
  assert.equal(await page.getByRole('spinbutton',{name:'PDF 页码'}).inputValue(),'2');
  await page.getByTestId('reader-pdf-page-blocks').click();
  const target=page.getByRole('button',{name:'定位到Left synthetic:reverse-left 位置2',exact:true});
  await target.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.activeElement?.getAttribute('data-testid')==='artifact-document-source-block');
  await waitForOriginal();
  assert.equal(await page.getByRole('spinbutton',{name:'PDF 页码'}).inputValue(),'2');
  assert.equal(await page.getByRole('combobox',{name:'证据原文位置',exact:true}).inputValue(),'1');
  assert.equal(f.changes(),before);
  await page.getByTestId(`artifact-document-source-toggle-${evidence.id}`).click();await page.waitForFunction(()=>window.liveWorkers===0);
});
