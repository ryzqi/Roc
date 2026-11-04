import {createHash} from 'node:crypto';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {importTypeScriptModule} from '../../../scripts/lib/bundle-ts.mjs';
import {createReviewScreeningPlanFixture,reviewScreeningActorFixture as actor} from './research-review-screening.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const include={decision:'include',inclusionCriterionIds:['controlled'],reason:'Explicit synthetic engineering title decision.'};
const exclude={decision:'exclude',exclusionCriterionId:'no-outcome',reason:'Explicit synthetic engineering exclusion.'};
let parserModule,collectorModule;
export async function createReviewFullTextFixture(api,{freeze=true,document=true,...options}={},selectedApi=api) {
  const f=await createReviewScreeningPlanFixture(api,options,selectedApi);
  f.plan=f.screening.createPlan(f.input,actor);f.phase={...f.get,phase:'title_abstract'};
  for(const [index,hit] of f.corpus.snapshot.hits.entries())for(const reviewer of f.plan.snapshot.request.titleAbstractReviewers) {
    f.decisions.save({...f.phase,hitId:hit.id,expectedPlanHash:f.plan.snapshotHash,requestId:`title-${index}-${reviewer.id}`,
      reviewerId:reviewer.id,outcome:index===1?exclude:include,consideredSuggestion:null,parentDecisionId:null,
      expectedParentHash:null,revisionReason:null},actor);
  }
  f.title=freeze?f.freezing.freeze({...f.phase,requestId:'freeze-title',expectedReviewHash:f.freezing.getPhase(f.phase).reviewHash,
    reviewNote:'Explicit controlled complete title decisions.'},actor):null;
  f.directory=await mkdtemp(join(tmpdir(),'roc-review-fulltext-'));f.root=await realpath(f.directory);
  f.service=new api.ResearchDocumentService(f.repository,{},f.root);
  if(document) {
    parserModule??=await importTypeScriptModule('src/main/plugins/research/document-parser.ts',{
      platform:'node',external:['@napi-rs/canvas','onnxruntime-node','paddleocr','pdfjs-dist/legacy/build/pdf.mjs'],tempDir:'.runtime/tmp'});
    collectorModule??=await importTypeScriptModule('src/main/plugins/research/document-files.ts',{platform:'node',external:['zod'],tempDir:'.runtime/tmp'});
    f.original=await readFile('tests/fixtures/research-workflow/source.pdf');
    f.sourcePath=join(f.root,'paper.pdf');await writeFile(f.sourcePath,f.original);
    const parsed=await parserModule.parseResearchDocument({projectRoot:f.root,sourcePath:f.sourcePath,outputDir:join(f.root,'parsed'),
      options:{tier:'compact',device:'cpu',pageRange:'1'},modelFiles:null,modelManifest:''});
    f.collected=await collectorModule.collectDocumentContent(f.root,join(f.root,'parsed'),parsed);
    f.document=f.repository.documents.import({id:'fulltext-fixture-document',libraryItemId:null,projectId:f.project.id,
      filename:'paper.pdf',mediaType:'application/pdf',sourcePath:'paper.pdf',sourceHash:hash(f.original),size:f.original.length,
      entry:{metadata:{id:'fulltext-local-document',source:'local',externalId:'fulltext-engineering-fixture',doi:null,
        title:'Explicit fulltext source fixture',authors:['Synthetic Author'],abstract:null,publishedYear:2026,citationCount:null,
        url:null,openAccessUrl:null,importedAt:f.time,updatedAt:f.time},
        bibliography:{citationKey:'fulltext2026',entryType:'article',fields:{title:'Explicit fulltext source fixture'},preambles:[],
          csl:null,title:'Explicit fulltext source fixture',authors:['Synthetic Author'],doi:null,publishedYear:2026,abstract:null,url:null}}
    },false).document;
    f.repository.documents.begin(f.document.id,'fulltext-parse');
    f.repository.documents.complete(f.document.id,'fulltext-parse',f.collected.data,f.collected.coordinates);
    f.selection={documentId:f.document.id,sourceHash:f.document.sourceHash,parseId:'fulltext-parse',parseHash:hash(JSON.stringify(f.collected.data.content))};
  }
  f.fulltexts=new api.ResearchReviewFullTextRepository(f.db,f.repository,f.corpora,f.freezing,f.service,()=>f.time);
  f.input=(index,requestId,outcome)=>({...f.get,hitId:f.corpus.snapshot.hits[index].id,requestId,
    expectedTitleFreezeHash:f.title===null?'a'.repeat(64):f.title.freezeHash,outcome,
    parentBindingId:null,expectedParentHash:null,revisionReason:null});
  f.retrieved=(index=0,requestId='bind-original',selection=f.selection)=>f.input(index,requestId,{
    kind:'retrieved',selection,relationNote:'User explicitly selected this source for the synthetic hit; no scientific matching claim.'});
  f.notRetrieved=(index=0,requestId='not-retrieved')=>f.input(index,requestId,{kind:'not_retrieved',reason:'User declares full text not obtained; no eligibility decision.'});
  f.bindingGet=bindingId=>({...f.get,bindingId});
  f.reparse=()=>{
    f.repository.documents.begin(f.document.id,'fulltext-reparse');
    f.repository.documents.complete(f.document.id,'fulltext-reparse',f.collected.data,f.collected.coordinates);
  };
  f.cleanup=async()=>{await f.service.shutdown();await f.dispose();await rm(f.directory,{recursive:true,force:true});};
  return f;
}
