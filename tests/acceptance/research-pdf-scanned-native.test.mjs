import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,realpath,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadResearchWorkerTestApi,createResearchFixture} from '../unit/fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {materializeScannedSource} from '../fixtures/research-workflow/scanned-source.mjs';

let api;
before(async()=>{api=await loadResearchWorkerTestApi();});
after(()=>api?.dispose());
const hash=value=>createHash('sha256').update(value).digest('hex');

test('actual pinned OCR processes raster-only text table and formula PDF pages with sealed original coordinates and retained raw output',async()=>{
  assert.ok(process.env.ROC_SCAN_MODELS_ROOT,'explicit verified model root required; no synthetic OCR substitution');
  assert.ok(process.env.ROC_SCAN_EVIDENCE_ROOT,'explicit artifact root required');
  const root=await realpath(process.env.ROC_SCAN_EVIDENCE_ROOT);
  const source=await materializeScannedSource(join(root,'corpus'));
  const {withResearchPdf,extractResearchPdfPageText}=await importTypeScriptModule('src/main/plugins/research/pdf-render.ts',{
    platform:'node',external:['@napi-rs/canvas','pdfjs-dist/legacy/build/pdf.mjs'],tempDir:'.runtime/tmp'});
  await withResearchPdf(await readFile(source.sourcePath),async pdf=>{
    assert.equal(pdf.numPages,3);
    for(let pageNumber=1;pageNumber<=3;pageNumber++) {
      const page=await pdf.getPage(pageNumber);
      assert.equal(await extractResearchPdfPageText(page),'','source has no native PDF text layer');
      page.cleanup();
    }
  });
  const f=createResearchFixture(api,'reading',root);
  const tools=new api.ResearchToolchain(await realpath('.runtime/research-toolchain/darwin-arm64'),await realpath(process.env.ROC_SCAN_MODELS_ROOT));
  const started=performance.now();
  let parsed;
  try {
    const status=await tools.selectModels('complete');
    assert.equal(status.ready,true,'the complete pinned model pack must be present and valid');
    const jobDir=join(root,'job'),outputDir=join(jobDir,'output');
    await mkdir(jobDir,{recursive:true});
    parsed=await tools.parseDocument({projectRoot:root,sourcePath:source.sourcePath,outputDir,jobDir,
      options:{tier:'complete',device:'cpu',pageRange:'1-3'},signal:AbortSignal.timeout(300000)});
    await writeFile(join(root,'actual-parser-result.json'),JSON.stringify(parsed,null,2));
    const {collectDocumentContent}=await importTypeScriptModule('src/main/plugins/research/document-files.ts',{
      platform:'node',external:['zod'],tempDir:'.runtime/tmp'});
    const collected=await collectDocumentContent(root,outputDir,parsed);
    await writeFile(join(root,'actual-collected-result.json'),JSON.stringify(collected,null,2));
    assert.equal(parsed.sourceHash,source.truth.sourceHash);
    assert.equal(parsed.pageCount,3);assert.equal(parsed.parseMode,'ocr');assert.equal(parsed.device,'cpu');
    assert.ok(parsed.modelManifest.length===64);
    assert.ok(parsed.content.length>0,'actual OCR must produce raw recognized content');
    assert.ok(parsed.blocks.every(block=>block.locations.every(location=>location.page>=1&&location.page<=3)));
    assert.deepEqual(collected.coordinates.pages.map(page=>page.page),[1,2,3]);
    assert.ok(collected.coordinates.pages.every(page=>page.frame.kind==='pdf'));
    for(const asset of collected.data.content.assets) {
      const bytes=await readFile(join(root,collected.data.outputPath,collected.data.files[asset.id]));
      assert.equal(hash(bytes),asset.sha256);assert.equal(bytes.length,asset.size);
    }
    const originalBytes=await readFile(source.sourcePath);
    const document=f.repository.documents.import({id:'native-scanned-document',libraryItemId:null,projectId:f.project.id,
      filename:'source.pdf',mediaType:'application/pdf',sourcePath:'corpus/source.pdf',sourceHash:source.truth.sourceHash,size:originalBytes.length,
      entry:{metadata:{id:'native-scanned-literature',source:'local',externalId:'controlled-scanned-fixture',doi:null,
        title:'Controlled scanned source',authors:['Synthetic Author'],abstract:null,publishedYear:2026,citationCount:null,url:null,openAccessUrl:null,
        importedAt:'2026-11-04T00:00:00Z',updatedAt:'2026-11-04T00:00:00Z'},
        bibliography:{citationKey:'scanned2026',entryType:'article',fields:{title:'Controlled scanned source'},preambles:[],
          csl:null,title:'Controlled scanned source',authors:['Synthetic Author'],doi:null,publishedYear:2026,abstract:null,url:null}}
    },false).document;
    f.repository.documents.begin(document.id,'native-scanned-parse');
    f.repository.documents.complete(document.id,'native-scanned-parse',collected.data,collected.coordinates);
    const captures=[];
    for(const chunk of f.db.prepare("SELECT id FROM research_knowledge_chunks WHERE document_id='document:native-scanned-parse' ORDER BY chunk_index").all()) {
      const evidence=f.repository.evidence.capture({projectId:f.project.id,chunkId:chunk.id});
      const source=f.repository.evidence.inspectEvidence(evidence.id,f.project.id);
      assert.equal(source.sourceLocator.parseHash,collected.coordinates.parseHash);
      assert.equal(source.sourceLocator.sourceHash,document.sourceHash);
      const block=collected.data.content.blocks.find(block=>block.id===source.sourceLocator.blockId);
      assert.equal(evidence.excerpt,block.text);
      assert.deepEqual(source.sourceLocator.locations,block.locations);
      captures.push(source);
    }
    const service=new api.ResearchDocumentService(f.repository,tools,root),registry=new api.CapabilityRegistry();
    for(const descriptor of api.researchDocumentCapabilities) registry.declare('research',descriptor);
    api.registerResearchDocumentCapabilities({pluginId:'research',capabilities:registry},f.repository.documents,service);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,request)=>registry.invoke(name,request)});
    const before=f.db.prepare('SELECT total_changes()').pluck().get();
    const preview=await bridge.invoke('research.previewDocument',[{projectId:f.project.id,documentId:document.id,
      parseId:'native-scanned-parse',sourceHash:document.sourceHash,parseHash:collected.coordinates.parseHash}],100);
    assert.equal(preview.ok,true,JSON.stringify(preview));
    assert.equal(preview.data.coordinates.snapshotHash,f.repository.documents.coordinates(document.id,'native-scanned-parse').snapshotHash);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
    const summary={sourceTruth:source.truth,elapsedMs:performance.now()-started,
      runtime:parsed.runtime,modelManifest:parsed.modelManifest,parserFingerprint:parsed.parserFingerprint,device:parsed.device,
      parseHash:hash(JSON.stringify(collected.data.content)),coordinates:collected.coordinates,
      blocks:parsed.blocks.map(block=>({id:block.id,kind:block.kind,page:block.locations[0]?.page,text:block.text,imagePath:block.imagePath})),
      captures,preview:preview.data,transport:'actual native OCR/collector/repository/registry/generated adapter; synthetic window100',
      caution:'Controlled raster source exercises actual OCR and retained outputs. No calibrated scores or general scientific accuracy claim.'};
    await writeFile(join(root,'native-acceptance.json'),JSON.stringify(summary,null,2));
    const rawText=parsed.blocks.map(block=>block.text).join('\n');
    const tableBlock=parsed.blocks.find(block=>block.locations.some(location=>location.page===2)&&block.text.includes('Mean'));
    await writeFile(join(root,'recognition-observations.json'),JSON.stringify({
      sourceHash:source.truth.sourceHash,parseHash:summary.parseHash,
      bodyLines:source.truth.lines.map(text=>({sourceText:text,exactlyRetained:rawText.includes(text)})),
      table:{source:source.truth.table,actualKind:tableBlock?.kind,rawText:tableBlock?.text,imagePath:tableBlock?.imagePath},
      formula:{source:source.truth.formula,rawBlocks:summary.blocks.filter(block=>block.kind==='formula')},
      scope:'Exact raw-output comparison only. No calibrated accuracy or scientific validity claim.'
    },null,2));
    console.log(JSON.stringify({elapsedMs:summary.elapsedMs,mode:parsed.parseMode,blocks:parsed.blocks.length,
      tables:parsed.blocks.filter(block=>block.kind==='table').length,formulas:parsed.blocks.filter(block=>block.kind==='formula').length,
      images:collected.data.content.assets.length}));
  } finally {
    f.close();
  }
});
