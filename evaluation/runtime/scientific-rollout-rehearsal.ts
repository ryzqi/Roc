import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {load} from 'sqlite-vec';
import {applyAgentDatabaseSchema, applyResearchDatabaseSchema} from '../../src/main/infrastructure/database-schemas';
import {ResearchTaskRepository} from '../../src/main/plugins/research/research-task-repository';
import {ResearchRepository} from '../../src/main/plugins/research/repository';
import {OpenAICompatibleEmbeddingClient} from '../../src/main/plugins/research/embedding-client';
import {ResearchEmbeddingService} from '../../src/main/plugins/research/embedding-service';
import {ScientificRetrievalRouter} from '../../src/main/plugins/research/scientific-retrieval-router';
import {ScientificGenerationService} from '../../src/main/plugins/research/scientific-generation-service';
import {ScientificShadowRetrieval, type ScientificShadowEvent} from '../../src/main/plugins/research/scientific-shadow-retrieval';
import {ScholarlyRelationsRepository} from '../../src/main/plugins/research/scholarly-relations-repository';
import {collectDocumentContent} from '../../src/main/plugins/research/document-files';
import {PaperIRRepository} from '../../src/main/plugins/research/paper-ir-repository';
import {withResearchPdf} from '../../src/main/plugins/research/pdf-render';
import type {ResearchKnowledgeSearchRequest, ResearchKnowledgeSearchResult} from '../../src/shared/types';
import type {researchParsedDocumentSchema} from '../../src/shared/schemas/research-production';
import type {z} from 'zod';

type Input = {paperId: string; sourcePath: string; sourceHash: string; outputPath: string;
  parsed: z.infer<typeof researchParsedDocumentSchema>};
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown): string => hash(JSON.stringify(value));
const quote = (name: string): string => `"${name.replaceAll('"','""')}"`;
const stableResult = ({generatedAt: _generatedAt, ...result}: ResearchKnowledgeSearchResult) => result;
// Complete Unicode token boundaries avoid inventing ASCII words inside noisy OCR tokens (e.g. 6I07uerI).
const probeTerms = (text:string):string[] => (text.match(/[\p{L}\p{N}]+/gu)??[]).filter(term=>/^[A-Za-z]{3,}$/u.test(term));

