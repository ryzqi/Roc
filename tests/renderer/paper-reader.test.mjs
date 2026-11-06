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
import {createCanvas, loadImage} from '@napi-rs/canvas';
import {createPerformancePdf, performancePdfPageCount} from '../../scripts/lib/research-pdf-performance-fixture.mjs';

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
    import {ArtifactRelations} from ${JSON.stringify(join(process.cwd(),'src/renderer/artifacts/ArtifactRelations'))};
    import {ModalShell} from ${JSON.stringify(join(process.cwd(),'src/renderer/shell/ModalShell'))};
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    const root=createRoot(document.getElementById('root'));
    const client={api:{research:{
      resolveDocumentParse:input=>window.readFromHost('resolveDocumentParse',input),
      previewDocument:input=>window.readFromHost('previewDocument',input),
      createDocumentAnnotation:input=>window.readFromHost('createDocumentAnnotation',input),
      captureDocumentAnnotation:input=>window.readFromHost('captureDocumentAnnotation',input),
      listDocumentAnnotations:input=>window.readFromHost('listDocumentAnnotations',input),
      getDocumentAnnotation:input=>window.readFromHost('getDocumentAnnotation',input),
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
    function SourceHarness({initial,relationSnapshot=null}) {
      const [source,setSource]=useState(initial),[open,setOpen]=useState(true);
      window.updateSource=source=>flushSync(()=>setSource(source));
      return <MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
        <ModalShell open={open} kind="drawer" title="固定来源验证" testId="source-inspector"
          widthClassName="w-[560px]" onClose={()=>setOpen(false)}>
          {relationSnapshot===null ? <ArtifactEvidenceSource client={client} source={source} canDecide={false} onChanged={()=>{}}/> :
            <ArtifactRelations client={client} snapshot={relationSnapshot} current={true} onChanged={()=>{}}/>}
        </ModalShell>
      </LazyMotion></MotionConfig>;
    }
    window.mountSource=source=>flushSync(()=>root.render(<SourceHarness key={++generation} initial={source}/>));
    window.mountRelationSource=snapshot=>flushSync(()=>root.render(<SourceHarness key={++generation} initial={null} relationSnapshot={snapshot}/>));
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
        const method=name==='research.document.source'?'source':name==='research.document.asset'?'asset':null;
        if(method===null) throw new Error('unsupported test resource');
        const result=await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.readFromHost('+JSON.stringify(method)+','+JSON.stringify(input)+')');
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
    if (method === 'source' || method === 'asset') {
      try {
        const response = await f.registry.invoke(`research.document.${method}`, input);
        return {ok: true, bytes: Array.from(new Uint8Array(await response.arrayBuffer())), headers: Object.fromEntries(response.headers)};
      } catch (error) {return {ok: false, message: error.message};}
    }
    const channel = {getDocumentContent: 'roc:research:document-content', resolveDocumentParse: 'roc:research:document-resolve-parse',
      previewDocument: 'roc:research:document-preview', createDocumentAnnotation: 'roc:research:annotations-create',
      captureDocumentAnnotation: 'roc:research:annotations-capture', listDocumentAnnotations: 'roc:research:annotations-list',
      getDocumentAnnotation: 'roc:research:annotations-get'}[method];
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

async function realPdfScene({pageOnly = false, pdfOptions = null, pageRange = '1', sourceBytes = null} = {}) {
  const f = scene();
  f.root = await realpath(await mkdtemp(join(tmpdir(), 'roc-reader-original-')));
  const source = sourceBytes ?? (pdfOptions === null ? await readFile('tests/fixtures/research-workflow/source.pdf') : generatedPdf(pdfOptions));
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

test('fixed 400-page original measures first paint, page navigation and single-bitmap cleanup', async () => {
  const bytes = createPerformancePdf();
  const f = await realPdfScene({sourceBytes: bytes, pageRange: ''});
  assert.equal(f.collected.data.content.pageCount, performancePdfPageCount);
  const samples = [];
  for (let sample = 0; sample < 3; sample++) {
    await mount(f);
    await textEquals('Page1');
    await page.evaluate(() => {
      window.firstPdfPaintMs = null;
      const started = performance.now();
      window.firstPdfPaintObserver = new MutationObserver(() => {
        const canvas = document.querySelector('[data-testid="reader-pdf-canvas"]');
        if (canvas?.parentElement.style.visibility === 'visible' && canvas.width > 0 && canvas.height > 0) {
          window.firstPdfPaintMs = performance.now() - started;
          window.firstPdfPaintObserver.disconnect();
        }
      });
      window.firstPdfPaintObserver.observe(document.querySelector('[data-testid="paper-reader"]'),
        {childList: true, subtree: true, attributes: true});
    });
    await page.getByTestId('reader-compare-pdf').focus();
    await page.keyboard.press('Enter');
    await waitForOriginal();
    const firstPaintMs = await page.evaluate(() => window.firstPdfPaintMs);
    assert.ok(firstPaintMs > 0);
    const navigation = [];
    for (const pageNumber of [201, 400, 1]) {
      const started = performance.now();
      await page.getByRole('spinbutton', {name: 'PDF 页码'}).fill(String(pageNumber));
      await page.getByRole('button', {name: '前往', exact: true}).click();
      await waitForOriginal();
      await page.waitForFunction(pageNumber =>
        document.querySelector('[data-testid="reader-pdf-canvas"]')?.getAttribute('aria-label') === `原 PDF 第 ${pageNumber} 页`,
      pageNumber);
      const bitmap = await page.getByTestId('reader-pdf-canvas').evaluate(canvas => {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let ink = 0;
        for (let index = 0; index < data.length; index += 4) if (data[index] < 200 && data[index + 3] > 0) ink++;
        return {pixels: canvas.width * canvas.height, ink};
      });
      assert.ok(bitmap.ink > 100);
      assert.ok(bitmap.pixels <= 4_000_000);
      assert.equal(await page.locator('canvas').count(), 1);
      assert.equal(await page.evaluate(() => window.liveWorkers), 1);
      navigation.push({page: pageNumber, elapsedMs: performance.now() - started, ...bitmap});
    }
    const memory = await app.evaluate(({app}) => app.getAppMetrics().map(({type, memory}) => ({type, memory})));
    await page.getByTestId('reader-compare-pdf').click();
    await page.waitForFunction(() => window.liveWorkers === 0);
    assert.equal(await page.locator('canvas').count(), 0);
    samples.push({firstPaintMs, navigation, memory});
  }
  await writeFile(join(artifacts, 'long-pdf-performance.json'), JSON.stringify({
    sourceSha256: hash(bytes), inputBytes: bytes.length, pages: performancePdfPageCount, samples,
    meaning: 'Browser first visible paint includes explicit keyboard activation, sealed preview/protocol and PDF worker. Navigation includes test-driver wait. Three repeated process samples, OS cache uncontrolled.',
    transport: 'Actual PaperReader/PaperPdfView, production parser and preview registry, Electron Chromium and native PDF worker'
  }, null, 2));
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

test('Claim relation opens its retained original source after reparse without changing scientific state or disclosure geometry',async()=>{
  const f=await realPdfScene(), source=captureOriginalSource(f);
  const artifact=f.repository.createArtifact({projectId:f.project.id,stage:'reading',kind:'reading_notes',title:'Synthetic source-linked claim',path:null});
  const claim=f.repository.evidence.createClaim({projectId:f.project.id,artifactId:artifact.id,subjectType:'claim',
    content:'Explicit synthetic hypothesis remains unconfirmed.',status:'hypothesis',evidenceIds:[source.evidence.id]});
  const proposed=f.repository.evidence.relations.propose({projectId:f.project.id,claimId:claim.id,expectedClaimVersion:claim.version,
    evidenceId:source.evidence.id,expectedSourceDigest:api.relationSourceDigest(source),kind:'supports',condition:null,supersedesRelationId:null},
    {kind:'user',id:'window:98'});
  await publishReverseLayout(f);
  const relation=f.repository.evidence.relations.get(proposed.id,f.project.id);
  assert.equal(relation.status,'invalidated');assert.deepEqual(relation.source,source);
  const snapshot=f.repository.inspectArtifact({projectId:f.project.id,artifactId:artifact.id,expectedVersion:null}).snapshot;
  const before=f.changes(), oldClaim=f.repository.evidence.getClaim(claim.id);
  active=f;calls.length=0;
  await page.evaluate(snapshot=>window.mountRelationSource(snapshot),snapshot);
  const group=page.locator(`#relation-claim-${claim.id}`);
  await group.locator('summary').first().focus();await page.keyboard.press('Enter');
  assert.equal(await group.evaluate(group=>group.open),true);
  const record=page.getByTestId(`artifact-relation-${relation.id}`);
  await record.waitFor({state:'visible'});
  await record.locator('summary').first().waitFor({state:'visible'});
  await record.locator('summary').first().focus();await page.keyboard.press('Enter');
  assert.equal(await record.locator('details').first().evaluate(source=>source.open),true);
  const open=page.getByTestId(`artifact-relation-document-source-toggle-${relation.id}`);
  await open.waitFor();await open.focus();await page.keyboard.press('Enter');await waitForOriginal();
  assert.match(await page.getByTestId('artifact-document-source-block').innerText(),/Synthetic group A mean is 2/);
  assert.ok(calls.filter(call=>call.method==='getDocumentContent'||call.method==='previewDocument')
    .every(call=>call.input.parseId===source.sourceLocator.parseId && call.input.parseHash===source.sourceLocator.parseHash));
  await page.getByTestId('reader-pdf-page-blocks').click();
  const target=page.getByTestId('reader-pdf-block-candidate').first();await target.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.activeElement?.getAttribute('data-testid')==='artifact-document-source-block');
  await page.waitForFunction(({claimId,relationId})=>{
    const group=document.getElementById(`relation-claim-${claimId}`),record=document.querySelector(`[data-testid="artifact-relation-${relationId}"]`);
    const source=record.querySelector('details');
    return record.getBoundingClientRect().top>=group.querySelector('summary').getBoundingClientRect().bottom-1 &&
      source.querySelector('dl').getBoundingClientRect().top>=source.querySelector('summary').getBoundingClientRect().bottom-1;
  },{claimId:claim.id,relationId:relation.id});
  const geometry=await record.evaluate(record=>{
    const source=record.querySelector('details'),group=record.closest('details');
    return {groupSummaryBottom:group.querySelector('summary').getBoundingClientRect().bottom,recordTop:record.getBoundingClientRect().top,
      sourceSummaryBottom:source.querySelector('summary').getBoundingClientRect().bottom,sourceMetadataTop:source.querySelector('dl').getBoundingClientRect().top};
  });
  assert.ok(geometry.recordTop>=geometry.groupSummaryBottom-1);assert.ok(geometry.sourceMetadataTop>=geometry.sourceSummaryBottom-1);
  const auditSource=await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8'),audits=[];
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const audit=await page.evaluate(source=>(0,eval)(source)({root:'body',viewport:true}),auditSource);
    assert.equal(audit.cut,0);audits.push({theme,...audit});
    await page.screenshot({path:join(artifacts,`claim-original-${theme}.png`)});
  }
  assert.equal(f.changes(),before);assert.deepEqual(f.repository.evidence.getClaim(claim.id),oldClaim);
  assert.deepEqual(f.repository.evidence.relations.get(relation.id,f.project.id),relation);
  await writeFile(join(artifacts,'claim-fixed-original.json'),JSON.stringify({relation,claim:oldClaim,geometry,audits,calls},null,2));
  await open.click();await page.waitForFunction(()=>window.liveWorkers===0);
});

async function openAnnotationReader(f) {
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,850));
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await mount(f); await textEquals('Synthetic group A mean is 2');
  await page.getByTestId('reader-block-source').first().click(); await waitForOriginal();
}
async function pageNote() {
  await page.getByTestId('reader-annotations-toggle').click();
  const button=page.getByRole('button',{name:'本页批注',exact:true});
  await button.waitFor(); await button.focus(); await page.keyboard.press('Enter');
  await page.getByTestId('reader-annotation-form').waitFor();
}
function scientificRows(f) {
  return ['research_claims','research_evidence_relations','research_evidence_relation_revisions']
    .map(table=>f.db.prepare(`SELECT * FROM ${table}`).all());
}

test('actual rotated PDF pointer selection saves its measured region and explicit block then reuses Evidence without science writes', async () => {
  const f=await realPdfScene({pdfOptions:{rotation:90,userUnit:2,crop:[20,30,500,700]}}),science=scientificRows(f);
  await openAnnotationReader(f);
  const before=f.changes();
  await page.getByRole('button',{name:'框选 PDF 批注区域',exact:true}).click();
  const canvas=page.getByTestId('reader-pdf-canvas');
  await canvas.evaluate(canvas=>{
    window.annotationGesture=[];
    for(const name of ['pointerdown','pointerup']) canvas.addEventListener(name,event=>{
      const rect=canvas.getBoundingClientRect();
      window.annotationGesture.push({name,x:event.clientX-rect.left,y:event.clientY-rect.top,width:rect.width,height:rect.height});
    },{once:true});
  });
  const rect=await canvas.boundingBox();
  await page.mouse.move(rect.x+rect.width*.2,rect.y+rect.height*.15); await page.mouse.down();
  await page.mouse.move(rect.x+rect.width*.6,rect.y+rect.height*.45,{steps:8});
  assert.equal(await page.getByTestId('reader-pdf-selection-drag').isVisible(),true);
  await page.mouse.up();
  await page.getByTestId('reader-annotation-form').waitFor();
  assert.equal(await page.getByRole('combobox',{name:'批注解析块',exact:true}).inputValue(),'');
  assert.equal(await page.getByTestId('reader-pdf-block-candidates').count(),0);
  assert.equal(f.changes(),before);
  await page.getByRole('combobox',{name:'批注解析块',exact:true}).selectOption(f.collected.data.content.blocks[0].id);
  await page.getByRole('combobox',{name:'批注类型',exact:true}).selectOption('number');
  await page.getByRole('textbox',{name:'批注说明',exact:true}).fill('核对原 PDF 中的数字 2，批注不代表科学确认。');
  await page.getByRole('button',{name:'保存批注',exact:true}).click();
  await page.getByTestId('reader-annotation-saved').waitFor();
  const row=page.getByTestId('reader-annotation').first();await row.waitFor();
  const request=calls.find(call=>call.method==='createDocumentAnnotation').input;
  assert.equal(request.target.sourceHash,f.actual.sourceHash);
  assert.equal(request.target.parseHash,hash(JSON.stringify(f.collected.data.content)));
  assert.equal(request.target.location.kind,'pdf-region'); assert.equal(request.issue,'number');
  assert.equal(request.target.coordinateBasis.snapshotHash,f.repository.documents.coordinates(f.actual.id,'actual-original-parse').snapshotHash);
  const gesture=await page.evaluate(()=>window.annotationGesture);
  const {withResearchPdf}=await importTypeScriptModule('src/main/plugins/research/pdf-render.ts',{
    platform:'node',external:['@napi-rs/canvas','pdfjs-dist/legacy/build/pdf.mjs'],tempDir:'.runtime/tmp'});
  let expected;
  await withResearchPdf(await readFile(join(f.root,'source.pdf')),async pdf=>{
    const pdfPage=await pdf.getPage(1),viewport=pdfPage.getViewport({scale:1});
    const [start,end]=gesture;
    const points=[[start.x/start.width,start.y/start.height],[start.x/start.width,end.y/end.height],
      [end.x/end.width,start.y/start.height],[end.x/end.width,end.y/end.height]]
      .map(([x,y])=>viewport.convertToPdfPoint(x*viewport.width,y*viewport.height));
    expected=[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),
      Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
    pdfPage.cleanup();
  });
  request.target.location.bbox.forEach((value,index)=>assert.ok(Math.abs(value-expected[index])<1e-8));
  const note=f.repository.documentAnnotations.list({projectId:f.project.id,documentId:f.actual.id,parseId:'actual-original-parse'})[0];
  assert.deepEqual(note.annotation.actor,{kind:'user',id:'window:98'});
  assert.equal(f.repository.evidence.list(f.project.id).length,0);
  const capture=row.getByRole('button',{name:'捕获所选块为证据',exact:true});
  await capture.focus();await page.keyboard.press('Enter');
  await row.getByText('已捕获证据，科学结论待审核',{exact:true}).waitFor();
  const captured=f.repository.documentAnnotations.get({projectId:f.project.id,annotationId:note.annotation.id});
  assert.equal(captured.capture.source.sourceLocator.blockId,request.target.blockId);
  assert.deepEqual(captured.annotation.request.target.location,request.target.location);
  assert.deepEqual(scientificRows(f),science);
  await row.getByRole('button',{name:'回到批注位置',exact:true}).click();await waitForOriginal();
  await page.getByTestId('reader-pdf-annotation-region').waitFor();
  const geometry=await page.getByTestId('reader-pdf-annotation-region').evaluate(region=>{
    const canvas=document.querySelector('[data-testid="reader-pdf-canvas"]').getBoundingClientRect(),rect=region.getBoundingClientRect();
    return {x:(rect.left-canvas.left)/canvas.width,y:(rect.top-canvas.top)/canvas.height,w:rect.width/canvas.width,h:rect.height/canvas.height};
  });
  assert.ok(Math.abs(geometry.x-gesture[0].x/gesture[0].width)<.002);
  assert.ok(Math.abs(geometry.y-gesture[0].y/gesture[0].height)<.002);
  assert.ok(Math.abs(geometry.w-(gesture[1].x/gesture[1].width-gesture[0].x/gesture[0].width))<.002);
  const readBefore=f.changes();
  await page.getByRole('button',{name:'重读批注',exact:true}).click();await page.getByTestId('reader-annotation').waitFor();
  assert.equal(f.changes(),readBefore);
  await writeFile(join(artifacts,'annotation-actual-rotated.json'),JSON.stringify({gesture,expected,geometry,note,captured,science,calls,
    seam:'actual PDF/PDF.js/Vite/Chromium and generated main adapter through Node-host; synthetic window98'},null,2));
});

test('keyboard page-only annotation records no invented region or block; region cancellation and empty click write nothing', async () => {
  const measured=await realPdfScene();
  await openAnnotationReader(measured);const before=measured.changes();
  const select=page.getByRole('button',{name:'框选 PDF 批注区域',exact:true});
  await select.click();await page.getByTestId('reader-pdf').focus();await page.keyboard.press('Escape');
  assert.equal(await select.getAttribute('aria-pressed'),'false');
  assert.equal(await page.getByTestId('reader-pdf-selection-drag').count(),0);
  await select.click();
  await page.getByTestId('reader-pdf-canvas').click({position:{x:30,y:30}});
  await page.getByText('请拖出非空区域。',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('reader-annotation-form').count(),0);
  assert.equal(measured.changes(),before);
  await page.getByTestId('reader-pdf').focus();await page.keyboard.press('Escape');
  const f=await realPdfScene({pageOnly:true});
  await openAnnotationReader(f);const pageBefore=f.changes();
  assert.equal(await page.getByRole('button',{name:'框选 PDF 批注区域',exact:true}).isDisabled(),true);
  await pageNote();
  await page.getByText('此页未保存测量坐标，批注仅记录页。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'批注说明',exact:true}).evaluate(element=>element===document.activeElement),true);
  await page.keyboard.type('记录原文页上的单位问题');
  await page.getByRole('combobox',{name:'批注类型',exact:true}).selectOption('unit');
  const save=page.getByRole('button',{name:'保存批注',exact:true});await save.focus();await page.keyboard.press('Enter');
  await page.getByTestId('reader-annotation-saved').waitFor();
  const note=f.repository.documentAnnotations.list({projectId:f.project.id,documentId:f.actual.id,parseId:'actual-original-parse'})[0];
  assert.equal(note.annotation.block,null);
  assert.equal(note.annotation.request.target.coordinateBasis,null);
  assert.deepEqual(note.annotation.request.target.location,{kind:'page'});
  assert.equal(await page.getByRole('button',{name:'捕获所选块为证据',exact:true}).count(),0);
  assert.equal(calls.filter(call=>call.method==='createDocumentAnnotation').length,1);
  assert.ok(f.changes()>pageBefore);
});

test('annotation save and capture failures retain exact retry IDs and actual index/source refusals leave zero writes', async () => {
  const f=await realPdfScene();await openAnnotationReader(f);await pageNote();
  await page.getByRole('combobox',{name:'批注解析块',exact:true}).selectOption(f.collected.data.content.blocks[0].id);
  await page.getByRole('textbox',{name:'批注说明',exact:true}).fill('核对公式和原始数字');
  const original=await readFile(join(f.root,'source.pdf'));
  await writeFile(join(f.root,'source.pdf'),'Task-owned source corruption');
  const before=f.changes();await page.getByRole('button',{name:'保存批注',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'原文件与记录的版本不一致'}).waitFor();
  assert.equal(f.changes(),before);
  const failed=calls.find(call=>call.method==='createDocumentAnnotation').input;
  await writeFile(join(f.root,'source.pdf'),original);
  await page.getByRole('button',{name:'保存批注',exact:true}).click();
  await page.getByTestId('reader-annotation-saved').waitFor();
  const saves=calls.filter(call=>call.method==='createDocumentAnnotation');
  assert.deepEqual(saves[1].input,failed);
  const chunk=f.db.prepare("SELECT * FROM research_knowledge_chunks WHERE id='document:actual-original-parse:chunk:0'").get();
  f.db.prepare("UPDATE research_knowledge_chunks SET content='damaged current index' WHERE id=?").run(chunk.id);
  const after=f.changes();
  await page.getByRole('button',{name:'捕获所选块为证据',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'所选解析块没有一致的当前索引'}).waitFor();
  assert.equal(f.changes(),after);
  f.db.prepare('UPDATE research_knowledge_chunks SET content=? WHERE id=?').run(chunk.content,chunk.id);
  await page.getByRole('button',{name:'捕获所选块为证据',exact:true}).click();
  await page.getByText('已捕获证据，科学结论待审核',{exact:true}).waitFor();
  const captures=calls.filter(call=>call.method==='captureDocumentAnnotation');
  assert.deepEqual(captures[1].input,captures[0].input);
});

test('late annotation save acknowledgment cannot cross projects and reopening reads the saved receipt without another write', async () => {
  const first=await realPdfScene();await openAnnotationReader(first);await pageNote();
  await page.getByRole('textbox',{name:'批注说明',exact:true}).fill('Old project exact note');
  const ready=new Promise(resolve=>{first.deferReady=resolve;});first.defer='createDocumentAnnotation';
  await page.getByRole('button',{name:'保存批注',exact:true}).click();await ready;
  await page.getByRole('button',{name:'保存中…',exact:true}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'批注解析块',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('combobox',{name:'批注类型',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('textbox',{name:'批注说明',exact:true}).isDisabled(),true);
  const oldWrites=first.changes(),other=await realPdfScene();
  await openAnnotationReader(other);
  first.defer=null;first.finish();
  await page.getByTestId('reader-annotations-toggle').click();
  await page.getByText('此解析版本暂无批注。',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('reader-annotation-saved').count(),0);
  assert.equal(await page.getByText('Old project exact note',{exact:true}).count(),0);
  assert.equal(first.changes(),oldWrites);
  await openAnnotationReader(first);
  await page.getByTestId('reader-annotations-toggle').click();
  await page.getByText('Old project exact note',{exact:true}).waitFor();
  assert.equal(first.changes(),oldWrites);
  assert.equal(calls.some(call=>call.method==='createDocumentAnnotation'),false);
});

test('captured annotation reads exact historical parse and original after reparse with readonly Evidence source entry', async () => {
  const f=await realPdfScene();await openAnnotationReader(f);await pageNote();
  await page.getByRole('combobox',{name:'批注解析块',exact:true}).selectOption(f.collected.data.content.blocks[0].id);
  await page.getByRole('textbox',{name:'批注说明',exact:true}).fill('Fixed old parse note');
  await page.getByRole('button',{name:'保存批注',exact:true}).click();await page.getByTestId('reader-annotation-saved').waitFor();
  await page.getByRole('button',{name:'捕获所选块为证据',exact:true}).click();
  await page.getByText('已捕获证据，科学结论待审核',{exact:true}).waitFor();
  const original=f.repository.documentAnnotations.list({projectId:f.project.id,documentId:f.actual.id,parseId:'actual-original-parse'})[0];
  f.repository.documents.begin(f.actual.id,'new-annotation-reader-parse');
  f.repository.documents.complete(f.actual.id,'new-annotation-reader-parse',f.collected.data,f.collected.coordinates);
  const before=f.changes();
  await mountSource(f,f.repository.evidence.inspectEvidence(original.capture.source.evidence.id,f.project.id));await waitForOriginal();
  assert.equal(await page.getByRole('button',{name:'框选 PDF 批注区域',exact:true}).count(),0);
  await page.getByTestId('reader-annotations-toggle').click();
  await page.getByText('Fixed old parse note',{exact:true}).waitFor();
  await page.getByText('已捕获证据，来源引用已失效',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'本页批注',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'捕获所选块为证据',exact:true}).count(),0);
  const read=f.repository.documentAnnotations.get({projectId:f.project.id,annotationId:original.annotation.id});
  assert.deepEqual(read.annotation,original.annotation);assert.deepEqual(read.capture,original.capture);
  assert.equal(read.capturedReferenceStatus,'superseded');
  assert.ok(calls.filter(call=>call.method==='listDocumentAnnotations').every(call=>call.input.parseId==='actual-original-parse'));
  assert.equal(f.changes(),before);
});

test('annotation form and long saved source facts fit light800 dark1099 with actual keyboard and clipping audits', async () => {
  const f=await realPdfScene(),audits=[];
  await openAnnotationReader(f);await pageNote();
  const auditSource=await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8');
  await page.mouse.move(10,10);
  const defaultAudit=await page.evaluate(source=>(0,eval)(source)({root:'body',viewport:true}),auditSource);
  assert.equal(defaultAudit.cut,0);audits.push({width:1100,theme:'light',state:'form-default',...defaultAudit});
  for(const [width,theme] of [[800,'light'],[1099,'dark']]) {
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,850),width);
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.getByRole('textbox',{name:'批注说明',exact:true}).fill('核对数字、单位和公式，保留固定来源版本。'.repeat(30));
    await page.getByRole('button',{name:'保存批注',exact:true}).hover();
    const layout=await page.getByTestId('reader-annotation-form').evaluate(form=>{
      const outer=form.getBoundingClientRect();
      return {overflow:form.scrollWidth-form.clientWidth,controls:Array.from(form.querySelectorAll('select,textarea,button')).map(element=>{
        const rect=element.getBoundingClientRect();return {left:rect.left,right:rect.right,outerLeft:outer.left,outerRight:outer.right};
      })};
    });
    assert.ok(layout.overflow<=1);assert.ok(layout.controls.every(rect=>rect.left>=rect.outerLeft-1&&rect.right<=rect.outerRight+1));
    const audit=await page.evaluate(source=>(0,eval)(source)({root:'body',viewport:true}),auditSource);
    assert.equal(audit.cut,0);audits.push({width,theme,state:'form-hover',layout,...audit});
    await page.screenshot({path:join(artifacts,`annotation-form-${theme}-${width}.png`)});
  }
  await page.getByRole('button',{name:'保存批注',exact:true}).click();await page.getByTestId('reader-annotation-saved').waitFor();
  const row=page.getByTestId('reader-annotation').first();await row.waitFor();
  const summary=row.locator('summary');await summary.focus();await page.keyboard.press('Enter');
  assert.equal(await row.locator('details').evaluate(details=>details.open),true);
  await row.getByRole('button',{name:'回到批注位置',exact:true}).focus();await page.keyboard.press('Enter');await waitForOriginal();
  await page.screenshot({path:join(artifacts,'annotation-original-page-dark-1099.png')});
  await row.evaluate(row=>row.scrollIntoView({block:'start'}));
  await row.locator('details p').first().waitFor({state:'visible'});
  const savedLayout=await row.evaluate(row=>{
    const rect=row.getBoundingClientRect(),scroller=row.closest('[class*="overflow-y-auto"]').getBoundingClientRect();
    return {overflow:row.scrollWidth-row.clientWidth,top:rect.top,bottom:rect.bottom,scrollerTop:scroller.top,scrollerBottom:scroller.bottom};
  });
  assert.ok(savedLayout.overflow<=1);assert.ok(savedLayout.top>=savedLayout.scrollerTop-1);
  const audit=await page.evaluate(source=>(0,eval)(source)({root:'body',viewport:true}),auditSource);
  assert.equal(audit.cut,0);audits.push({width:1099,theme:'dark',state:'saved-open-final',savedLayout,...audit});
  await page.screenshot({path:join(artifacts,'annotation-saved-dark-1099.png')});
  await writeFile(join(artifacts,'annotation-clip-audit.json'),JSON.stringify(audits,null,2));
  assert.equal(errors.length,0);
});

/** Explicit synthetic recognition layout; the displayed PNG pixels are cropped from the actual parser's page image. */
async function publishAssetLayout(f) {
  const data=structuredClone(f.collected.data),frame=f.collected.coordinates.pages[0].frame;
  const pageAsset=data.content.assets.find(asset=>asset.kind==='page');
  const originalImage=await loadImage(await readFile(join(f.root,data.outputPath,data.files[pageAsset.id])));
  const specs=[
    {id:'synthetic-table',kind:'table',text:'<table><tr><th>group</th><th>mean</th></tr><tr><td>A</td><td>2</td></tr></table>',bbox:[0,0,frame.width,Math.floor(frame.height/2)]},
    {id:'synthetic-formula',kind:'formula',text:'mean(A) = 2; mean(B) = 4',bbox:[0,0,Math.floor(frame.width*.8),Math.floor(frame.height*.3)]}
  ];
  const template=data.content.blocks[0],observations=[];
  for(const spec of specs) {
    const [x1,y1,x2,y2]=spec.bbox,canvas=createCanvas(x2-x1,y2-y1);
    canvas.getContext('2d').drawImage(originalImage,x1,y1,x2-x1,y2-y1,0,0,x2-x1,y2-y1);
    const bytes=await canvas.encode('png'),assetId=`${spec.id}-image`,relativePath=`artifacts/${assetId}.png`;
    await writeFile(join(f.root,data.outputPath,relativePath),bytes);
    data.files[assetId]=relativePath;
    data.content.assets.push({id:assetId,kind:spec.kind==='table'?'table':'figure',page:1,sha256:hash(bytes),size:bytes.length});
    observations.push({spec,assetId,sha256:hash(bytes),size:bytes.length,width:canvas.width,height:canvas.height});
  }
  data.content.blocks=specs.map(spec=>({...template,id:spec.id,kind:spec.kind,label:spec.kind==='table'?'Synthetic table':'Synthetic formula',
    text:spec.text,locator:`synthetic:${spec.id}`,imageAssetId:`${spec.id}-image`,
    locations:[{page:1,bbox:spec.bbox,coordinateOrigin:'TOPLEFT'}]}));
  data.content.blocks.push({...template,id:'synthetic-empty-formula',kind:'formula',label:'Synthetic missing formula',
    text:'',locator:'synthetic:empty',imageAssetId:null});
  data.content.content=data.content.blocks.filter(block=>block.text.trim()).map(block=>block.text).join('\n\n');
  data.content.parserVersion='synthetic-asset-layout/v1';data.content.parserFingerprint=hash('synthetic-asset-layout/v1');
  data.content.parseMode='mixed';
  data.content.warnings=['synthetic_quality_requires_review'];
  data.content.artifacts.structuredContent='artifacts/synthetic-assets.json';
  const artifact=Buffer.from(JSON.stringify({seam:'synthetic table/formula recognition on actual original page pixels',
    blocks:data.content.blocks,coordinateFrames:f.collected.coordinates.pages}));
  await writeFile(join(f.root,data.outputPath,data.content.artifacts.structuredContent),artifact);
  const coordinates={...f.collected.coordinates,parseHash:hash(JSON.stringify(data.content)),
    artifact:{path:data.content.artifacts.structuredContent,sha256:hash(artifact),size:artifact.length}};
  f.repository.documents.begin(f.actual.id,'synthetic-asset-parse');
  f.repository.documents.complete(f.actual.id,'synthetic-asset-parse',data,coordinates);
  f.assetLayout={data,coordinates,observations};
}
async function openAssetReader(f,focus={parseId:null,locator:null}) {
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,850));
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await mount(f,focus);
  await page.getByTestId('reader-block-table').waitFor();
}
async function waitForAsset() {
  await page.getByTestId('reader-block-asset-image').scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>{
    const image=document.querySelector('[data-testid="reader-block-asset-image"]');
    return image?.complete&&image.naturalWidth>0&&image.naturalHeight>0;
  });
  await page.getByTestId('reader-block-asset-image').scrollIntoViewIfNeeded();
}

