import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {_electron} from '@playwright/test';
import electronPath from 'electron';
import {buildViteRenderer} from '../renderer/fixtures/build-vite-renderer.mjs';
import {loadResearchTestApi,createResearchFixture} from '../unit/fixtures/research-test-kit.mjs';

let api,f,root,collected,truth,native,app,page,directory;
const calls=[],errors=[],hash=value=>createHash('sha256').update(value).digest('hex');
before(async()=>{
  assert.ok(process.env.ROC_SCAN_EVIDENCE_ROOT,'explicit real native acceptance output required');
  assert.ok(process.env.ROC_SCAN_MODELS_ROOT,'explicit real model status required');
  root=await realpath(process.env.ROC_SCAN_EVIDENCE_ROOT);
  collected=JSON.parse(await readFile(join(root,'actual-collected-result.json'),'utf8'));
  native=JSON.parse(await readFile(join(root,'native-acceptance.json'),'utf8'));
  truth=JSON.parse(await readFile(join(root,'corpus/source-truth.json'),'utf8'));
  assert.equal(hash(await readFile(join(root,'corpus/source.pdf'))),truth.sourceHash);
  assert.equal(hash(JSON.stringify(collected.data.content)),native.parseHash);
  api=await loadResearchTestApi();f=createResearchFixture(api,'reading',root);
  f.document=f.repository.documents.import({id:'actual-scanned-reader-document',libraryItemId:null,projectId:f.project.id,
    filename:'source.pdf',mediaType:'application/pdf',sourcePath:'corpus/source.pdf',sourceHash:truth.sourceHash,
    size:(await readFile(join(root,'corpus/source.pdf'))).length,
    entry:{metadata:{id:'actual-scanned-reader-literature',source:'local',externalId:'actual-scanned-reader',doi:null,
      title:'Actual controlled scanned source',authors:['Synthetic Author'],abstract:null,publishedYear:2026,citationCount:null,url:null,openAccessUrl:null,
      importedAt:'2026-11-04T00:00:00Z',updatedAt:'2026-11-04T00:00:00Z'},
      bibliography:{citationKey:'scannedreader2026',entryType:'article',fields:{title:'Actual controlled scanned source'},preambles:[],
        csl:null,title:'Actual controlled scanned source',authors:['Synthetic Author'],doi:null,publishedYear:2026,abstract:null,url:null}}
  },false).document;
  f.repository.documents.begin(f.document.id,'actual-scanned-reader-parse');
  f.repository.documents.complete(f.document.id,'actual-scanned-reader-parse',collected.data,collected.coordinates);
  const tools=new api.ResearchToolchain(await realpath('.runtime/research-toolchain/darwin-arm64'),await realpath(process.env.ROC_SCAN_MODELS_ROOT));
  await tools.selectModels('complete');
  f.registry=new api.CapabilityRegistry();
  for(const descriptor of api.researchDocumentCapabilities) f.registry.declare('research',descriptor);
  api.registerResearchDocumentCapabilities({pluginId:'research',capabilities:f.registry},f.repository.documents,
    new api.ResearchDocumentService(f.repository,tools,root));
  f.bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>f.registry.invoke(name,input)});
  directory=await mkdtemp(join(tmpdir(),'roc-real-scanned-reader-'));
  await buildViteRenderer({directory,script:`
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {PaperReader} from ${JSON.stringify(join(process.cwd(),'src/renderer/literature/PaperReader'))};
    import {ArtifactDocumentSource} from ${JSON.stringify(join(process.cwd(),'src/renderer/artifacts/ArtifactDocumentSource'))};
    import {WorkspaceScopeProvider} from ${JSON.stringify(join(process.cwd(),'src/renderer/app/workspace-scope'))};
    const research=Object.fromEntries(['resolveDocumentParse','previewDocument','getDocumentContent',
      'getModelsStatus','createDocumentAnnotation','captureDocumentAnnotation','listDocumentAnnotations','getDocumentAnnotation']
      .map(method=>[method,input=>window.nativeHost(method,input)]));
    const client={api:{research}},root=createRoot(document.getElementById('root'));
    window.mountScanned=snapshot=>root.render(<WorkspaceScopeProvider value={{client,projectId:snapshot.projectId,
      workspacePath:snapshot.workspacePath,writable:true,workspaceStatus:'ready',workspaceError:null,openFileInCanvas:()=>{}}}>
      <PaperReader literature={{client,...snapshot,loadDocumentContent:input=>research.getDocumentContent(input),
        action:{pending:false,error:null},assistant:{pending:false,error:null},parseInFlight:null}}
        onClearFocus={()=>{}} openInFilesView={()=>{}}/>
    </WorkspaceScopeProvider>);
    window.mountCaptured=source=>root.render(<div style={{width:560,maxWidth:'100%',margin:'auto'}}>
      <ArtifactDocumentSource client={client} evidence={source.evidence} locator={source.sourceLocator}/>
    </div>);
  `,style:'html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}'});
  await build({entryPoints:['src/main/pdf-preview-protocol.ts'],outfile:join(directory,'protocol.cjs'),
    bundle:true,platform:'node',format:'cjs',external:['electron'],logLevel:'silent'});
  await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    const preview=require(${JSON.stringify(join(directory,'protocol.cjs'))});preview.registerPdfPreviewScheme();
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>{
      preview.registerPdfPreviewProtocol(()=>({invokeCapability:async(name,input)=>{
        const method=name==='research.document.source'?'source':name==='research.document.asset'?'asset':null;
        if(method===null)throw new Error('unsupported native scan test capability');
        const result=await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.nativeHost('+JSON.stringify(method)+','+JSON.stringify(input)+')');
        if(!result.ok)throw new Error(result.message);
        return new Response(new Uint8Array(result.bytes),{headers:result.headers});
      }}),null);
      return new BrowserWindow({show:false,width:1100,height:900}).loadFile(${JSON.stringify(join(directory,'index.html'))});
    });`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('nativeHost',async(method,input)=>{
    calls.push({method,input});
    if(method==='getModelsStatus')return {ok:true,data:await tools.modelsStatus()};
    if(method==='source'||method==='asset'){
      try {
        const response=await f.registry.invoke(`research.document.${method}`,input);
        return {ok:true,bytes:Array.from(new Uint8Array(await response.arrayBuffer())),headers:Object.fromEntries(response.headers)};
      }catch(error){return {ok:false,message:error.message};}
    }
    const channel={getDocumentContent:'roc:research:document-content',resolveDocumentParse:'roc:research:document-resolve-parse',
      previewDocument:'roc:research:document-preview',createDocumentAnnotation:'roc:research:annotations-create',
      captureDocumentAnnotation:'roc:research:annotations-capture',listDocumentAnnotations:'roc:research:annotations-list',
      getDocumentAnnotation:'roc:research:annotations-get'}[method];
    api.parseIpcRequestArgs(channel,[input]);
    return f.bridge.invoke(`research.${method}`,[input],101);
  });
  await page.evaluate(snapshot=>window.mountScanned(snapshot),{projectId:f.project.id,workspacePath:root,
    selected:f.repository.library.get(f.document.libraryItemId),documents:[f.repository.documents.get(f.document.id)]});
});
after(async()=>{await app?.close();f?.close();api?.dispose();if(directory)await rm(directory,{recursive:true,force:true});});

async function waitForPdf() {
  await page.waitForFunction(()=>{
    const canvas=document.querySelector('[data-testid="reader-pdf-canvas"]');
    return canvas?.width>0&&canvas.height>0&&canvas.parentElement.style.visibility==='visible';
  });
}
const changes=()=>f.db.prepare('SELECT total_changes()').pluck().get();
test('real scanned table classified as figure still exposes its captured image and actual OCR text without reclassification',async()=>{
  await page.getByTestId('reader-quality-ocr').waitFor();
  const block=collected.data.content.blocks.find(block=>block.locations.some(location=>location.page===2)&&block.imageAssetId!==null&&block.text.includes('Mean'));
  assert.ok(block,'real source must retain the detected table region image and raw cell text');
  assert.equal(block.kind,'figure','retain actual pinned-model classification, do not invent table semantics');
  const row=page.locator(`[data-block-id="${block.id}"]`);
  const before=changes();
  await row.getByTestId('reader-block-asset-toggle').click();
  const image=row.getByTestId('reader-block-asset-image');await image.scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>{
    const image=document.querySelector('[data-testid="reader-block-asset-image"]');
    return image?.complete&&image.naturalWidth>0;
  });
  assert.ok((await row.innerText()).includes(block.text));
  assert.equal(f.repository.documents.parsed(f.document.id,'actual-scanned-reader-parse').data.content.blocks.find(value=>value.id===block.id).kind,'figure');
  await row.getByTestId('reader-block-source').click();await waitForPdf();
  assert.equal(await page.getByTestId('reader-pdf-canvas').getAttribute('aria-label'),'原 PDF 第 2 页');
  await page.getByTestId('reader-pdf-region').waitFor();
  const audit=await page.evaluate(source=>(0,eval)(source)({root:'body',viewport:true}),
    await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8'));
  assert.equal(audit.cut,0);assert.equal(changes(),before);
  await page.screenshot({path:join(root,'actual-scanned-table-reader.png')});
  const layouts=[];
  for(const [width,theme] of [[800,'light'],[1099,'dark']]) {
    await page.setViewportSize({width,height:900});
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await waitForPdf();await image.scrollIntoViewIfNeeded();
    await row.getByTestId('reader-block-asset-toggle').hover();
    const audit=await page.evaluate(source=>(0,eval)(source)({root:'body',viewport:true}),
      await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8'));
    assert.equal(audit.cut,0);assert.equal(audit.hidden,0);
    await page.screenshot({path:join(root,`actual-scanned-table-${width}-${theme}.png`)});
    layouts.push({width,theme,audit});
  }
  await page.setViewportSize({width:1100,height:900});
  await writeFile(join(root,'actual-scanned-table-reader.json'),JSON.stringify({block,audit,calls,scientificWrites:0,
    layouts,
    seam:'actual native-produced OCR/coordinates/assets; actual Vite/Chromium/protocol/registry/generated adapter; Node-host/window101 seam'},null,2));
});

test('real malformed formula remains raw beside original pixels and human issue capture preserves exact OCR version',async()=>{
  const block=collected.data.content.blocks.find(block=>block.kind==='formula'&&block.locations[0].page===3);
  assert.ok(block,'actual formula recognition output required');
  const row=page.locator(`[data-block-id="${block.id}"]`);
  await row.getByTestId('reader-block-asset-toggle').click();
  await row.getByTestId('reader-block-asset-image').scrollIntoViewIfNeeded();
  await row.getByTestId('reader-block-source').click();await waitForPdf();
  assert.equal(await page.getByTestId('reader-pdf-canvas').getAttribute('aria-label'),'原 PDF 第 3 页');
  assert.ok((await row.innerText()).includes(block.text));
  assert.equal(await row.locator('math,table').count(),0,'OCR formula is not silently repaired or interpreted');
  await page.getByTestId('reader-annotations-toggle').click();
  await page.getByRole('button',{name:'本页批注',exact:true}).click();
  await page.getByRole('combobox',{name:'批注解析块',exact:true}).selectOption(block.id);
  await page.getByRole('combobox',{name:'批注类型',exact:true}).selectOption('formula');
  await page.getByRole('textbox',{name:'批注说明',exact:true}).fill('原图的求和上下标与当前识别文本不一致，需要核查。');
  await page.getByRole('button',{name:'保存批注',exact:true}).click();await page.getByTestId('reader-annotation-saved').waitFor();
  await page.getByRole('button',{name:'捕获所选块为证据',exact:true}).click();
  await page.getByText('已捕获证据，科学结论待审核',{exact:true}).waitFor();
  const annotation=f.repository.documentAnnotations.list({projectId:f.project.id,documentId:f.document.id,parseId:'actual-scanned-reader-parse'})[0];
  assert.equal(annotation.annotation.request.target.page,3);
  assert.equal(annotation.annotation.request.target.parseHash,native.parseHash);
  assert.equal(annotation.annotation.block.text,block.text);
  assert.equal(annotation.capture.source.evidence.excerpt,block.text);
  assert.equal(annotation.capture.source.sourceLocator.sourceHash,truth.sourceHash);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_claims').pluck().get(),0);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence_relations').pluck().get(),0);
  await page.getByTestId('reader-annotation-saved').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(root,'actual-scanned-formula-note.png')});
  await writeFile(join(root,'actual-scanned-formula-note.json'),JSON.stringify({block,annotation,calls,scientificWrites:0},null,2));
  assert.equal(errors.length,0);
});

test('captured real scanned table image remains accessible in fixed Evidence source',async()=>{
  const block=collected.data.content.blocks.find(block=>block.locations.some(location=>location.page===2)&&block.text.includes('Mean'));
  const chunks=f.db.prepare('SELECT id FROM research_knowledge_chunks WHERE document_id=? AND content=? AND locator=?')
    .all('document:actual-scanned-reader-parse',block.text,block.locator);
  assert.equal(chunks.length,1,'capture uses the unique actual indexed block');
  const evidence=f.repository.evidence.capture({projectId:f.project.id,chunkId:chunks[0].id});
  const source=f.repository.evidence.inspectEvidence(evidence.id,f.project.id);
  const before=changes();
  await page.evaluate(source=>window.mountCaptured(source),source);
  await waitForPdf();
  await page.getByTestId('artifact-document-source-asset-toggle').click();
  const image=page.getByTestId('reader-block-asset-image');await image.scrollIntoViewIfNeeded();
  await image.evaluate(image=>image.decode());
  assert.ok((await page.getByTestId('artifact-document-source-block').innerText()).includes(block.text));
  assert.equal(await page.getByTestId('reader-pdf-canvas').getAttribute('aria-label'),'原 PDF 第 2 页');
  assert.equal(changes(),before);assert.equal(errors.length,0);
  await page.screenshot({path:join(root,'actual-scanned-table-fixed-evidence.png')});
});
