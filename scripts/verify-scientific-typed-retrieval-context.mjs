// Independent readback: raw SQLite/JSON/bytes only; no production or evaluation
// runtime/verifier imports, no provider, no source DB write, no index creation.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,statSync,mkdtempSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {Tiktoken} from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/cl100k_base';

const sha=b=>createHash('sha256').update(b).digest('hex');
const hash=v=>sha(JSON.stringify(v)),read=p=>JSON.parse(readFileSync(p,'utf8'));
// Frozen evaluation result hashes recursively sort keys; current production
// receipts hash their ordered JSON. Keep these two actual contracts distinct.
const sorted=v=>Array.isArray(v)?v.map(sorted):v!==null&&typeof v==='object'?
  Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
const frozenHash=v=>hash(sorted(v));
const token=new Tiktoken(ranks),tokens=v=>token.encode(JSON.stringify(v),[],[]).length;
const eq=(a,b,label="independent readback equality")=>assert.deepEqual(a,b,label);
const close=(a,b,label)=>assert.ok(Math.abs(a-b)<1e-12,label);
export function verifyChunkProjection(generic,chunk) {
  assert.equal(generic.id,chunk.id);assert.equal(generic.content,chunk.content,'content source binding');
  assert.equal(sha(generic.content),chunk.contentHash,'actual content hash');
  assert.equal(generic.content_hash,chunk.contentHash);
  eq(JSON.parse(generic.locator),chunk.sourceLocator,'original locator binding');
}
export function verifyGenericRanking(result,expectedIds,versions) {
  const {inputHash,ranker,coverage,...snapshot}=result.ranking;
  assert.equal(ranker,'rrf-v1-k60');assert.equal(inputHash,hash({query:result.query,...snapshot}),'ranking input hash');
  assert.equal(snapshot.embedding,null);assert.equal(result.vectorCount,0);assert.equal(result.embeddingModel,null);
  assert.equal(snapshot.reranker.status,'not_requested');assert.equal(snapshot.reranker.model,null);
  assert.equal(coverage.vector,'not_searched');
  eq(snapshot.candidates.map(c=>c.chunkId),expectedIds,'raw FTS ranking');
  assert.equal(result.keywordCount,expectedIds.length);
  eq(result.hits.map(h=>h.chunkId),expectedIds.slice(0,20),'hit order bound to candidates');
  for(const [i,c] of snapshot.candidates.entries()) {
    const v=versions(c.chunkId);
    for(const k of ['chunkId','documentId','locator','chunkHash','indexedVersion'])assert.equal(c[k],v[k],k);
    assert.equal(c.keywordRank,i+1);assert.equal(c.vectorRank,null);assert.equal(c.rerankScore,null);
    close(c.score,1/(61+i),'generic RRF arithmetic');
    assert.equal(c.outputRank,i<20?i+1:null,'output rank binding');
    if(i<20) {
      const hit=result.hits[i];
      assert.equal(sha(hit.content),c.chunkHash);assert.equal(hit.locator,c.locator);
      assert.equal(hit.documentId,c.documentId);assert.equal(hit.keywordRank,c.keywordRank);
      assert.equal(hit.vectorRank,null);close(hit.rrfScore,c.score);
    }
  }
}
const stop=new Set(['a','an','the','and','or','of','for','from','in','on','to','with','what','which','how','why',
  'is','are','was','were','show','explain','compare','paper','papers','table','tables','figure','figures','fig',
  'equation','equations','eq','doi','解释','比较','对比','论文','公式','方程','表','图','的','和','在','上']);
const terms=q=>[...new Set((q.match(/[\p{L}\p{N}_]+/gu)??[]).map(t=>t.toLowerCase()).filter(t=>!stop.has(t)))].slice(0,32);
const cmp=(a,b,plan)=>b.score-a.score||
  Number(['table','figure','equation'].includes(b.object.kind)&&plan.intents.includes(b.object.kind))-
  Number(['table','figure','equation'].includes(a.object.kind)&&plan.intents.includes(a.object.kind))||
  Number(b.signals.some(s=>s.method==='exact'))-Number(a.signals.some(s=>s.method==='exact'))||
  Number(b.semanticRoles.some(r=>plan.filters.sectionRoles.includes(r)))-Number(a.semanticRoles.some(r=>plan.filters.sectionRoles.includes(r)))||
  a.id.localeCompare(b.id);
const withoutAsset=v=>Array.isArray(v)?v.map(withoutAsset):v&&typeof v==='object'?
  Object.fromEntries(Object.entries(v).filter(([k])=>k!=='assetId').map(([k,x])=>[k,withoutAsset(x)])):v;
const numbered=v=>v?.trim().replace(/^\(|\)$/gu,'').toUpperCase()??null;
const lexical=(text,ts)=>ts.reduce((n,t)=>n+Number(text.toLowerCase().includes(t.toLowerCase())),0);
const count=rows=>({rows:rows.length,unavailable:rows.filter(r=>r.status==='unavailable').length,
  observed:rows.filter(r=>r.status==='observed').length,budgetAccepted:rows.filter(r=>r.budgetAccepted).length,
  nonemptyPaired:rows.filter(r=>r.generic?.result&&r.scientific?.result?.evidence.length).length,
  errors:{generic:rows.filter(r=>r.generic?.error).length,scientific:rows.filter(r=>r.scientific?.error).length}});
const stats=values=>values.length?{count:values.length,min:Math.min(...values),max:Math.max(...values),
  mean:values.reduce((a,b)=>a+b,0)/values.length,p95:[...values].sort((a,b)=>a-b)[Math.floor(values.length*.95)]}:null;