test('parsed table formula assets load lazily as exact original PNG pixels beside raw text with grounded quality facts', async () => {
  const f=await realPdfScene();
  await mount(f);await textEquals('Synthetic group A mean is 2');
  await page.getByText('此版本仅提取原生文本，未进行 OCR 核查。',{exact:true}).waitFor();
  await publishAssetLayout(f);await openAssetReader(f);const before=f.changes();
  assert.equal(calls.some(call=>call.method==='asset'||call.method==='previewDocument'),false);
  await page.getByTestId('reader-quality-ocr').waitFor();
  await page.getByText('解析提示：synthetic_quality_requires_review',{exact:true}).waitFor();
  await page.getByTestId('reader-quality-empty').waitFor();
  const table=page.getByTestId('reader-block-table');
  const toggle=table.getByTestId('reader-block-asset-toggle');
  await toggle.focus();await page.keyboard.press('Enter');await waitForAsset();
  assert.equal(await table.locator('table').count(),0,'raw table HTML is not executed as markup');
  assert.match(await table.innerText(),/<table><tr><th>group/);
  const image=page.getByTestId('reader-block-asset-image');
  const tableBitmap=await image.evaluate(image=>({width:image.naturalWidth,height:image.naturalHeight,url:image.src}));
  // Protocol images correctly taint browser canvases. Inspect actual compositor pixels through a screenshot.
  const screenshot=await image.screenshot();
  await writeFile(join(artifacts,'asset-compositor-table.png'),screenshot);
  const paintedImage=await loadImage(screenshot),bitmap=createCanvas(paintedImage.width,paintedImage.height);
  const context=bitmap.getContext('2d');context.drawImage(paintedImage,0,0);
  const pixels=context.getImageData(0,0,bitmap.width,bitmap.height).data;
  let ink=0;
  for(let y=3;y<bitmap.height-3;y++) for(let x=3;x<bitmap.width-3;x++) {
    const i=(y*bitmap.width+x)*4;if(pixels[i]<200&&pixels[i+3]>0)ink++;
  }
  Object.assign(tableBitmap,{ink,compositorWidth:bitmap.width,compositorHeight:bitmap.height});
  assert.equal(tableBitmap.width,f.assetLayout.observations[0].width);
  assert.equal(tableBitmap.height,f.assetLayout.observations[0].height);assert.ok(tableBitmap.ink>30);
  assert.equal(await page.evaluate(()=>window.liveWorkers),0,'opening parser PNG does not load the PDF engine');
  const expected=f.assetLayout.data.content.assets.find(asset=>asset.id==='synthetic-table-image');
  assert.deepEqual(calls.find(call=>call.method==='asset').input,{projectId:f.project.id,documentId:f.actual.id,
    parseId:'synthetic-asset-parse',assetId:expected.id,sha256:expected.sha256});
  const formula=page.getByTestId('reader-block-formula').filter({hasText:'mean(A)'});
  await formula.getByTestId('reader-block-asset-toggle').click();await waitForAsset();
  assert.equal(await page.getByTestId('reader-block-asset-image').count(),1);
  assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  assert.match(await formula.innerText(),/mean\(A\) = 2/);
  assert.equal(await page.getByTestId('reader-block-asset-absent').count(),1);
  assert.equal(await page.getByText(/\d+%/).count(),0,'no calibrated confidence percentages are invented');
  assert.equal(f.changes(),before);
  await writeFile(join(artifacts,'assets-fixed-pixels.json'),JSON.stringify({tableBitmap,observations:f.assetLayout.observations,calls,
    seam:'synthetic table/formula recognition; actual parser page pixels/PNG protocol/Vite/Chromium/main registry'},null,2));
});

