import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {load} from 'sqlite-vec';
import {applyAgentDatabaseSchema, applyResearchDatabaseSchema} from '../../src/main/infrastructure/database-schemas';
import {ResearchRepository} from '../../src/main/plugins/research/repository';
import {ResearchTaskRepository} from '../../src/main/plugins/research/research-task-repository';
import {ResearchEmbeddingService} from '../../src/main/plugins/research/embedding-service';
import {OpenAICompatibleEmbeddingClient} from '../../src/main/plugins/research/embedding-client';
import {ScientificRetrievalRouter} from '../../src/main/plugins/research/scientific-retrieval-router';
import {ScholarlyRelationsRepository} from '../../src/main/plugins/research/scholarly-relations-repository';
import {collectDocumentContent} from '../../src/main/plugins/research/document-files';
import {PaperIRRepository} from '../../src/main/plugins/research/paper-ir-repository';
import {keywordTextV1} from '../../src/main/plugins/research/knowledge-keywords';
import {chunkTokenCount} from '../../src/main/plugins/research/knowledge-chunks';
import {paperChunkSchema} from '../../src/shared/schemas/research-paper-ir';
import {scientificRole} from '../../src/main/plugins/research/paper-ir';
import type {SciegqaParsedSource} from './production-sciegqa-retrieval';
import type {ScientificSearchResult} from '../../src/shared/schemas/research-scientific-search';

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const digest = (v: unknown): string => sha(JSON.stringify(v));
const save = async (p: string, v: unknown): Promise<void> => {await writeFile(p, JSON.stringify(v, null, 2)+'\n', {flag:'wx'});};
const failure = (e: unknown) => ({name:e instanceof Error ? e.name : 'Error',
  code:e instanceof Error ? e.message : String(e),
  sqliteCode:e instanceof Error && 'code' in e && typeof e.code==='string' ? e.code : null,
  stack:e instanceof Error ? e.stack : null});
type Source = SciegqaParsedSource & {sourcePath:string;outputPath:string};
type Question = {id:string;paperId:string;publishedQuery:string;unqualified:boolean};
type Outcome<T> = {request:unknown;result:T|null;resultHash:string|null;error:ReturnType<typeof failure>|null;elapsedMs:number};
async function observed<T>(request:unknown, call:()=>T|Promise<T>):Promise<Outcome<T>> {
  const start=performance.now();
  try {const result=await call();return {request,result,resultHash:digest(result),error:null,elapsedMs:performance.now()-start};}
  catch(e) {return {request,result:null,resultHash:null,error:failure(e),elapsedMs:performance.now()-start};}
}

