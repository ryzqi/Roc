/** Shared actual-service corpus and human-decision fixture, without network or model calls. */
import {createReviewSearchFixture, awaitReviewSearchFixture} from './research-review-search.mjs';
const actor={kind:'user',id:'synthetic-dedup-reviewer'};
export async function createReviewDeduplicationFixture(api,options={},selectedApi=api) {
  const f=createReviewSearchFixture(selectedApi,{queries:['controlled one','controlled two'],...options});
  const results=[];
  for(let queryIndex=0;queryIndex<f.protocol.version.body.databases[0].queries.length;queryIndex++) {
    results.push(await awaitReviewSearchFixture(f,f.reviews.start({...f.request,queryIndex,requestId:`query-${queryIndex}`},actor)));
  }
  f.corpora=new api.ResearchReviewCorpusRepository(f.db,f.repository,f.reviews,()=>f.time);
  f.corpus=f.corpora.create({projectId:f.project.id,requestId:'capture',versionId:f.protocol.version.id,
    expectedFreezeHash:f.protocol.freezeHash,searches:results.map(result=>({reviewSearchId:result.snapshot.id,
      expectedSnapshotHash:result.snapshotHash,expectedReceiptHash:result.receiptHash}))},actor);
  f.dedup=new api.ResearchReviewDeduplicationRepository(f.db,f.repository,f.corpora,()=>f.time);
  f.get={projectId:f.project.id,corpusId:f.corpus.snapshot.id};
  f.save=(left,right,requestId,extra={})=>({...f.get,expectedCorpusHash:f.corpus.snapshotHash,requestId,
    leftHitId:f.corpus.snapshot.hits[left].id,rightHitId:f.corpus.snapshot.hits[right].id,decision:'duplicate',
    rule:{name:'Human bibliographic comparison',version:'controlled-v1'},reason:'Compared the actual original metadata.',
    parentDecisionId:null,expectedParentHash:null,revisionReason:null,...extra});
  f.freeze=()=>({...f.get,requestId:'freeze',expectedCorpusHash:f.corpus.snapshotHash,reviewNote:'Reviewed all original returns and pair decisions.',
    decisions:f.dedup.get(f.get).decisions.map(decision=>({decisionId:decision.snapshot.id,expectedHash:decision.snapshotHash}))});
  return f;
}