test('parsed asset corruption displays a retry error while retaining raw text and never substitutes a page image', async () => {
  const f=await realPdfScene();await publishAssetLayout(f);await openAssetReader(f);
  const table=page.getByTestId('reader-block-table'),assetId='synthetic-table-image';
  const path=join(f.root,f.assetLayout.data.outputPath,f.assetLayout.data.files[assetId]),original=await readFile(path);
  await writeFile(path,Buffer.concat([original,Buffer.from('Task-owned changed PNG')]));
  const before=f.changes();
  await table.getByTestId('reader-block-asset-toggle').click();
  await table.getByText('所选解析图像读取或解码失败，请重新核对原文。',{exact:true}).waitFor();
  assert.match(await table.innerText(),/<table><tr><th>group/);
  assert.equal(await table.getByTestId('reader-block-asset-image').count(),0);
  assert.ok(calls.filter(call=>call.method==='asset').every(call=>call.input.assetId===assetId));
  assert.equal(f.changes(),before);
  await writeFile(path,original);
  await table.getByRole('button',{name:/重试/}).click();await waitForAsset();
  assert.equal(f.changes(),before);
  await table.getByTestId('reader-block-asset-toggle').click();
  const source=await readFile(join(f.root,'source.pdf'));await writeFile(join(f.root,'source.pdf'),'Altered source');
  const reads=calls.filter(call=>call.method==='asset').length;
  await table.getByTestId('reader-block-asset-toggle').click();
  await table.getByText('原文件与记录的版本不一致，无法预览。',{exact:true}).waitFor();
  assert.equal(calls.filter(call=>call.method==='asset').length,reads);
  assert.match(await table.innerText(),/<table><tr><th>group/);
  await writeFile(join(f.root,'source.pdf'),source);
});