// These projections read raw object fields. They import no production modules.
function rawObject(ir,c) {
  if(['table','table_row_group'].includes(c.chunkType)) {
    const t=ir.tables.find(t=>t.id===c.objectId),included=new Set(c.sources.filter(s=>['cell','header'].includes(s.field)).map(s=>s.locator.objectId));
    return {kind:'table',number:t.data.tableNumber??t.visual?.objectNumber??null,caption:t.data.caption,
      rows:c.selection.rows??t.data.rows.map(r=>r.index),columns:t.data.columns.map(({index,header,unit})=>({index,header,unit})),
      cells:t.cells.filter(x=>included.has(x.id)).map(x=>{
        const raw=t.data.rows[x.row].cells.find(y=>y.id===x.originalId);
        return {id:x.id,originalId:x.originalId,row:x.row,column:x.column,text:x.text,header:raw.header,
          rowSpan:raw.rowSpan,colSpan:raw.colSpan,sourceLocator:x.sourceLocator};
      }),footnotes:t.data.footnotes};
  }
  if(c.chunkType==='figure')return {kind:'figure',data:ir.figures.find(x=>x.id===c.objectId).data};
  if(c.chunkType==='equation')return {kind:'equation',data:ir.equations.find(x=>x.id===c.objectId).data};
  if(c.chunkType==='algorithm')return {kind:'algorithm',stepIds:c.selection.steps??ir.algorithms.find(x=>x.id===c.objectId).steps.map(s=>s.id)};
  return {kind:'text'};
}
function auditSource(ir,source) {
  const loc=source.locator??source.sourceLocator,block=ir.blocks.find(b=>b.blockId===loc?.blockId);
  assert.ok(block,'locator block exists');
  for(const k of ['documentId','parseId','knowledgeDocumentId','sourceHash','parseHash','parserFingerprint'])
    eq(loc[k],ir.identity[k],'original locator identity '+k);
  eq(loc.rawLocator,block.sourceLocator.rawLocator,'locator raw');
  eq(loc.parentBlockId,block.blockId,'parent block locator');
  const cell=ir.tables.flatMap(t=>t.cells).find(c=>c.id===loc.objectId);
  if(cell)eq(loc.locations,cell.sourceLocator.locations,'cell geometry retained');
  else eq(loc.locations,block.sourceLocator.locations,'original geometry retained');
  if(source.text===undefined)return;
  const field=source.field;
  if(['cell','header'].includes(field)) {assert.ok(cell);eq(source.text,cell.text,'source cell text');return;}
  if(field==='latex') {
    const e=ir.equations.find(e=>e.id===loc.objectId);assert.ok(e);
    eq(source.text,e.data.rawLatex??block.text,'whole original formula');return;
  }
  if(['html-caption','footnote'].includes(field)) {
    const t=ir.tables.find(t=>t.id===loc.objectId);assert.ok(t);
    assert.ok(field==='html-caption'?source.text===t.data.caption:t.data.footnotes.includes(source.text),'original table caption/footnote');return;
  }
  const span=loc.textSpan;
  if(span)assert.ok(Number.isInteger(span.start)&&span.start>=0&&span.end>=span.start&&span.end<=block.text.length,'UTF16 range');
  eq(source.text,span?block.text.slice(span.start,span.end):block.text,'exact original text');
}
function auditSerialized(ir,c) {
  let content;
  if(['paragraph','caption'].includes(c.chunkType)) {
    const b=ir.blocks.find(b=>b.id===c.objectId),span=c.selection.span??{start:0,end:b.text.length};
    content=b.text.slice(span.start,span.end);
  } else if(['table','table_row_group'].includes(c.chunkType)) {
    const t=ir.tables.find(t=>t.id===c.objectId),rows=c.selection.rows??t.data.rows.map(r=>r.index);
    const raw=t.data.rows.flatMap(r=>r.cells.map(cell=>({...cell,row:r.index})));
    content=raw.filter(cell=>rows.some(r=>cell.row<=r&&r<cell.row+cell.rowSpan))
      .map(x=>`Row ${x.row}, column ${x.column}, span ${x.rowSpan}x${x.colSpan}: ${x.text}`).join('\n');
    const header=new Set(t.data.columns.flatMap(c=>c.headerCellIds));
    const expectedIds=[...new Set([...raw.filter(c=>header.has(c.id)),...raw.filter(c=>rows.some(r=>c.row<=r&&r<c.row+c.rowSpan))].map(c=>c.id))];
    eq(c.sources.filter(s=>['header','cell'].includes(s.field)).map(s=>t.cells.find(x=>x.id===s.locator.objectId)?.originalId),expectedIds,'all selected raw cells');
  } else if(c.chunkType==='equation') {
    const e=ir.equations.find(e=>e.id===c.objectId);content=e.data.rawLatex??ir.blocks.find(b=>b.blockId===e.blockId).text;
  } else if(c.chunkType==='figure') {
    const f=ir.figures.find(f=>f.id===c.objectId),b=ir.blocks.find(b=>b.blockId===f.blockId);
    content=[...(b.text?[b.text]:[]),...f.data.captions.filter(x=>x.status==='linked').map(x=>x.evidence.text)].join('\n');
  } else if(c.chunkType==='algorithm') {
    const a=ir.algorithms.find(a=>a.id===c.objectId);
    content=c.selection.steps?c.selection.steps.map(id=>a.steps.find(s=>s.id===id).text).join('\n'):a.text;
  }
  eq(c.content,content,'chunk independently reconstructed from source object');
  c.sources.forEach(s=>auditSource(ir,s));
}
function auditOutcome(o) {
  eq(o.resultHash,o.result===null?null:hash(o.result),'complete result hash');
  eq(o.error===null,o.result!==null,'error/result denominator');
  assert.ok(Number.isFinite(o.elapsedMs)&&o.elapsedMs>=0);
}
function auditSeedCompletion(seed,questions) {
  eq(seed.seedErrors,[],'seed completion requires no errors');
  eq(seed.seeded.length,45,'seed completion requires all45');
  eq(seed.seeded.map(s=>s.paperId).sort(),[...new Set(questions.map(q=>q.paperId))].sort(),'complete unique source seeds');
}
function auditSuccessfulD(o) {
  eq(o.error,null,'every D request must succeed');
  assert.ok(o.result!==null&&o.result!==undefined,'every D request requires a result');
}
function auditCompletionReceipt(done,gate,expected) {
  eq(gate,expected,'completion gate independently recomputed from full observations');
  eq(gate.passed,true);
  eq(done.completionGateSha256,sha(Buffer.from(JSON.stringify(gate,null,2)+'\n')),'completion binds persisted gate');
}
function auditControls(context) {
  const controls=[],reject=(name,fn)=>{assert.throws(fn,undefined,name);controls.push({name,rejected:true});};
  const d=context.dRows.find(r=>r.generic.result?.hits.length&&r.scientific.result?.hits.length);
  const sourceD=context.dRows.find(r=>r.scientific.result?.candidates.some(c=>c.object.kind==='table'));
  const clone=v=>structuredClone(v),rehash=r=>{for(const arm of ['generic','scientific'])if(r[arm])r[arm].resultHash=r[arm].result?hash(r[arm].result):null;return r;};
  let bad=clone(d);bad.question.publishedQuery+=' invented';reject('changed original query',()=>context.auditD(bad,d.question));
  bad=clone(d);bad.generic.result=null;bad.generic.resultHash=null;bad.generic.error={name:'SqliteError',code:'disk I/O error',sqliteCode:'SQLITE_IOERR_GETTEMPPATH'};
  reject('successful D replaced with real failure shape',()=>context.auditD(bad,d.question));
  bad=clone(context.seed);bad.seeded.pop();reject('missing seed hidden by completion',()=>auditSeedCompletion(bad,context.questions));
  bad=clone(context.seed);bad.seedErrors.push({paperId:bad.seeded[0].paperId,error:{code:'disk I/O error'}});
  reject('seed error hidden by complete seed count',()=>auditSeedCompletion(bad,context.questions));
  if(context.gate) {
    bad=clone(context.gate);bad.dSuccess.generic--;
    reject('forged successful completion gate',()=>auditCompletionReceipt(context.done,bad,context.gate));
  }
  bad=clone(d);bad.generic.result.ranking.candidates[0].score+=.2;rehash(bad);reject('rehash wrong generic RRF',()=>context.auditD(bad,d.question));
  bad=clone(sourceD);const table=bad.scientific.result.candidates.find(c=>c.object.kind==='table');table.object.cells[0].text='fabricated value';rehash(bad);
  reject('rehash fabricated table cell',()=>context.auditD(bad,sourceD.question));
  bad=clone(d);bad.scientific.result.candidates[0].sourceLocator&&(bad.scientific.result.candidates[0].sourceLocator.locations[0].page+=1);rehash(bad);
  // Metadata may lead the ranking. Corrupt the first physical chunk explicitly.
  const physical=bad.scientific.result.candidates.find(c=>c.chunkId);physical.sourceLocator.rawLocator+=' foreign';rehash(bad);
  reject('rehash foreign source locator',()=>context.auditD(bad,d.question));
  bad=clone(d);const c=bad.scientific.result.candidates.find(c=>c.signals.length);c.signals[0].rank+=1;rehash(bad);
  reject('rehash wrong multitype channel rank',()=>context.auditD(bad,d.question));
  const f=context.fRows.find(r=>r.scientific?.result?.evidence.length);
  bad=clone(f);bad.genericTokens=0;reject('whole JSON token undercharge',()=>context.auditF(bad,context.dRows.find(d=>d.question.id===f.question.id)));
  bad=clone(f);bad.scientific.result.evidence[0].passages.push({role:'explanation',text:'not in source',
    sourceLocator:clone(bad.chosen.sourceLocator)});rehash(bad);
  reject('rehash invented explanation',()=>context.auditF(bad,context.dRows.find(d=>d.question.id===f.question.id)));
  const u=context.objectRows.find(r=>r.status==='unavailable');
  if(u){bad=clone(u);bad.status='observed';reject('unavailable object promoted to success',()=>context.auditObject(bad));}
  const algorithm=context.objectRows.find(r=>r.selection.object.type==='algorithm'&&r.status==='observed');
  if(algorithm) {
    bad=clone(algorithm);bad.scientific.result.evidence[0].object.stepIds[0]='foreign-step';rehash(bad);
    reject('rehash fabricated algorithm step',()=>context.auditObject(bad));
  }
  reject('dropped preselected objects',()=>context.auditObjectInventory(context.objectRows.slice(1)));
  reject('duplicate original questions',()=>context.auditQuestionInventory([...context.dRows.slice(1),context.dRows[1]]));
  return controls;
}
export function verify(root,{controls=false}={}) {
  root=resolve(root);
  const task=resolve('.artifacts/scientific-rag/phase8-typed-retrieval-context-01');
  assert.ok(root.startsWith(task+'/'),'Verifier root must be in the task artifact tree');
  // Keep verifier-native SQLite temporary files in a fresh allowed directory,
  // before its first connection. Historical run directories remain untouched.
  process.env.SQLITE_TMPDIR=mkdtempSync(join(task,'verification-tmp-'));
  const protocol=read(join(root,'protocol.json')),lock=read(join(root,'protocol-lock.json'));
  eq(lock.sha256,sha(readFileSync(join(root,'protocol.json'))),'pre-execution manifest lock');
  assert.equal(lock.beforeDatabaseAndSearch,true);
  for(const p of protocol.sourcePins) {
    const b=readFileSync(p.path),s=statSync(p.path,{bigint:true});
    eq(b.length,p.bytes,p.path);eq(sha(b),p.sha256,p.path);eq(String(s.mtimeNs),p.mtimeNs,'source mtime '+p.path);
  }
  for(const p of protocol.copies){const b=readFileSync(join(root,p.path));eq(b.length,p.bytes);eq(sha(b),p.sha256);}
  for(const p of protocol.codePins){const b=readFileSync(join(root,'code',p.path));eq(b.length,p.bytes);eq(sha(b),p.sha256);}
  eq(sha(readFileSync(join(root,'runtime/typed.mjs'))),protocol.bundleSha256);
  if(protocol.version>=2) {
    eq(protocol.completionContract,'complete-observations-seed45-error0-D288-success-per-arm-v1');
    const freeze=read(join(root,'source-freeze.json'));
    eq(sha(readFileSync(join(root,'source-freeze.json'))),protocol.sourceFreezeSha256);
    for(const p of freeze.files) {
      assert.ok(!p.path.split('/').includes('..')&&!p.path.startsWith('/'));
      const b=readFileSync(join(root,'code',p.path));eq(b.length,p.bytes);eq(sha(b),p.sha256);
    }
    eq(protocol.environment.sqliteTmp,join(root,'sqlite-tmp'));
    eq(protocol.environment.configuredBeforeFirstConnection,true);
  }
  for(const p of protocol.derivedStructured) {
    const v=read(join(root,p.path)),raw=read(join(root,p.originalPath)),saved=read(p.savedContentPath);
    eq(v,{...raw,blocks:saved.blocks,quality:saved.quality},'only frozen typed fields overlaid');
    eq(sha(readFileSync(join(root,p.path))),p.sha256);
  }
  const originalRows=read(join(protocol.irRoot,'trial-0.json')).filter(r=>r.cohort===1);
  const sourceReport=read(protocol.sourceReport),sourceRun=read(sourceReport.cohorts[1].run);
  const raw=read(protocol.rawQuestionsPath),publicLock=read(protocol.publicLockPath);
  eq(protocol.papers.map(p=>p.paperId).sort(),[...publicLock.qasper.pdfCohort].sort(),'unchanged public45 cohort');
  const questions=originalRows.flatMap(r=>raw[sourceRun.rows[r.index].paperId].qas.map((q,i)=>({
    id:q.question_id,paperId:sourceRun.rows[r.index].paperId,publishedQuery:q.question,unqualified:true,originalQuestionIndex:i})));
  eq(protocol.questions,questions);eq(questions.length,288);
  const expectedObjects=[];
  for(const r of originalRows)if(r.status==='parsed') {
    const ir=read(join(protocol.irRoot,r.receipt.path));
    eq(sha(readFileSync(join(protocol.irRoot,r.receipt.path))),r.receipt.sha256);
    for(const [plural,type] of Object.entries({tables:'table',figures:'figure',equations:'equation',algorithms:'algorithm'}))
      for(const o of ir[plural])expectedObjects.push({paperId:sourceRun.rows[r.index].paperId,type,blockId:o.blockId,objectId:o.id});
  }
  eq(protocol.objects,expectedObjects,'complete source-only frozen inventory');eq(expectedObjects.length,483);
  const oldCohort=read('evaluation/corpora/scientific-rag/sciegqa-cohort.lock.json');
  const oldLabels=read('evaluation/local/corpora/sciegqa-bench-v1/labels.json');
  eq(protocol.sourceCohortMapping.length,45);
  for(const [i,m] of protocol.sourceCohortMapping.entries()) {
    const p=oldCohort.papers[i];eq(m.paperId,p.id);eq(m.sourceHash,p.pdf.sha256);
    assert.ok(!originalRows.some(r=>r.sourceHash===m.sourceHash));eq(m.status,'unavailable');
    eq(m.questions.map(q=>[q.id,q.publishedQuery]),p.questions.map(q=>[q.id,oldLabels.find(l=>l.id===q.id).original.query]));
  }
  eq(protocol.sourceCohortMapping.flatMap(r=>r.questions).length,225);
  const dbPath=join(root,'research.sqlite'),dbHash=sha(readFileSync(dbPath)),seed=read(join(root,'seed.json'));
  const db=new Database(dbPath,{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
  const sql=(s,...p)=>db.prepare(s).all(...p),one=(s,...p)=>db.prepare(s).get(...p);
  const catalog=new Map(),bySeed=new Map(seed.seeded.map(s=>[s.paperId,s]));
  const versions=id=>{
    const c=one('SELECT * FROM research_knowledge_chunks WHERE id=?',id),d=one('SELECT * FROM research_knowledge_documents WHERE id=?',c.document_id);
    const semantic=JSON.parse(one('SELECT metadata_json FROM research_knowledge_chunk_semantics WHERE chunk_id=?',id).metadata_json);
    eq(sha(d.content),d.content_hash);
    return {chunkId:id,documentId:c.document_id,locator:c.locator,chunkHash:c.content_hash,indexedVersion:hash({
      document_id:c.document_id,content_hash:c.content_hash,locator:c.locator,project_id:c.project_id,
      document_hash:d.content_hash,document_project:d.project_id,title:d.title,source_type:d.source_type,
      source_id:d.source_id,metadata_json:d.metadata_json,semantic})};
  };
  const irTypes={},chunkTypes={};let totalChunks=0,retrievable=0,blocks=0,sourcePassages=0;
  try {
    auditSeedCompletion(seed,questions);
    for(const s of seed.seeded) {
      const r=originalRows.find(r=>r.sourceHash===s.sourceHash),rawIR=read(join(protocol.irRoot,r.receipt.path));
      const original=read(join(protocol.irRoot,r.contentPath)),g=one('SELECT * FROM research_scientific_index_generations WHERE id=?',s.generationId);
      eq(g.status,'active');eq(g.source_hash,r.sourceHash);eq(g.parse_id,`typed-public:${s.paperId}:${r.receipt.identity.parseHash}`);
      const snapshot=JSON.parse(g.snapshot_json);eq(hash(snapshot),g.snapshot_hash);eq(snapshot.paperIR,s.paperIR);eq(snapshot.embedding,null);
      const b=readFileSync(join(root,s.paperIR.path)),ir=JSON.parse(b);eq(b.length,s.paperIR.size);eq(sha(b),s.paperIR.sha256);
      const publication=one('SELECT * FROM research_document_parses WHERE id=?',g.parse_id);eq(publication.status,'ready');
      const data=JSON.parse(publication.data_json);eq(hash(data.content),ir.identity.parseHash);eq(data.content.quality,original.quality);
      eq(ir.blocks.length,rawIR.blocks.length);blocks+=ir.blocks.length;
      const originalStructured=protocol.derivedStructured.find(x=>x.paperId===s.paperId);
      const structured=read(join(root,originalStructured.path)),coordinate=one('SELECT * FROM research_document_parse_coordinates WHERE parse_id=?',g.parse_id);
      const coords=JSON.parse(coordinate.snapshot_json);eq(hash(coords),coordinate.snapshot_hash);eq(coords.parseHash,ir.identity.parseHash);
      eq(coords.pages,structured.pages.map(p=>({page:p.page,frame:p.coordinateFrame})));
      for(const [i,rawBlock] of original.blocks.entries()) {
        const stored=data.content.blocks[i],{imagePath,...raw}=rawBlock,{imageAssetId,...actual}=stored;
        eq(withoutAsset(actual),withoutAsset(raw),'all original enhanced block fields retained');
        if(imagePath!==null)eq(data.files[imageAssetId],imagePath);
        const block=ir.blocks[i];eq(block.text,rawBlock.text);eq(block.kind,rawBlock.kind);eq(block.blockId,rawBlock.id);
        eq(block.sourceLocator.rawLocator,rawBlock.locator);eq(block.sourceLocator.locations,rawBlock.locations);
        auditSource(ir,{sourceLocator:block.sourceLocator,text:block.text});
      }
      for(const plural of ['tables','figures','equations','algorithms']) {
        eq(ir[plural].length,rawIR[plural].length,'objects retained '+plural);irTypes[plural]=(irTypes[plural]??0)+ir[plural].length;
        for(const o of ir[plural]) {
          const raw=rawIR[plural].find(x=>x.blockId===o.blockId);assert.ok(raw);
          if(o.data)eq(withoutAsset(o.data),withoutAsset(raw.data),'raw typed data '+plural);
          if(o.visual)eq(withoutAsset(o.visual),withoutAsset(raw.visual));
          if(o.cells) {
            eq(o.cells.length,raw.cells.length);
            for(const [i,c] of o.cells.entries()) {
              for(const k of ['originalId','row','column','text'])eq(c[k],raw.cells[i][k],'source table '+k);
              eq(c.sourceLocator.locations,raw.cells[i].sourceLocator.locations);auditSource(ir,{locator:c.sourceLocator,text:c.text,field:'cell'});
            }
          }
          if(o.steps) {
            eq(o.text,raw.text);eq(o.steps.length,raw.steps.length);
            for(const [i,step] of o.steps.entries()) {
              eq(step.text,raw.steps[i].text);eq(step.sourceLocator.textSpan,raw.steps[i].sourceLocator.textSpan);
              auditSource(ir,{locator:step.sourceLocator,text:step.text,field:'step'});
            }
          }
        }
      }
      const rawChunks=sql('SELECT * FROM research_scientific_chunks WHERE generation_id=? ORDER BY ordinal',g.id);
      const chunks=rawChunks.map(c=>JSON.parse(c.chunk_json));eq(hash(chunks),g.chunks_hash);eq(chunks.length,g.chunk_count);
      totalChunks+=chunks.length;retrievable+=chunks.filter(c=>c.retrieval).length;eq(chunks.filter(c=>c.retrieval).length,g.retrievable_count);
      const generic=sql('SELECT * FROM research_knowledge_chunks WHERE document_id=? ORDER BY chunk_index',s.knowledgeDocumentId);
      eq(generic.map(c=>c.id),chunks.filter(c=>c.retrieval).map(c=>c.id),'complete identical chunk set');
      for(const [i,c] of chunks.entries()) {
        const row=rawChunks[i];eq(hash(c),row.chunk_hash);eq(row.content_hash,sha(c.content));eq(row.embedding_text_hash,sha(c.embeddingText));
        eq(c.contentHash,sha(c.content));eq(c.embeddingTextHash,sha(c.embeddingText));eq(JSON.parse(row.locator_json),c.sourceLocator);
        auditSource(ir,{locator:c.sourceLocator});auditSerialized(ir,c);sourcePassages+=c.sources.length;
        chunkTypes[c.chunkType]=(chunkTypes[c.chunkType]??0)+1;
        if(c.retrieval) {
          verifyChunkProjection(generic.find(x=>x.id===c.id),c);
          eq(one('SELECT content FROM research_scientific_fts WHERE generation_id=? AND chunk_id=?',g.id,c.id).content,c.embeddingText);
        }
      }
      eq(sql('SELECT * FROM research_scientific_fts WHERE generation_id=?',g.id).length,g.retrievable_count);
      const relations=sql('SELECT chunk_id,relation_id,relation_json FROM research_scientific_chunk_relations WHERE generation_id=?',g.id)
        .sort((a,b)=>a.chunk_id.localeCompare(b.chunk_id)||a.relation_id.localeCompare(b.relation_id));eq(hash(relations),g.relations_hash);
      catalog.set(g.id,{g,ir,chunks,snapshot,seed:s});
    }
    for(const t of ['research_knowledge_embeddings','research_scientific_embeddings','research_embedding_cache','research_embedding_configs'])
      eq(one(`SELECT count(*) AS n FROM ${t}`).n,0);
    const dRows=questions.map((q,i)=>read(join(root,`d-query-${i}.json`)));
    const auditQuestionInventory=rows=>{eq(rows.length,questions.length);eq(rows.map(r=>r.question),questions);eq(new Set(rows.map(r=>r.question.id)).size,questions.length);};
    auditQuestionInventory(dRows);
    const channelStats={};
    const auditD=(row,q)=>{
      eq(row.question,q,'original query identity/order');
      const s=bySeed.get(q.paperId),cat=catalog.get(s.generationId);
      for(const arm of ['generic','scientific']) {
        const o=row[arm];auditOutcome(o);auditSuccessfulD(o);
        eq(o.request.query,q.publishedQuery.trim());eq(o.request.limit,20);eq(o.request.candidateLimit,80);
        eq(o.request.embeddingConfigId,null);eq(o.request.rerank,'none');eq(o.request.projectId,seed.projectId);
      }
      eq(row.generic.request.documentId,s.knowledgeDocumentId);eq(row.scientific.request.documentIds,[s.documentId]);
      if(row.generic.result) {
        const match=q.publishedQuery.trim().split(/\s+/u).map(t=>t.replaceAll('"','')).filter(Boolean).map(t=>`"${t}"`).join(' OR ');
        const content=sql(`SELECT c.id,c.chunk_index,bm25(research_knowledge_chunks_fts) AS score FROM research_knowledge_chunks_fts
          JOIN research_knowledge_chunks c ON c.rowid=research_knowledge_chunks_fts.rowid
          WHERE research_knowledge_chunks_fts MATCH ? AND c.document_id=? ORDER BY score,c.chunk_index`,match,s.knowledgeDocumentId);
        const title=sql(`SELECT bm25(research_knowledge_documents_fts,5.0,0.0) AS score FROM research_knowledge_documents_fts
          JOIN research_knowledge_documents d ON d.rowid=research_knowledge_documents_fts.rowid
          WHERE research_knowledge_documents_fts MATCH ? AND d.id=?`,`title : (${match})`,s.knowledgeDocumentId);
        const ids=new Set(content.map(c=>c.id)),extra=title.length?sql('SELECT id FROM research_knowledge_chunks WHERE document_id=? ORDER BY chunk_index',s.knowledgeDocumentId).filter(c=>!ids.has(c.id)):[];
        verifyGenericRanking(row.generic.result,[...content,...extra].slice(0,80).map(c=>c.id),versions);
      }
      if(!row.scientific.result)return;
      const r=row.scientific.result,plan=r.plan,ts=terms(q.publishedQuery);
      eq(plan.query,q.publishedQuery.trim());eq(plan.scope.projectId,seed.projectId);assert.ok(plan.scope.documentIds.every(id=>id===s.documentId));
      eq(plan.observation.calls,0);eq(plan.observation.providerId,null);eq(plan.observation.modelId,null);
      eq(r.snapshot.id,hash(r.snapshot.generations));
      for(const receipt of r.snapshot.generations) {
        eq(receipt.generationId,s.generationId);eq(receipt.paperIR,cat.snapshot.paperIR);eq(receipt.chunksHash,cat.g.chunks_hash);
        eq(receipt.relationsHash,cat.g.relations_hash);eq(receipt.embedding,null);
      }
      eq(r.channels.map(c=>c.channel),plan.retrievalChannels);
      eq(r.ranking.method,'rrf');eq(r.ranking.k,60);eq(r.ranking.reranker.status,'not_requested');eq(r.ranking.rerank,null);
      const expected=new Map();
      const match=ts.map(t=>`"${t}"`).join(' OR ');
      const fts=r.snapshot.generations.length&&match?sql(`SELECT chunk_id AS id,bm25(research_scientific_fts) AS score FROM research_scientific_fts
        WHERE research_scientific_fts MATCH ? AND generation_id=? AND chunk_id IN
        (SELECT id FROM research_scientific_chunks WHERE generation_id=? AND chunk_type IN ('paragraph','algorithm','caption'))
        ORDER BY score,generation_id,chunk_id LIMIT 80`,match,s.generationId,s.generationId):[];
      expected.set('text',fts.map((c,i)=>({id:c.id,rank:i+1,score:c.score,method:'fts'})));
      const candidateId=c=>`scientific-candidate:${hash([s.generationId,c.id])}`;
      for(const channel of plan.retrievalChannels.filter(x=>['table','figure','equation'].includes(x))) {
        const nums=plan.objects[channel==='table'?'tableNumbers':channel==='figure'?'figureNumbers':'equationNumbers'];
        const candidates=[];
        if(plan.scope.documentIds.length)for(const c of cat.chunks) {
          if(!c.retrieval||!(channel==='table'?['table','table_row_group'].includes(c.chunkType):c.chunkType===channel))continue;
          if(c.chunkType==='table'&&cat.chunks.some(x=>x.parentId===c.id&&x.chunkType==='table_row_group'))continue;
          const o=rawObject(cat.ir,c),number=o.kind==='table'?o.number:o.kind==='figure'?o.data.objectNumber:o.data.equationNumber;
          const exact=nums.length>0&&nums.includes(numbered(number));if(nums.length&&!exact)continue;
          const refs=['figure','equation'].includes(o.kind)?o.data.references.map(r=>r.evidence.text).join('\n'):'';
          const searchable=`${c.embeddingText}\n${refs}`,score=lexical(searchable,ts);
          if(channel==='table'&&(plan.filters.metrics.length&&!plan.filters.metrics.some(t=>lexical(searchable,[t]))||
            plan.filters.datasets.length&&!plan.filters.datasets.some(t=>lexical(searchable,[t]))))continue;
          if(!exact&&ts.length&&!score)continue;candidates.push({id:c.id,candidateId:candidateId(c),score,exact});
        }
        expected.set(channel,candidates.sort((a,b)=>Number(b.exact)-Number(a.exact)||b.score-a.score||a.candidateId.localeCompare(b.candidateId))
          .slice(0,80).map((c,i)=>({id:c.id,rank:i+1,score:c.score,method:c.exact?'exact':'lexical'})));
      }
      const metadata=cat.ir.metadata,metadataScore=lexical(JSON.stringify(metadata),ts);
      const metadataExpected=plan.scope.documentIds.length&&!(plan.filters.years.length&&!plan.filters.years.includes(metadata.year))&&
        !(plan.filters.dois.length&&!plan.filters.dois.includes(metadata.doi))?[{id:null,rank:1,score:metadataScore,method:'exact'}]:[];
      expected.set('metadata',metadataExpected);expected.set('citation',[]);
      for(const ch of r.channels) {
        eq(ch.limit,80);assert.ok(ch.elapsedMs>=0);eq(ch.returned,(expected.get(ch.channel)??[]).length,'complete raw channel '+ch.channel);
        const observed=r.candidates.flatMap(c=>c.signals.filter(s=>s.channel===ch.channel).map(signal=>({id:c.chunkId,...signal})))
          .sort((a,b)=>a.rank-b.rank).map(({channel,...x})=>x);
        eq(observed,expected.get(ch.channel)??[],'raw channel rank/lexical score/exact match '+ch.channel);
      }
      const unique=new Set();
      for(const c of r.candidates) {
        assert.ok(!unique.has(c.id));unique.add(c.id);eq(c.generationId,s.generationId);eq(c.documentId,s.documentId);
        eq(sha(c.content),c.contentHash);
        if(c.chunkId!==null) {
          const chunk=cat.chunks.find(x=>x.id===c.chunkId);assert.ok(chunk?.retrieval);
          eq(c.id,candidateId(chunk));
          for(const k of ['documentId','paperId','objectId','selection','sectionPath','content','contentHash','sourceLocator','sources','relationIds'])eq(c[k],chunk[k],'candidate source '+k);
          eq(c.objectType,chunk.chunkType);eq(c.object,rawObject(cat.ir,chunk),'raw typed object projection');
          eq(c.semanticRoles,chunk.semantic.roles.map(r=>r.role));
        } else {eq(c.object,{kind:'metadata',metadata:cat.ir.metadata});eq(c.content,JSON.stringify(cat.ir.metadata));}
        close(c.score,c.signals.reduce((n,s)=>n+1/(60+s.rank),0),'scientific RRF');
      }
      eq(r.candidates,[...r.candidates].sort((a,b)=>cmp(a,b,plan)));eq(r.hits,r.candidates.slice(0,20));
    };
    for(const r of dRows) {
      auditD(r,r.question);
      for(const ch of r.scientific.result?.channels??[]) {
        const s=channelStats[ch.channel]??={requests:0,returned:0,empty:0,degraded:0};
        s.requests++;s.returned+=ch.returned;s.empty+=Number(!ch.returned);s.degraded+=Number(ch.status==='degraded');
      }
    }
    const auditF=(f,d,candidate=d.scientific.result?.hits.find(h=>h.chunkId!==null))=>{
      eq(f.question,d.question);eq(f.wholePayloadTokenLimit,8000);
      if(!candidate){eq(f.status,'unavailable');assert.ok(!f.generic&&!f.scientific);return;}
      eq(f.status,'observed');const c=candidate,cat=catalog.get(c.generationId);
      eq(f.chosen,{candidateId:c.id,chunkId:c.chunkId,objectId:c.objectId,objectType:c.objectType,sourceLocator:c.sourceLocator,generationId:c.generationId});
      eq(f.generic.request,{projectId:seed.projectId,chunkId:c.chunkId,expectedIndexedVersion:versions(c.chunkId).indexedVersion,maxChars:8000,neighbors:false});
      eq(f.scientific.request,{search:d.scientific.result,candidateIds:[c.id],
        budget:{maxObjects:1,maxParagraphs:1,maxTokens:7000,maxImages:0,maxImageDimension:2048,maxEvidencePerPaper:1}});
      for(const arm of ['generic','scientific']) {
        auditOutcome(f[arm]);eq(f[`${arm}Tokens`],f[arm].result?tokens(f[arm].result):null,'whole returned JSON tokens');
      }
      eq(f.budgetAccepted,f.genericTokens!==null&&f.scientificTokens!==null&&f.genericTokens<=8000&&f.scientificTokens<=8000);
      if(f.generic.result) {
        eq(f.generic.result.context.content,c.content.slice(0,8000),'generic production char cap');
        eq(f.generic.result.context.chunkId,c.chunkId);eq(f.generic.result.neighbors,[]);
      }
      if(f.scientific.result) {
        const r=f.scientific.result;eq(r.query,d.question.publishedQuery.trim());eq(r.snapshotId,d.scientific.result.snapshot.id);
        eq(r.selectedCandidateIds,[c.id]);eq(r.usage.tokens,tokens(r.evidence));assert.ok(r.usage.tokens<=7000);eq(r.usage.images,0);
        assert.ok(r.evidence.length<=1);
        for(const e of r.evidence) {
          eq(e.object,c.object,'raw object survives F');eq(e.candidateIds,[c.id]);eq(e.hits.length,1);
          eq(e.hits[0],{chunkId:c.chunkId,selection:c.selection,content:c.content,sources:c.sources});
          e.hits[0].sources.forEach(s=>auditSource(cat.ir,s));e.passages.forEach(s=>auditSource(cat.ir,s));eq(e.image,null);
          const {id,...body}=e;eq(id,`scientific-evidence:${hash(body)}`);
        }
        const {id,...body}=r;eq(id,hash(body));
      }
    };
    const fRows=questions.map((q,i)=>read(join(root,`f-query-${i}.json`)));
    fRows.forEach((f,i)=>auditF(f,dRows[i]));
    const objectRows=expectedObjects.map((o,i)=>read(join(root,`f-object-${i}.json`)));
    const auditObject=f=>{
      const o=f.selection.object;assert.ok(expectedObjects.some(x=>hash(x)===hash(o)),'frozen object identity');
      const paperRows=dRows.filter(r=>r.question.paperId===o.paperId);
      const attempts=paperRows.map(r=>({questionId:r.question.id,error:r.scientific.error,
        candidateIds:r.scientific.result?.candidates.filter(c=>c.sourceLocator?.blockId===o.blockId&&c.object.kind===o.type).map(c=>c.id)??[]}));
      eq(f.selection.attempts,attempts,'every original attempt retained');
      const first=paperRows.map(d=>({d,c:d.scientific.result?.candidates.find(c=>c.chunkId!==null&&c.sourceLocator?.blockId===o.blockId&&c.object.kind===o.type)})).find(r=>r.c);
      // null preserves the absence of this object. undefined would invoke
      // auditF's query default and select an unrelated returned chunk.
      auditF(f,first?.d??paperRows[0],first?.c??null);
    };
    const auditObjectInventory=rows=>{eq(rows.map(r=>r.selection.object),expectedObjects);eq(rows.length,483);};
    auditObjectInventory(objectRows);objectRows.forEach(auditObject);
    const counts=arm=>({requests:dRows.length,errors:dRows.filter(r=>r[arm].error).length,
      empty:dRows.filter(r=>r[arm].result?.hits.length===0).length,nonempty:dRows.filter(r=>r[arm].result?.hits.length).length,
      candidates:dRows.reduce((n,r)=>n+(arm==='generic'?r.generic.result?.ranking.candidates.length??0:r.scientific.result?.candidates.length??0),0)});
    const dr=read(join(root,'d-report.json'));eq(dr.generic,counts('generic'));eq(dr.scientific,counts('scientific'));
    eq(dr.queries,288);eq(dr.scientificMetrics,null);eq(dr.answerMetrics,null);eq(dr.providerAttempts,0);
    eq(dr.dbBeforeSha256,dbHash);eq(dr.dbAfterSha256,dbHash);eq(dr.totalChangesUnchanged,true);
    const fr=read(join(root,'f-report.json'));eq(fr.query,count(fRows));eq(fr.objects,count(objectRows));
    const objectTypes=Object.fromEntries(['table','figure','equation','algorithm'].map(t=>[t,count(objectRows.filter(f=>f.selection.object.type===t))]));
    eq(fr.objectTypes,objectTypes);eq(fr.qualityMetrics,null);
    const done=read(join(root,'completion.json'));eq(done.networkAttempts,0);eq(done.modelCalls,0);eq(done.ocrCalls,0);eq(done.scientificMetrics,null);
    eq(done.networkCalls,0);eq(done.productionWrites,0);eq(done.indexRefreshOriginal,0);eq(done.scientificE2E,false);
    eq(done.sourceUnchanged,true);eq(done.result.d,dr);
    const sourceReadback=read(join(root,'source-readback.json'));eq(sourceReadback.sourceUnchanged,true);eq(sourceReadback.changed,[]);
    eq(sourceReadback.checked,protocol.sourcePins.length);
    let gate=null;
    if(protocol.version>=2) {
      gate=read(join(root,'completion-gate.json'));
      const expected={version:1,contract:protocol.completionContract,observationsWritten:true,seeded:seed.seeded.length,
        seedErrors:seed.seedErrors.length,dRows:dRows.length,
        dSuccess:Object.fromEntries(['generic','scientific'].map(a=>[a,dRows.filter(r=>r[a].error===null&&r[a].result!==null).length])),
        fQueryRows:fRows.length,fObjectRows:objectRows.length,passed:true,failures:[]};
      auditCompletionReceipt(done,gate,expected);
    }
    const controlResults=controls?auditControls({auditD,auditF,auditObject,auditObjectInventory,auditQuestionInventory,
      dRows,fRows,objectRows,seed,questions,gate,done}):null;
    eq(one('SELECT total_changes() AS n').n,0);db.close();eq(sha(readFileSync(dbPath)),dbHash);
    const allF=[...fRows,...objectRows];
    return {status:'Verified passing',scope:'Frozen QASPER45 typed D/F production engineering and independent rawSQL/originalIR/locator/fullJSONtoken readback',
      root,papers:45,questions:288,objects:483,sourceCohortMapping:{oldSciEGQAPapers:45,oldSciEGQAQuestions:225,unavailable:45,substitutions:0},
      sourcePins:protocol.sourcePins.length,copies:protocol.copies.length,codePins:protocol.codePins.length,blocks,totalChunks,retrievable,sourcePassages,irTypes,chunkTypes,
      d:{generic:counts('generic'),scientific:counts('scientific'),channels:channelStats,
        latencyMs:Object.fromEntries(['generic','scientific'].map(a=>[a,stats(dRows.map(r=>r[a].elapsedMs))]))},
      f:{query:count(fRows),objects:count(objectRows),objectTypes,outsideTop20:objectRows.filter(f=>f.chosen&&!dRows.find(d=>d.question.id===f.question.id).scientific.result.hits.some(c=>c.id===f.chosen.candidateId)).length,
        tokens:Object.fromEntries(['generic','scientific'].map(a=>[a,stats(allF.map(f=>f[`${a}Tokens`]).filter(n=>n!==null&&n!==undefined))]))},
      controls:controlResults,databaseSha256:dbHash,sourceWrites:0,readbackDatabaseWrites:0,networkCalls:0,modelCalls:0,ocrCalls:0,
      scientificMetrics:null,answerMetrics:null,qualityGold:null,scientificE2E:false};
  }finally{if(db.open)db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const start=performance.now(),root=resolve('.artifacts/scientific-rag/phase8-typed-retrieval-context-01',process.argv[2]??'run-02');
  const output=process.argv[3]&&!process.argv[3].startsWith('--')?resolve(process.argv[3]):null;
  if(output)assert.ok(output.startsWith(resolve('.artifacts/scientific-rag/phase8-typed-retrieval-context-01')+'/'),
    'Verifier output must be in the task artifact tree');
  try {
    const result=verify(root,{controls:process.argv.includes('--controls')});result.elapsedMs=performance.now()-start;
    if(output)writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify(result));
  }catch(e) {
    const failure={status:'Changed, unverified',error:e.message,stack:e.stack,elapsedMs:performance.now()-start};
    if(output)writeFileSync(output,JSON.stringify(failure,null,2)+'\n',{flag:'wx'});
    console.error(e.stack);process.exitCode=1;
  }
}