/** Public original bytes, real repositories and native SQLite; controlled vectors are engineering probes only. */
export async function runScientificRollout(root: string, inputs: Input[]) {
  const db = new Database(join(root, 'research.db')), agentDb = new Database(join(root, 'agent.db'));
  db.pragma('foreign_keys=ON'); load(db); applyResearchDatabaseSchema(db); applyAgentDatabaseSchema(agentDb);
  const repository = new ResearchRepository(db, new ResearchTaskRepository(agentDb));
  const project = repository.createProject({title:'Public45 rollout rehearsal',description:'Isolated engineering acceptance',workspacePath:root});
  await mkdir(join(root,'foreign-project'));
  const foreign = repository.createProject({title:'Non-member scope probe',description:'Empty isolated project',workspacePath:join(root,'foreign-project')});
  repository.knowledge.saveEmbeddingConfig({id:'rollout-engineering',name:'Engineering probe',enabled:true,
    baseUrl:'https://fixture.invalid',model:'controlled-one-hot',dimensions:3,apiKey:'fixture-key'},'fixture-secret');
  let providerCalls = 0, unavailable = false, enabled = false;
  const embeddings = new ResearchEmbeddingService(repository.knowledge,new OpenAICompatibleEmbeddingClient(async (_url,init) => {
    providerCalls++;
    if (unavailable) throw new TypeError('fetch failed');
    const body: {input:string[]} = JSON.parse(String(init.body));
    return Response.json({data:body.input.map((_,index)=>({index,embedding:[1,0,0]}))});
  }),{secrets:{get:async ()=>'fixture-key',set:async()=>{throw new Error('unexpected_secret_write');},clear(){throw new Error('unexpected_secret_write');}},logger:{info(){},warn(){},error(){}}});
  const router = new ScientificRetrievalRouter(repository, embeddings, {library:root,index:null},
    new ScholarlyRelationsRepository(db,repository));
  const generations = new ScientificGenerationService(repository,embeddings,router.snapshots);
  const events: ScientificShadowEvent[] = [];
  let lastLegacy: ResearchKnowledgeSearchResult | undefined, legacyCalls = 0;
  const foreground: Array<{queryHash:string;resultHash:string;returnedHash:string;stableResultHash:string;
    sameObject:boolean;calls:number}> = [];
  const shadow = new ScientificShadowRetrieval({async search(request,signal) {
    legacyCalls++;lastLegacy=await embeddings.search(request,signal);return lastLegacy;
  }},router,
    ()=>enabled ? {projectIds:[project.id],timeoutMs:60000,concurrency:1} : undefined, event=>events.push(event));
  const search = async (request:ResearchKnowledgeSearchRequest) => {
    const calls=legacyCalls,result=await shadow.search(request);
    assert.equal(result,lastLegacy);assert.equal(legacyCalls-calls,1);
    foreground.push({queryHash:hash(request.query),resultHash:digest(lastLegacy),returnedHash:digest(result),
      stableResultHash:digest(stableResult(result)),sameObject:result===lastLegacy,calls:legacyCalls-calls});
    return result;
  };
  const store = repository.scientificIndex, identity = embeddings.selectedIdentity(null)!;
  const protectedData = () => Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'research_scientific_index_generations' ORDER BY name").all() as {name:string}[])
    .map(({name})=>[name,[...db.prepare(`SELECT * FROM ${quote(name)}`).iterate()].map(row=>digest(
      Object.entries(row as Record<string,unknown>).map(([key,value])=>[key,
        Buffer.isBuffer(value)?{blob:hash(value),bytes:value.length}:
        typeof value==='string'?{text:hash(value),bytes:Buffer.byteLength(value)}:value]))).sort()]));
  const seeded: Array<{paperId:string;documentId:string;parseId:string;
    paperIR:Awaited<ReturnType<PaperIRRepository['publish']>>;sourceHash:string;pdf:{pages:number;textItems:number};
    a:string;b:string;failed:string;pending:string;evidence:ReturnType<ResearchRepository['evidence']['capture']>;
    pageId:string;revision:ReturnType<ResearchRepository['wiki']['revision']>;query:string}> = [];
  try {
    for (const input of inputs) {
      const bytes = await readFile(join(root,input.sourcePath)); assert.equal(hash(bytes),input.sourceHash);
      const pdf = await withResearchPdf(new Uint8Array(bytes),async source => {
        let textItems=0;
        for(let page=1;page<=source.numPages;page++) {const p=await source.getPage(page);textItems+=(await p.getTextContent()).items.length;p.cleanup();}
        return {pages:source.numPages,textItems};
      });
      const title = `Public source ${input.paperId}`, timestamp = '2026-11-17T00:00:00.000Z';
      const metadata = {id:input.paperId,source:'local' as const,externalId:input.paperId,title,authors:[],doi:null,
        abstract:null,publishedYear:null,citationCount:null,url:null,openAccessUrl:null,importedAt:timestamp,updatedAt:timestamp};
      const bibliography = {citationKey:input.paperId,entryType:'article',fields:{title},preambles:[],csl:null,
        title,authors:[],doi:null,publishedYear:null,abstract:null,url:null};
      const document = repository.documents.import({id:input.paperId,libraryItemId:null,projectId:project.id,
        filename:`${input.paperId}.pdf`,mediaType:'application/pdf',sourcePath:input.sourcePath,
        sourceHash:input.sourceHash,size:bytes.length,entry:{metadata,bibliography}},false).document;
      const {data,coordinates} = await collectDocumentContent(root,join(root,input.outputPath),input.parsed);
      const parseId = `rollout:${input.paperId}`;
      repository.documents.begin(document.id,parseId);
      const ir = repository.documents.buildPaperIR(document.id,parseId,data);
      const paperIR = await new PaperIRRepository(root).publish(ir); data.paperIR=paperIR;
      const begin = (tableTokens:number) => store.begin({ir,paperIR,projectId:null,source:{kind:'library'},embedding:identity,policy:{tableTokens}});
      const vectors = (id:string) => store.writeEmbeddings(id,identity,store.chunks(id,null).filter(c=>c.retrieval).map(c=>({chunkId:c.id,vector:[1,0,0]})));
      const a=begin(512);vectors(a.id);
      store.publish(a.id,()=>({paperIR,embedding:identity}),()=>repository.documents.complete(document.id,parseId,data,coordinates));
      const failed=begin(450);
      assert.throws(()=>store.publish(failed.id,()=>({paperIR,embedding:identity})),/embeddings_incomplete/);
      store.fail(failed.id,'controlled_provider_failure');assert.equal(store.active(null,document.id)?.id,a.id);
      const b=begin(450);vectors(b.id);store.publish(b.id,()=>({paperIR,embedding:identity}));
      const pending=begin(450);
      const chunks=repository.knowledge.knowledgeChunks(`document:${parseId}`);
      const parents=new Set((db.prepare('SELECT parent_chunk_id AS id FROM research_knowledge_chunk_structure WHERE parent_chunk_id IS NOT NULL').all() as {id:string}[]).map(row=>row.id));
      const chunk=chunks.find(c=>!parents.has(c.id)&&probeTerms(c.content).length>=8);assert.ok(chunk,input.paperId);
      const evidence=repository.evidence.capture({projectId:project.id,chunkId:chunk.id});
      const wiki=repository.wiki.create({projectId:project.id,kind:'topic',title,evidenceIds:[evidence.id],claimIds:[]});
      await repository.wiki.idle();
      const page=repository.wiki.read(project.id,wiki.page.id);assert.ok(page.current);assert.equal(page.page.job?.status,'ready');
      const query=probeTerms(chunk.content).slice(0,8).join(' ');
      seeded.push({paperId:input.paperId,documentId:document.id,parseId,paperIR,sourceHash:input.sourceHash,pdf,
        a:a.id,b:b.id,failed:failed.id,pending:pending.id,evidence,pageId:page.page.id,revision:page.current!,query});
      console.log(JSON.stringify({stage:'seed',papers:seeded.length,paperId:input.paperId,pages:pdf.pages}));
    }
    await repository.knowledgeJobs.idle();await repository.paperCards.idle();await repository.wiki.idle();
    const protectedBefore=protectedData();await writeFile(join(root,'protected-before.json'),JSON.stringify(protectedBefore));
    await db.backup(join(root,'before.db')); 
    const observations=[];
    for(const item of seeded) {
      const request:ResearchKnowledgeSearchRequest={projectId:project.id,documentId:`document:${item.parseId}`,
        query:item.query,embeddingConfigId:null,limit:10,candidateLimit:50,rerank:'none'};
      const scope={projectId:project.id,documentId:item.documentId,storageProjectId:null};
      // Read-only phase: exact legacy result, background comparison, controlled provider failure and disable switch.
      const changes=db.prepare('SELECT total_changes() AS n').get();db.pragma('query_only=ON');
      const baseline=await embeddings.search(request);assert.ok(baseline.hits.length);
      const start=events.length;enabled=false;assert.deepEqual(stableResult(await search(request)),stableResult(baseline));await shadow.settle();assert.equal(events.length,start);
      enabled=true;assert.deepEqual(stableResult(await search(request)),stableResult(baseline));await shadow.settle();
      const compared=events.at(-1)!;assert.equal(compared.status,'compared');assert.equal(compared.recall,null);
      unavailable=true;
      const degradedRequest={...request,query:`${item.query} degradationprobe`};
      const degraded=await search(degradedRequest);await shadow.settle();
      assert.equal(degraded.ranking.degradation,'network');assert.ok(degraded.hits.length);
      const degradedEvent=events.at(-1)!;assert.equal(degradedEvent.status,'compared');assert.ok(degradedEvent.scientific?.degradation.includes('network'));
      unavailable=false;enabled=false;assert.deepEqual(stableResult(await search(request)),stableResult(baseline));await shadow.settle();
      assert.equal(events.length,start+2);assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(),changes);
      db.pragma('query_only=OFF');
      // Actual corrupt active FTS; legacy result survives while shadow records the source-index failure.
      const fts=db.prepare('SELECT * FROM research_scientific_fts WHERE generation_id=?').all(item.b) as Record<string,unknown>[];
      assert.ok(fts.length);db.prepare('DELETE FROM research_scientific_fts WHERE generation_id=?').run(item.b);
      db.pragma('query_only=ON');enabled=true;assert.deepEqual(stableResult(await search(request)),stableResult(baseline));await shadow.settle();
      const failure=events.at(-1)!;assert.equal(failure.status,'failed');db.pragma('query_only=OFF');enabled=false;
      const calls=providerCalls;
      assert.equal((await generations.activate({...scope,generationId:item.a,expectedActiveId:item.b})).activeGeneration,item.a);
      assert.equal(store.get(item.pending).status,'cancelled');assert.equal(providerCalls,calls);
      const restored=await router.search({projectId:project.id,documentIds:[item.documentId],query:item.query,embeddingConfigId:null,limit:10,candidateLimit:50,rerank:'none'});
      assert.deepEqual(restored.snapshot.generations.map(g=>g.generationId),[item.a]);assert.ok(restored.hits.length);
      // Restore only task-injected damage; this is not the production recovery mechanism.
      const columns=Object.keys(fts[0]!);const insert=db.prepare(`INSERT INTO research_scientific_fts (${columns.map(quote).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
      db.transaction(()=>{for(const row of fts)insert.run(...columns.map(k=>row[k]));})();
      const callsBeforeForward=providerCalls;
      assert.equal((await generations.activate({...scope,generationId:item.b,expectedActiveId:item.a})).activeGeneration,item.b);
      assert.equal(providerCalls,callsBeforeForward);
      assert.deepEqual(repository.evidence.getEvidence(item.evidence.id,project.id),item.evidence);
      assert.deepEqual(repository.wiki.revision(project.id,item.pageId,item.revision.revision),item.revision);
      observations.push({...item,baseline,degraded,compared,degradedEvent,failure,restoredGeneration:item.a,finalGeneration:item.b,
        failedCandidatePreserved:store.get(item.failed).status==='failed',candidateCancelled:store.get(item.pending).status==='cancelled'});
      console.log(JSON.stringify({stage:'exercise',papers:observations.length,paperId:item.paperId}));
    }
    const isolatedChanges=db.prepare('SELECT total_changes() AS n').get();db.pragma('query_only=ON');
    const multiple=await router.search({projectId:project.id,documentIds:[],query:'method results',embeddingConfigId:null,limit:20,candidateLimit:100,rerank:'none'});
    assert.equal(multiple.snapshot.generations.length,inputs.length);assert.ok(multiple.hits.length);
    assert.throws(()=>generations.list({projectId:foreign.id,documentId:seeded[0]!.documentId,storageProjectId:null}),/scope_invalid/);
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(),isolatedChanges);db.pragma('query_only=OFF');
    const protectedAfter=protectedData();
    // FTS shadow tables may be repacked by the explicit fault repair; compare the authoritative virtual postings separately.
    for(const [table,rows] of Object.entries(protectedBefore)) if(!table.startsWith('research_scientific_fts_')) {
      const normalize=(value:unknown)=>Array.isArray(value)?value.map(row=>JSON.stringify(row)).sort():value;
      assert.deepEqual(normalize(protectedAfter[table]),normalize(rows),table);
    }
    await writeFile(join(root,'protected-after.json'),JSON.stringify(protectedAfter));
    assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.deepEqual(db.pragma('integrity_check'),[{integrity_check:'ok'}]);
    return {projectId:project.id,foreignProjectId:foreign.id,observations,events,foreground,multiple,
      protectedBeforeHash:digest(protectedBefore),protectedAfterHash:digest(protectedAfter),providerCalls,
      quality:{recall:null,answerCorrectness:null,realProjectAcceptance:null}};
  } finally {
    db.pragma('query_only=OFF');await shadow.shutdown();await embeddings.shutdown();
    await repository.knowledgeJobs.shutdown();await repository.paperCards.shutdown();await repository.wiki.shutdown();
    db.close();agentDb.close();
  }
}