test('historical parsed asset disclosure reads fixed parse and late image metadata cannot replace another project', async () => {
  const f=await realPdfScene();await publishAssetLayout(f);
  const evidence=f.repository.evidence.capture({projectId:f.project.id,chunkId:'document:synthetic-asset-parse:chunk:0'});
  f.repository.documents.begin(f.actual.id,'next-no-assets-parse');
  f.repository.documents.complete(f.actual.id,'next-no-assets-parse',f.collected.data,f.collected.coordinates);
  await openAssetReader(f,{parseId:'synthetic-asset-parse',locator:'synthetic:synthetic-table'});
  const before=f.changes();
  await page.getByTestId('reader-block-table').getByTestId('reader-block-asset-toggle').click();await waitForAsset();
  assert.ok(calls.filter(call=>call.method==='asset'||call.method==='previewDocument').every(call=>call.input.parseId==='synthetic-asset-parse'));
  assert.equal(f.changes(),before);
  await mountSource(f,f.repository.evidence.inspectEvidence(evidence.id,f.project.id));await waitForOriginal();
  await page.getByTestId('artifact-document-source-asset-toggle').click();await waitForAsset();
  await page.getByTestId('reader-block-asset').scrollIntoViewIfNeeded();
  const sourceLayout=await page.getByTestId('artifact-document-source-block').evaluate(block=>({overflow:block.scrollWidth-block.clientWidth}));
  assert.ok(sourceLayout.overflow<=1);
  const sourceAudit=await page.evaluate(source=>(0,eval)(source)({root:'body',viewport:true}),
    await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8'));
  assert.equal(sourceAudit.cut,0);
  await page.screenshot({path:join(artifacts,'asset-fixed-evidence-source.png')});
  await writeFile(join(artifacts,'asset-source-clip-audit.json'),JSON.stringify({sourceLayout,...sourceAudit},null,2));
  assert.ok(calls.filter(call=>call.method==='asset').every(call=>call.input.parseId==='synthetic-asset-parse'));
  assert.equal(f.changes(),before);
  await openAssetReader(f,{parseId:'synthetic-asset-parse',locator:'synthetic:synthetic-table'});
  await page.getByTestId('reader-block-table').getByTestId('reader-block-asset-toggle').click();await waitForAsset();
  await page.getByTestId('reader-block-table').getByTestId('reader-block-asset-toggle').click();
  const ready=new Promise(resolve=>{f.deferReady=resolve;});f.defer='previewDocument';
  await page.getByTestId('reader-block-table').getByTestId('reader-block-asset-toggle').click();await ready;
  const other=await realPdfScene();await publishAssetLayout(other);await openAssetReader(other);
  f.defer=null;f.finish();
  assert.equal(await page.getByTestId('reader-block-asset-image').count(),0);
  await page.getByTestId('reader-block-table').getByTestId('reader-block-asset-toggle').click();await waitForAsset();
  assert.ok(calls.filter(call=>call.method==='asset').every(call=>call.input.projectId===other.project.id));
  assert.equal(f.changes(),before);
});

test('asset text comparison and original PDF fit light800 dark1099 with one PNG one PDF worker and explicit formula issue capture', async () => {
  const f=await realPdfScene();await publishAssetLayout(f);await openAssetReader(f);
  const formula=page.getByTestId('reader-block-formula').filter({hasText:'mean(A)'});
  await formula.getByTestId('reader-block-asset-toggle').click();await waitForAsset();
  await formula.getByTestId('reader-block-source').click();await waitForOriginal();
  const auditSource=await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8'),audits=[];
  await page.mouse.move(10,10);
  const defaultAudit=await page.evaluate(source=>(0,eval)(source)({root:'body',viewport:true}),auditSource);
  assert.equal(defaultAudit.cut,0);audits.push({width:1100,theme:'light',state:'comparison-default',...defaultAudit});
  for(const [width,theme] of [[800,'light'],[1099,'dark']]) {
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,850),width);
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await waitForOriginal();await waitForAsset();
    await formula.getByTestId('reader-block-asset-toggle').hover();
    const layout=await formula.evaluate(block=>({overflow:block.scrollWidth-block.clientWidth,
      imageWidth:block.querySelector('img').getBoundingClientRect().width,blockWidth:block.getBoundingClientRect().width}));
    assert.ok(layout.overflow<=1);assert.ok(layout.imageWidth>0&&layout.imageWidth<layout.blockWidth);
    const audit=await page.evaluate(source=>(0,eval)(source)({root:'body',viewport:true}),auditSource);
    assert.equal(audit.cut,0);audits.push({width,theme,layout,...audit});
    await page.screenshot({path:join(artifacts,`asset-comparison-${theme}-${width}.png`)});
  }
  assert.equal(await page.getByTestId('reader-block-asset-image').count(),1);
  assert.equal(await page.evaluate(()=>window.liveWorkers),1);
  await pageNote();
  await page.getByRole('combobox',{name:'批注解析块',exact:true}).selectOption('synthetic-formula');
  await page.getByRole('combobox',{name:'批注类型',exact:true}).selectOption('formula');
  await page.getByRole('textbox',{name:'批注说明',exact:true}).fill('公式文本需要核查，保留对应原文和解析图像。');
  await page.getByRole('button',{name:'保存批注',exact:true}).click();await page.getByTestId('reader-annotation-saved').waitFor();
  const note=f.repository.documentAnnotations.list({projectId:f.project.id,documentId:f.actual.id,parseId:'synthetic-asset-parse'})[0];
  assert.equal(note.annotation.request.issue,'formula');assert.equal(note.annotation.block.imageAssetId,'synthetic-formula-image');
  await page.getByRole('button',{name:'捕获所选块为证据',exact:true}).click();
  await page.getByText('已捕获证据，科学结论待审核',{exact:true}).waitFor();
  const audit=await page.evaluate(source=>(0,eval)(source)({root:'body',viewport:true}),auditSource);
  assert.equal(audit.cut,0);audits.push({width:1099,theme:'dark',state:'issue-saved-final',...audit});
  await writeFile(join(artifacts,'asset-comparison-clip-audit.json'),JSON.stringify(audits,null,2));
});
