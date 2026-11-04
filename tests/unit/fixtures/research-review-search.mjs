/** Offline HTTP fixtures exercise the actual provider, ledger and repositories. */
import {setTimeout as delay} from 'node:timers/promises';
import {createResearchFixture} from './research-test-kit.mjs';
import {reviewProtocolBodyFixture} from './research-review-protocol.mjs';
const actor={kind:'user',id:'synthetic-review-search-user'};

export const reviewBibliographyPreparationFixture={prepareDoi:async()=>{throw new Error('unexpected_import');},
  prepareRecord:async()=>{throw new Error('unexpected_import');},prepareZotero:async()=>{throw new Error('unexpected_import');}};
export function reviewProviderGovernorFixture(api) {
  let now=Date.parse('2026-11-04T00:00:00Z');
  const policy={minIntervalMs:1000,maxRequests:300,windowMs:3600000,failureThreshold:3,cooldownMs:60000};
  return new api.LiteratureProviderGovernor({'api.openalex.org':policy},()=>now,
    async(ms,signal)=>{signal.throwIfAborted();now+=ms;});
}
export function reviewSearchPayloadFixture(page,count=4) {
  return {meta:{count,per_page:2,page},results:Array.from({length:Math.min(2,count-(page-1)*2)},(_,index)=>{
    const n=(page-1)*2+index+1;
    return {id:`https://openalex.org/W${n}`,doi:`https://doi.org/10.1234/review-${n}`,title:`Controlled paper ${n}`,
      publication_year:n===1?null:n===2?2010:2023,authorships:[]};
  })};
}
export function createReviewSearchFixture(api,{maxPages=2,fetch,queries}={}) {
  const f=createResearchFixture(api,'reading');f.errors=[];f.calls=[];f.time='2026-11-04T00:00:00.000Z';
  f.search=new api.LiteratureSearchService(async(url,init)=>{
    f.calls.push({url,init});
    return fetch===undefined?Response.json(reviewSearchPayloadFixture(Number(new URL(url).searchParams.get('page')))):fetch(url,init);
  },reviewProviderGovernorFixture(api));
  f.imports=new api.LiteratureImportService(f.db,f.repository.library,f.search,reviewBibliographyPreparationFixture,async()=>{throw new Error('unexpected_library_mutation');},()=>f.time);
  f.reviews=new api.ResearchReviewSearchService(f.db,f.repository,f.imports,error=>f.errors.push(error),()=>f.time);
  const body=reviewProtocolBodyFixture();body.databases[0].pageSize=2;body.databases[0].maxPages=maxPages;if(queries!==undefined)body.databases[0].queries=queries;
  const draft=f.repository.systematicReviews.save({projectId:f.project.id,requestId:'protocol',protocolId:null,
    expectedVersionId:null,expectedVersionHash:null,body,deviationReason:null},actor);
  f.protocol=f.repository.systematicReviews.freeze({projectId:f.project.id,requestId:'confirm',versionId:draft.version.id,
    expectedVersionHash:draft.versionHash,reviewNote:'Controlled offline query scope.'},actor);
  f.request={projectId:f.project.id,requestId:'review-query',versionId:f.protocol.version.id,expectedFreezeHash:f.protocol.freezeHash,
    databaseIndex:0,queryIndex:0,retryOf:null,expectedRetrySnapshotHash:null};
  f.changes=()=>f.db.prepare('SELECT total_changes()').pluck().get();
  f.dispose=async()=>{await f.reviews.shutdown();await f.imports.shutdown();await f.search.shutdown();f.close();};
  return f;
}
export async function awaitReviewSearchFixture(f,started) {
  const until=Date.now()+7000;
  while(Date.now()<until) {
    const read=f.reviews.get({projectId:f.project.id,reviewSearchId:started.snapshot.id});
    if(read.status!=='running'&&read.status!=='cancelling')return read;
    await delay(1);
  }
  throw new Error(`review_query_did_not_finish:${f.errors.map(error=>error.message).join(',')}`);
}
