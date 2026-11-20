import {createHash} from 'node:crypto';
import {mkdtemp, realpath, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {createCanvas} from '@napi-rs/canvas';
import {load} from 'sqlite-vec';
import {importTypeScriptModule} from '../../../scripts/lib/bundle-ts.mjs';
import {createResearchFixture, loadResearchTestApi} from './research-test-kit.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
export async function loadScientificSearchApi() {
  const [api, router, irStore, tables, equations, visuals, quality, documents] = await Promise.all([
    loadResearchTestApi(), ...['scientific-retrieval-router', 'paper-ir-repository', 'pdf-table-extractor',
      'pdf-equation-extractor', 'pdf-caption-linker', 'pdf-quality-assessor', 'document-repository'].map(name =>
      importTypeScriptModule(`src/main/plugins/research/${name}.ts`,
        {platform:'node',tempDir:'.runtime/tmp',external:['@napi-rs/canvas']}))
  ]);
  return {...api, ...router, ...irStore, ...tables, ...equations, ...visuals, ...quality, ...documents};
}
const block = (id, kind, text, y) => ({id, kind, text, label:kind, locator:`page 1 ${id}`,
  imagePath:null, locations:[{page:1, bbox:[10,y,300,y+20], coordinateOrigin:'TOPLEFT'}]});

/** Controlled parser objects and vectors exercise contracts; they are not a scientific quality benchmark. */
export async function scientificSearchFixture(api, {objects = true, embedded = true, reranker = null, image = false, imageKind = 'figure',
  emptyTableText = false} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(),'roc-scientific-search-')));
  const f = createResearchFixture(api,'reading',root);
  let embeddings;
  try {
  load(f.db);
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([600,800]);
  const prose = 'Original method uses Dataset C. F1 improves on the test split. Figure 2 and Eq. (7) explain it.';
  for (const [i,text] of ['2 Method',prose,'Table 3: Dataset C results.','Original baseline 90 91',
    'Figure 2: Original architecture.','x = y','where x denotes the original input.'].entries()) {
    page.drawText(text,{x:30,y:740-i*35,size:9,font});
  }
  const source = join(root,'source.pdf'), bytes = Buffer.from(await pdf.save());
  await writeFile(source,bytes);
  const metadata = {id:'fixture-paper',source:'local',externalId:'fixture-paper',doi:'10.1234/scientific-search',
    title:'Original scientific source',authors:['Original Author'],abstract:null,publishedYear:2026,citationCount:null,
    url:null,openAccessUrl:null,importedAt:'2026-11-17T00:00:00Z',updatedAt:'2026-11-17T00:00:00Z'};
  const bibliography = {citationKey:'fixture',entryType:'article',fields:{title:metadata.title},preambles:[],
    csl:null,title:metadata.title,authors:metadata.authors,doi:metadata.doi,publishedYear:2026,abstract:null,url:null};
  const document = f.repository.documents.import({id:'fixture-document',libraryItemId:null,projectId:f.project.id,
    filename:'source.pdf',mediaType:'application/pdf',sourcePath:'source.pdf',sourceHash:hash(bytes),size:bytes.length,
    entry:{metadata,bibliography}},false).document;
  const parsed = await api.parseResearchDocument({projectRoot:root,sourcePath:source,outputDir:join(root,'parser'),
    options:{tier:'compact',device:'cpu',pageRange:''},modelFiles:null,modelManifest:''});
  let blocks = parsed.blocks, imageBytes = null;
  if (image) {
    const canvas = createCanvas(96, 64);
    canvas.getContext('2d').fillRect(2, 2, 90, 58);
    imageBytes = await canvas.encode('png');
    canvas.width = 0; canvas.height = 0;
    await writeFile(join(root, 'parser', 'figure.png'), imageBytes);
  }
  if (objects) {
    blocks = [block('method','heading','2 Method',10),block('body','paragraph',prose,40),
      block('table-caption','paragraph','Table 3: Dataset C results.',80),
      block('table','table','Original baseline 90 91',105),block('figure','figure','',150),
      block('figure-caption','paragraph','Figure 2: Original architecture.',175),
      block('equation','formula','x = y \\tag{7}',210),
      block('definition','paragraph','where $x$ denotes the original input.',240)];
    if (image) blocks[imageKind === 'table' ? 3 : 4].imagePath = 'figure.png';
    if (emptyTableText) blocks[3].text = '';
    blocks[3].table = api.extractPaperTable(blocks[3],{id:'table',
      rawHtml:'<table><tr><th>Method</th><th>F1 (%)</th></tr><tr><td rowspan="2">Original baseline</td><td>90</td></tr><tr><td>91</td></tr></table>'});
    blocks = api.attachPaperVisuals(api.attachPaperEquations(blocks,[{regions:[{id:'equation',formula:'x = y \\tag{7}'}]}]));
    if (image) blocks[imageKind === 'table' ? 3 : 4].visual.assetId = 'fixture-figure';
    if (image && imageKind === 'table') blocks[3].table.assetId = 'fixture-figure';
  }
  const {structure, ...base} = parsed;
  const content = {...base,blocks:blocks.map(({imagePath,...b})=>({...b,
    imageAssetId:imagePath ? 'fixture-figure' : null})),
    assets:imageBytes ? [{id:'fixture-figure',kind:imageKind,page:1,sha256:hash(imageBytes),size:imageBytes.length}] : [],
    content:blocks.filter(b=>b.text.trim()).map(b=>b.text).join('\n\n'),
    quality:api.assessPdfQuality({pages:[{page:1,regions:[],coordinateFrame:{
      kind:'image',page:1,width:600,height:800,unit:'raster-pixel',coordinateOrigin:'TOPLEFT'}}],blocks})};
  let provider = async texts => texts.map(()=>[1,0,0]), calls = 0, parseNumber = 0;
  if (embedded) f.repository.knowledge.saveEmbeddingConfig({id:'fixture-embedding',name:'fixture',enabled:true,
    baseUrl:'https://fixture.invalid',model:'fixture-model',dimensions:3},'fixture-secret');
  embeddings = new api.ResearchEmbeddingService(f.repository.knowledge,{embed:async({texts,signal})=>{
    calls++; return await provider(texts,signal);
  }},{secrets:{get:async()=>'fixture-key'},logger:{info(){},warn(){},error(){}}});
  const scholarly = new api.ScholarlyRelationsRepository(f.db,f.repository);
  const router = new api.ScientificRetrievalRouter(f.repository,embeddings,{library:root,index:null},scholarly,null,reranker);
  const publish = async () => {
    const parseId = `fixture-parse-${++parseNumber}`, data = api.storedDocumentContentSchema.parse({content,outputPath:'parser',
      files:imageBytes ? {'fixture-figure':'figure.png'} : {}});
    f.repository.documents.begin(document.id,parseId);
    const ir = f.repository.documents.buildPaperIR(document.id,parseId,data);
    data.paperIR = await new api.PaperIRRepository(root).publish(ir);
    const identity = embeddings.selectedIdentity(null);
    const generation = f.repository.scientificIndex.begin({ir,paperIR:data.paperIR,projectId:null,
      source:{kind:'library'},embedding:identity,policy:{tableTokens:64}});
    if (identity) f.repository.scientificIndex.writeEmbeddings(generation.id,identity,
      f.repository.scientificIndex.chunks(generation.id,null).filter(c=>c.retrieval).map(c=>({chunkId:c.id,vector:[1,0,0]})));
    f.repository.scientificIndex.publish(generation.id,()=>({paperIR:data.paperIR,embedding:identity}),
      ()=>f.repository.documents.complete(document.id,parseId,data,null));
    return {ir,generation:f.repository.scientificIndex.get(generation.id),data};
  };
  const initial = await publish();
  return {...f,root,source,bytes,imageBytes,document,metadata,embeddings,scholarly,router,...initial,publish,
    provider:value=>{provider=value;},calls:()=>calls,
    request:query=>({projectId:f.project.id,query,documentIds:[],embeddingConfigId:null,limit:20,candidateLimit:100}),
    close:async()=>{await embeddings.shutdown();await f.close();await rm(root,{recursive:true,force:true});}};
  } catch (error) {
    await embeddings?.shutdown();
    await f.close();
    await rm(root,{recursive:true,force:true});
    throw error;
  }
}