/** No answers, reference evidence or providers enter this runtime. */
export async function runMatched(root:string,sources:Source[],questions:Question[],includeF:boolean, objects:Array<{paperId:string;type:string;blockId:string;objectId:string}>) {
  assert.equal(sources.length,45);assert.equal(questions.length,288);
  const db=new Database(join(root,'research.sqlite')),agent=new Database(join(root,'agent.sqlite'));
  load(db);db.pragma('foreign_keys=ON');applyResearchDatabaseSchema(db);applyAgentDatabaseSchema(agent);
  const repository=new ResearchRepository(db,new ResearchTaskRepository(agent));
  const project=repository.createProject({title:'QASPER45 typed keyword',description:'Isolated engineering D/F',workspacePath:root});
  let providerAttempts=0;
  const denied=async():Promise<never>=>{providerAttempts++;throw new Error('matched_model_or_network_forbidden');};
  const embeddings=new ResearchEmbeddingService(repository.knowledge,new OpenAICompatibleEmbeddingClient(denied),
    {secrets:{get:denied,set:denied,clear(){providerAttempts++;throw new Error('matched_secret_forbidden');}},
      logger:{info(){},warn(){},error(){}}});
  assert.equal(embeddings.selectedIdentity(null),null);
  const router=new ScientificRetrievalRouter(repository,embeddings,{library:root,index:null},
    new ScholarlyRelationsRepository(db,repository),null,null);
  const seeded:Array<{paperId:string;documentId:string;knowledgeDocumentId:string;generationId:string;
    sourceHash:string;resultHash:string;chunksHash:string;paperIR:unknown;retrievable:number}>=[];
  const seedErrors:unknown[]=[];
  const byPaper=new Map<string,typeof seeded[number]>();
  try {
    for(const source of sources) {
      try {
        const bytes=await readFile(join(root,source.sourcePath));assert.equal(sha(bytes),source.sourceHash);
        const time='2026-11-17T00:00:00.000Z';
        const metadata={id:source.id,source:'local' as const,externalId:source.id,title:source.title,authors:[],doi:null,
          abstract:null,publishedYear:null,citationCount:null,url:source.sourceUri,openAccessUrl:null,importedAt:time,updatedAt:time};
        const bibliography={citationKey:source.id,entryType:'article',fields:{title:source.title},preambles:[],csl:null,
          title:source.title,authors:[],doi:null,publishedYear:null,abstract:null,url:source.sourceUri};
        const doc=repository.documents.import({id:source.id,libraryItemId:null,projectId:project.id,
          filename:source.title+'.pdf',mediaType:'application/pdf',sourcePath:source.sourcePath,
          sourceHash:source.sourceHash,size:bytes.length,entry:{metadata,bibliography}},false).document;
        const {data,coordinates}=await collectDocumentContent(root,join(root,source.outputPath),source.parsed);
        assert.ok(data.content.quality,'enhanced saved quality required');
        repository.documents.begin(doc.id,source.parseId);
        const ir=repository.documents.buildPaperIR(doc.id,source.parseId,data);
        const receipt=await new PaperIRRepository(root).publish(ir);data.paperIR=receipt;
        const generation=repository.scientificIndex.begin({ir,paperIR:receipt,projectId:null,
          source:{kind:'library'},embedding:null});
        repository.scientificIndex.publish(generation.id,()=>({paperIR:receipt,embedding:null}),
          ()=>repository.documents.complete(doc.id,source.parseId,data,coordinates));
        const chunks=repository.scientificIndex.chunks(generation.id,null).filter(c=>c.retrieval);
        const knowledgeId=ir.identity.knowledgeDocumentId;
        // Adapter projection fixes the chunk set. This intentionally does not benchmark generic rechunking.
        // Production readers/FTS/routing and their indexed-version receipts are unchanged.
        db.transaction(()=>{
          db.prepare('DELETE FROM research_knowledge_chunks WHERE document_id=?').run(knowledgeId);
          const insert=db.prepare(`INSERT INTO research_knowledge_chunks
            (id,document_id,project_id,chunk_index,content,locator,content_hash,created_at) VALUES (?,?,NULL,?,?,?,?,?)`);
          const semantic=db.prepare('INSERT INTO research_knowledge_chunk_semantics VALUES (?,?)');
          const structure=db.prepare('INSERT INTO research_knowledge_chunk_structure VALUES (?,NULL,0,?,?)');
          const keyword=db.prepare('INSERT INTO research_knowledge_keywords(rowid,content,title) VALUES (?,?,?)');
          const original=db.prepare('SELECT metadata_json FROM research_knowledge_documents WHERE id=?').pluck().get(knowledgeId);
          const fields={...JSON.parse(String(original)),matchedGenerationId:generation.id,
            matchedChunksHash:generation.chunksHash,matchedProjection:'retrievable-scientific-chunks-verbatim'};
          db.prepare('UPDATE research_knowledge_documents SET metadata_json=? WHERE id=?').run(JSON.stringify(fields),knowledgeId);
          chunks.forEach((chunk,index)=>{
            const block=ir.blocks.find(b=>b.blockId===chunk.sourceLocator.blockId)!;
            const meta=paperChunkSchema.parse({paperId:chunk.paperId,parseId:chunk.parseId,sourceHash:source.sourceHash,
              blockId:block.blockId,blockKind:block.kind,sectionPath:chunk.sectionPath.slice(0,12),
              semanticRole:scientificRole(chunk.sectionPath.join(' / ')),relatedBlockIds:[],scientific:chunk.semantic});
            const added=insert.run(chunk.id,knowledgeId,index,chunk.content,JSON.stringify(chunk.sourceLocator),chunk.contentHash,time);
            semantic.run(chunk.id,JSON.stringify(meta));
            if(chunk.content.length)structure.run(chunk.id,chunk.content.length,chunk.sectionPath.join(' / ')||null);
            keyword.run(added.lastInsertRowid,keywordTextV1(chunk.content),keywordTextV1(source.title));
          });
        })();
        const item={paperId:source.id,documentId:doc.id,knowledgeDocumentId:knowledgeId,generationId:generation.id,
          sourceHash:source.sourceHash,resultHash:source.resultHash,chunksHash:generation.chunksHash,
          paperIR:receipt,retrievable:chunks.length};
        seeded.push(item);byPaper.set(source.id,item);
        console.log(JSON.stringify({stage:'seed',papers:seeded.length,paperId:source.id,chunks:chunks.length}));
      }catch(e) {seedErrors.push({paperId:source.id,error:failure(e)});}
    }
    await repository.knowledgeJobs.idle();await repository.paperCards.idle();await repository.wiki.idle();
    await repository.knowledgeJobs.shutdown();await repository.paperCards.shutdown();await repository.wiki.shutdown();
    const tables=['research_knowledge_embeddings','research_embedding_cache','research_embedding_configs','research_scientific_embeddings'];
    const modelState=Object.fromEntries(tables.map(t=>[t,db.prepare(`SELECT count(*) FROM ${t}`).pluck().get()]));
    assert.ok(Object.values(modelState).every(n=>n===0));
    assert.equal(providerAttempts,0);
    await save(join(root,'seed.json'),{projectId:project.id,seeded,seedErrors,modelState,
      projection:'All retrievable generation chunks copied with identical id/content/hash/locator; generic parents intentionally absent.'});
    db.pragma('wal_checkpoint(TRUNCATE)');db.pragma('query_only=ON');
    const changesBefore=db.prepare('SELECT total_changes() AS n').get();
    const dbBefore=sha(await readFile(join(root,'research.sqlite')));
    const rows:Array<{question:Question;generic:Outcome<ReturnType<ResearchRepository['knowledge']['searchKnowledge']>>;
      scientific:Outcome<ScientificSearchResult>}>=[];
    for(const [i,q] of questions.entries()) {
      const seed=byPaper.get(q.paperId),query=q.publishedQuery.trim();
      const common={projectId:project.id,query,embeddingConfigId:null,candidateLimit:80,limit:20,rerank:'none' as const};
      const genericRequest={...common,documentId:seed?.knowledgeDocumentId??`unavailable:${q.paperId}`};
      const scientificRequest={...common,documentIds:[seed?.documentId??q.paperId]};
      const generic=await observed(genericRequest,()=>repository.knowledge.searchKnowledge({request:genericRequest,vector:null}));
      const scientific=await observed(scientificRequest,()=>router.search(scientificRequest));
      const row={question:q,generic,scientific};rows.push(row);
      await save(join(root,`d-query-${i}.json`),row);
      if((i+1)%25===0)console.log(JSON.stringify({stage:'D',queries:i+1,total:questions.length}));
    }
    const counts=(arm:'generic'|'scientific')=>({requests:rows.length,errors:rows.filter(r=>r[arm].error).length,
      empty:rows.filter(r=>r[arm].result?.hits.length===0).length,
      nonempty:rows.filter(r=>(r[arm].result?.hits.length??0)>0).length,
      candidates:rows.reduce((n,r)=>n+(arm==='generic'?r.generic.result?.ranking.candidates.length??0:r.scientific.result?.candidates.length??0),0)});
    const d={kind:'matched-D-generic-vs-multitype-keyword-engineering',queries:questions.length,papers:45,
      unqualifiedQueries:questions.filter(q=>q.unqualified).length,seededPapers:seeded.length,seedErrors,
      generic:counts('generic'),scientific:counts('scientific'),providerAttempts,
      dbReadOnly:true,totalChangesUnchanged:digest(changesBefore)===digest(db.prepare('SELECT total_changes() AS n').get()),
      dbBeforeSha256:dbBefore,dbAfterSha256:sha(await readFile(join(root,'research.sqlite'))),
      scientificMetrics:null,answerMetrics:null,singleChannelContribution:null};
    await save(join(root,'d-report.json'),d);assert.ok(d.totalChangesUnchanged);assert.equal(d.dbBeforeSha256,d.dbAfterSha256);
    // Fixed budgets and identical physical chunk/locator for both F arms.
    async function pair(row:typeof rows[number], candidate:ScientificSearchResult['candidates'][number]|undefined, selection:unknown) {
      const cap=8000;
      if(!candidate||!row.scientific.result) return {question:row.question,status:'unavailable',selection,
        reason:'No source-bound candidate for the frozen rule',wholePayloadTokenLimit:cap};
      const version=repository.knowledge.chunkVersion(candidate.chunkId!,project.id);
      assert.equal(version.chunkHash,sha(candidate.content));
      const genericRequest={projectId:project.id,chunkId:candidate.chunkId!,expectedIndexedVersion:version.indexedVersion,maxChars:8000,neighbors:false};
      const scientificRequest={search:row.scientific.result,candidateIds:[candidate.id],
        budget:{maxObjects:1,maxParagraphs:1,maxTokens:7000,maxImages:0,maxImageDimension:2048,maxEvidencePerPaper:1}};
      const generic=await observed(genericRequest,()=>repository.knowledge.readContext(genericRequest));
      const scientific=await observed(scientificRequest,()=>router.readContext(scientificRequest));
      const genericTokens=generic.result?chunkTokenCount(JSON.stringify(generic.result)):null;
      const scientificTokens=scientific.result?chunkTokenCount(JSON.stringify(scientific.result)):null;
      return {question:row.question,status:'observed',selection,
        chosen:{candidateId:candidate.id,chunkId:candidate.chunkId,objectId:candidate.objectId,objectType:candidate.objectType,
          sourceLocator:JSON.parse(version.locator!),generationId:candidate.generationId},
        wholePayloadTokenLimit:cap,tokenizer:'cl100k_base',generic,scientific,genericTokens,scientificTokens,
        budgetAccepted:genericTokens!==null&&scientificTokens!==null&&genericTokens<=cap&&scientificTokens<=cap};
    }
    const fRows=[];
    for(const [i,row] of rows.entries()) {
      const candidate=row.scientific.result?.hits.find(h=>h.chunkId!==null);
      const f=await pair(row,candidate,{rule:'first-source-bound-top20'});fRows.push(f);
      await save(join(root,`f-query-${i}.json`),f);
      if((i+1)%25===0)console.log(JSON.stringify({stage:'F',queries:i+1,total:questions.length}));
    }
    const objectRows:Array<Awaited<ReturnType<typeof pair>>>=[];
    for(const [i,object] of objects.entries()) {
      // All original questions for this paper are frozen before D. Pick the first
      // in source order that actually returned this source object's block/type.
      const paperRows=rows.filter(r=>r.question.paperId===object.paperId);
      const found=paperRows.map(row=>({row,candidate:row.scientific.result?.candidates.find(c=>c.chunkId!==null&&
        c.sourceLocator?.blockId===object.blockId&&c.object.kind===object.type)})).find(x=>x.candidate);
      const selection={rule:'first-original-question-with-source-object-candidate',object,
        attempts:paperRows.map(r=>({questionId:r.question.id,error:r.scientific.error,
          candidateIds:r.scientific.result?.candidates.filter(c=>c.sourceLocator?.blockId===object.blockId&&c.object.kind===object.type).map(c=>c.id)??[]}))};
      const f=await pair(found?.row??paperRows[0]!,found?.candidate,selection);objectRows.push(f);
      await save(join(root,`f-object-${i}.json`),f);
      if((i+1)%25===0)console.log(JSON.stringify({stage:'F-object',objects:i+1,total:objects.length}));
    }
    const count=(values:any[])=>({rows:values.length,unavailable:values.filter(r=>r.status==='unavailable').length,
      observed:values.filter(r=>r.status==='observed').length,budgetAccepted:values.filter(r=>r.budgetAccepted).length,
      nonemptyPaired:values.filter(r=>r.generic?.result&&r.scientific?.result?.evidence.length).length,
      errors:{generic:values.filter(r=>r.generic?.error).length,scientific:values.filter(r=>r.scientific?.error).length}});
    await save(join(root,'f-report.json'),{query:count(fRows),objects:count(objectRows),
      objectTypes:Object.fromEntries(['table','figure','equation','algorithm'].map(t=>[t,count(objectRows.filter(r=>(r.selection as any).object.type===t))])),
      wholePayloadTokenLimit:8000,qualityMetrics:null,
      limitations:['Main F follows old first source-bound top20 rule.',
        'Object inventory supplement uses first original question with a real saved candidate; may be outside top20. No added query or fabricated receipt.',
        'One object/one paragraph/no images; scientific7000 internal tokens, generic8000chars; common whole JSON cap8000.',
        'Objects are parsed public artifacts, not gold; no answer/scientific-quality claim.']});
    assert.equal(providerAttempts,0);assert.deepEqual(changesBefore,db.prepare('SELECT total_changes() AS n').get());
    assert.equal(dbBefore,sha(await readFile(join(root,'research.sqlite'))));
    return {d,includeF};
  }finally {
    await embeddings.shutdown();await repository.knowledgeJobs.shutdown();await repository.paperCards.shutdown();await repository.wiki.shutdown();
    db.close();agent.close();
  }
}
