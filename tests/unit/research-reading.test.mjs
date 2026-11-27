import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {createResearchFixture,loadResearchTestApi} from './fixtures/research-test-kit.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});after(()=>api.dispose());
const rss=(title='First')=>`<rss version="2.0"><channel><title>Feed</title><item><guid>paper-1</guid><title>${title}</title><link>https://arxiv.org/abs/2611.00001</link><description><![CDATA[<p>Abstract</p><script>bad()</script>]]></description><pubDate>Fri, 06 Nov 2026 00:00:00 GMT</pubDate></item></channel></rss>`;
function scene(){const f=createResearchFixture(api,'reading');f.reading=new api.ReadingRepository(f.db,f.repository,()=> '2026-11-07T00:00:00.000Z');return f;}
function paper(f){const record={id:'crossref:10.1234/seed',source:'crossref',externalId:'10.1234/seed',doi:'10.1234/seed',title:'Seed paper',authors:['Author'],abstract:'Seed abstract',publishedYear:2026,citationCount:null,url:null,openAccessUrl:null,importedAt:'2026-11-07T00:00:00.000Z',updatedAt:'2026-11-07T00:00:00.000Z'};return f.repository.library.import([{metadata:record,bibliography:api.bibliographyFromRecord(record,new Set())}],f.project.id).items[0];}
function radarFixture(f, embeddings = {}, fetchText, onPrepare = () => {}) {
  const jobs = new api.LiteratureAcquisitionRepository(f.db, f.reading.now);
  const acquisition = new api.LiteratureAcquisitionService(jobs);
  const radar = new api.RadarService(f.reading, embeddings, {
    async prepareRecord(record, _projectId, _signal, citationKey) {
      onPrepare();
      return {metadata: record, bibliography: {...api.bibliographyFromRecord(record, new Set()), citationKey}};
    }
  }, acquisition, fetchText);
  return {radar, jobs};
}

test('notes preserve revisions, linked titles, archive recovery and project isolation',()=>{
 const f=scene();try{const item=paper(f),request={id:'note',projectId:f.project.id,itemId:item.id,title:'Method',markdown:'[[Baseline]] and [[Baseline]] $x^2$',archived:false,expectedRevision:0};
 const saved=f.reading.saveNote(request);assert.deepEqual(saved.links,['Baseline']);assert.equal(saved.revision,1);
 assert.throws(()=>f.reading.saveNote({...request,markdown:'stale'}),/其他窗口/);
 assert.throws(()=>f.reading.saveNote({...request,id:'second',title:'ＭＥＴＨＯＤ'}),/同名/);
 const archived=f.reading.saveNote({...request,archived:true,expectedRevision:1});assert.equal(archived.revision,2);
 assert.equal(f.reading.saveNote({...request,expectedRevision:2}).archived,false);
 const second=f.repository.createProject({title:'Other',description:'',workspacePath:'/tmp/roc-reading-other'});
 assert.throws(()=>f.reading.saveNote({...request,projectId:second.id}),/不属于/);
 assert.throws(()=>f.reading.saveNote({...request,projectId:second.id,itemId:null}),/其他项目/);
 assert.equal(f.reading.notes(second.id).length,0);assert.equal(f.reading.notes(f.project.id)[0].markdown,request.markdown);
 f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
 assert.throws(()=>f.reading.saveNote({...request,expectedRevision:3}),/已归档/);
 }finally{f.close();}
});
test('note deletion checks project, revision and write access without reviving stale drafts',()=>{
 const f=scene();try{
 const input={id:'delete-note',projectId:f.project.id,itemId:null,title:'Delete me',markdown:'Saved text',archived:false,expectedRevision:0};
 const note=f.reading.saveNote(input);
 const other=f.repository.createProject({title:'Other',description:'',workspacePath:'/tmp/roc-reading-other'});
 const deletion={projectId:f.project.id,noteId:note.id,expectedRevision:note.revision};
 assert.throws(()=>f.reading.deleteNote({...deletion,projectId:other.id}),/不存在/);
 const updated=f.reading.saveNote({...input,markdown:'Updated elsewhere',expectedRevision:note.revision});
 assert.throws(()=>f.reading.deleteNote(deletion),/其他窗口/);
 assert.equal(f.reading.notes(f.project.id)[0].markdown,'Updated elsewhere');
 f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
 assert.throws(()=>f.reading.deleteNote({...deletion,expectedRevision:updated.revision}),/已归档/);
 f.db.prepare("UPDATE research_projects SET status='active' WHERE id=?").run(f.project.id);
 f.reading.deleteNote({...deletion,expectedRevision:updated.revision});
 assert.deepEqual(f.reading.notes(f.project.id),[]);
 assert.throws(()=>f.reading.saveNote({...input,expectedRevision:updated.revision}),/其他窗口/);
 assert.throws(()=>f.reading.deleteNote({...deletion,expectedRevision:updated.revision}),/不存在/);
 const archived=f.reading.saveNote({...input,id:'archived-note',archived:true});
 f.reading.deleteNote({...deletion,noteId:archived.id,expectedRevision:archived.revision});
 assert.deepEqual(f.reading.notes(f.project.id),[]);
 }finally{f.close();}
});
test('RSS and Atom parsing sanitize markup and reject malformed or entity documents',()=>{
 const rows=api.parseRadarFeed(rss(),'feed','https://example.org/rss');assert.equal(rows[0].summary,'Abstract');assert.equal(rows[0].arxivId,'2611.00001');
 assert.equal(rows[0].id,api.parseRadarFeed(rss('Renamed'),'feed','https://example.org/rss')[0].id);
 const atom='<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>abc</id><title>Atom</title><link href="https://example.org/paper"/><author><name>A</name></author><summary>Text</summary></entry></feed>';
 assert.deepEqual(api.parseRadarFeed(atom,'feed','https://example.org')[0].authors,['A']);
 assert.throws(()=>api.parseRadarFeed('<rss>','f','https://example.org'),/RSS/);
 assert.throws(()=>api.parseRadarFeed('<!DOCTYPE x><rss/>','f','https://example.org'),/RSS/);
 assert.throws(()=>api.cosineSimilarity([0,0],[1,0]),/零向量/);
 assert.equal(api.cosineSimilarity([1,0],[1,0]),1);
});
test('refresh coalesces requests and preserves read/import state and prior data on failure',async()=>{
 const f=scene();let calls=0,invalid=false;
 const {radar}=radarFixture(f,{},async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,5));return invalid?'<html/>':rss();});
 try{const feed=radar.saveFeed({id:'feed',projectId:f.project.id,title:'Feed',url:'https://example.org/rss',pinned:false,archived:false,expectedRevision:0});
 await Promise.all([radar.refresh(f.project.id,feed.id),radar.refresh(f.project.id,feed.id)]);assert.equal(calls,1);
 const article=radar.articles(f.project.id,feed.id)[0];radar.mark(f.project.id,article.id,true);const imported=await radar.importArticle(f.project.id,article.id);
 await radar.refresh(f.project.id,feed.id);assert.equal(radar.articles(f.project.id,feed.id)[0].importedItemId,imported.itemId);assert.equal(radar.articles(f.project.id,feed.id)[0].read,true);
 invalid=true;await assert.rejects(()=>radar.refresh(f.project.id,feed.id),/RSS/);assert.equal(radar.articles(f.project.id,feed.id).length,1);assert.match(radar.feeds(f.project.id)[0].error,/RSS/);
 }finally{await radar.shutdown();f.close();}
});
test('existing Hugging Face subscription refreshes daily papers and preserves its identity and article state',async()=>{
 const f=scene();let renamed=false,invalid=false;const requests=[];
 const {radar}=radarFixture(f,{},async(url,options)=>{
   requests.push(url);assert.equal(options.signal.aborted,false);
   assert.equal(url,'https://huggingface.co/api/daily_papers');
   return invalid?JSON.stringify({error:'provider response changed'}):JSON.stringify([{paper:{
     id:renamed?'2611.00001v2':'2611.00001',title:renamed?'Updated daily paper':'Daily <b>paper</b>',
     summary:'<p>Original abstract</p><script>bad()</script>',authors:[{name:'Fixture author'}],
     publishedAt:'2026-11-06T00:00:00.000Z'
   },publishedAt:'2026-11-07T00:00:00.000Z'}]);
 });
 try{
   const input={id:'hf-feed',projectId:f.project.id,title:'Huggingface',url:'https://huggingface.co/papers/feed',
     pinned:true,archived:false,expectedRevision:0};
   const feed=radar.saveFeed(input);
   f.db.prepare('UPDATE research_radar_feeds SET snapshot_json=? WHERE id=?')
     .run(JSON.stringify({...feed,error:'The operation was aborted'}),feed.id);
   const refreshed=await radar.refresh(f.project.id,feed.id);
   assert.equal(refreshed.url,input.url);assert.equal(refreshed.revision,1);assert.equal(refreshed.pinned,true);
   assert.equal(refreshed.error,null);assert.equal(refreshed.refreshedAt,'2026-11-07T00:00:00.000Z');
   const article=radar.articles(f.project.id,feed.id)[0];
   assert.equal(article.title,'Daily paper');assert.equal(article.summary,'Original abstract');
   assert.equal(article.url,'https://huggingface.co/papers/2611.00001');assert.equal(article.arxivId,'2611.00001');
   assert.equal(article.pdfUrl,'https://arxiv.org/pdf/2611.00001');assert.deepEqual(article.authors,['Fixture author']);
   assert.equal(article.publishedAt,'2026-11-06T00:00:00.000Z','retain the paper publication date');
   radar.mark(f.project.id,article.id,true);const imported=await radar.importArticle(f.project.id,article.id);
   renamed=true;await radar.refresh(f.project.id,feed.id);
   const updated=radar.articles(f.project.id,feed.id);
   assert.equal(updated.length,1);assert.equal(updated[0].id,article.id);
   assert.equal(updated[0].title,'Updated daily paper');assert.equal(updated[0].read,true);
   assert.equal(updated[0].importedItemId,imported.itemId);
   invalid=true;await assert.rejects(()=>radar.refresh(f.project.id,feed.id),/Hugging Face.*论文/);
   assert.equal(radar.articles(f.project.id,feed.id)[0].title,'Updated daily paper');
   assert.match(radar.feeds(f.project.id)[0].error,/Hugging Face.*论文/);
   assert.equal(requests.length,3);
 }finally{await radar.shutdown();await f.close();}
});
test('Hugging Face source aliases retain queries while other sites and official blog feeds use RSS',async()=>{
 const f=scene(),requests=[];
 const {radar}=radarFixture(f,{},async url=>{
   requests.push(url);return url.startsWith('https://huggingface.co/api/daily_papers')?'[]':rss();
 });
 try{
   for(const [index,url] of [
     'https://huggingface.co/papers',
     'https://huggingface.co/papers/feed/?date=2026-11-06',
     'https://huggingface.co/api/daily_papers',
     'https://huggingface.co/blog/feed.xml',
     'https://example.org/papers/feed'
   ].entries()){
     const feed=radar.saveFeed({id:`source-${index}`,projectId:f.project.id,title:`Source ${index}`,url,
       pinned:false,archived:false,expectedRevision:0});
     await radar.refresh(f.project.id,feed.id);
     assert.equal(radar.articles(f.project.id,feed.id).length,index<3?0:1);
   }
   assert.deepEqual(requests,[
     'https://huggingface.co/api/daily_papers',
     'https://huggingface.co/api/daily_papers?date=2026-11-06',
     'https://huggingface.co/api/daily_papers',
     'https://huggingface.co/blog/feed.xml',
     'https://example.org/papers/feed'
   ]);
 }finally{await radar.shutdown();await f.close();}
});
test('citation discovery caches pages, preserves marks, validates membership and falls back to Crossref',async()=>{
 const f=scene(),item=paper(f),{radar}=radarFixture(f);let calls=0,fail=false;
 const discovery=new api.ReadingDiscoveryService(f.reading,radar,async url=>{calls++;if(url.includes('semanticscholar')){if(fail)throw new Error('HTTP 429');return JSON.stringify({data:[{citedPaper:{paperId:'s2',title:'Reference',externalIds:{DOI:'10.1234/ref'},authors:[{name:'A'}]}}],next:100});}return JSON.stringify({message:{reference:[{DOI:'10.1234/fallback','article-title':'Fallback'}]}});});
 try{const request={projectId:f.project.id,itemId:item.id,direction:'references',offset:0,force:false};const result=await discovery.discover(request);assert.equal(result.nextOffset,100);assert.equal(result.articles.length,1);
 radar.mark(f.project.id,result.articles[0].id,true);assert.equal((await discovery.discover(request)).articles[0].read,true);assert.equal(calls,1);
 fail=true;const fallback=await discovery.discover({...request,force:true});assert.equal(fallback.source,'Crossref');assert.equal(fallback.articles[0].doi,'10.1234/fallback');assert.equal(fallback.warnings.length,1);
 const other=f.repository.createProject({title:'Other',description:'',workspacePath:'/tmp/roc-reading-other'});await assert.rejects(()=>discovery.discover({...request,projectId:other.id}),/不属于/);
 }finally{await discovery.shutdown();await radar.shutdown();f.close();}
});
test('Cool venue capture retains PDF metadata and rejects unsupported hosts',async()=>{
 const f=scene(),{radar}=radarFixture(f),discovery=new api.ReadingDiscoveryService(f.reading,radar,async()=>'<meta name="citation_title" content="Venue paper"><meta name="citation_authors" content="A; B"><meta name="citation_pdf_url" content="https://example.org/paper.pdf">');
 try{const value=await discovery.capturePage(f.project.id,'https://papers.cool/venue/123');assert.equal(value.pdfUrl,'https://example.org/paper.pdf');assert.deepEqual(value.authors,['A','B']);await assert.rejects(()=>discovery.capturePage(f.project.id,'https://evil.test/venue/123'),/详情页/);}finally{await discovery.shutdown();await radar.shutdown();f.close();}
});
test('translation stores secrets outside config, validates providers, and surfaces empty results',async()=>{
 const values=new Map(),secrets=new Map(),requests=[];let response='[[["译文","text"]]]';
 const service=new api.ReadingTranslationService({config:{get:key=>values.get(key),set:(key,value)=>values.set(key,value)},secrets:{get:async key=>secrets.get(key)??null,set:async(key,value)=>secrets.set(key,value),clear:key=>secrets.delete(key)}},async(url,options)=>{requests.push({url,options});return response;});
 try{assert.equal((await service.translate({projectId:'p',text:'text',target:'zh-CN'})).text,'译文');
 await service.save({provider:'openai',baseUrl:'https://example.org/v1',model:'model',region:'',target:'zh-CN',apiKey:'secret-fixture'});assert.equal(JSON.stringify([...values.values()]).includes('secret-fixture'),false);
 response=JSON.stringify({choices:[{message:{content:'Translated'}}]});assert.equal((await service.translate({projectId:'p',text:'text',target:'en'})).text,'Translated');assert.equal(requests.at(-1).options.headers.Authorization,'Bearer secret-fixture');
 await service.save({provider:'deepl',baseUrl:'https://api-free.deepl.com',model:'',region:'',target:'zh-CN',apiKey:null});await assert.rejects(()=>service.translate({projectId:'p',text:'text',target:'zh-CN'}),/API Key/);
 await service.save({provider:'google',baseUrl:'https://translate.googleapis.com',model:'',region:'',target:'zh-CN',apiKey:null});response='[[]]';await assert.rejects(()=>service.translate({projectId:'p',text:'text',target:'zh-CN'}),/空内容/);
 }finally{await service.shutdown();}
});
test('network rejects nonpublic addresses and unsafe URLs before a request',async()=>{
 for(const url of ['http://example.org','https://user:pass@example.org','https://example.org:8443'])assert.throws(()=>api.publicReadingUrl(url));
 await assert.rejects(()=>api.fetchReadingText('https://127.0.0.1'),/公开互联网/);
});

test('daily recommendations rank corpus similarity, cache identities and preserve read state',async()=>{
 const f=scene();paper(f);let fetched=0,embedded=0,revision=1,drift=false,broken=false;
 const feed=`<rss><channel>${[['2611.00001','Related'],['2611.00002','Unrelated']].map(([id,title])=>`<item><guid>${id}</guid><title>${title}</title><link>https://arxiv.org/abs/${id}</link><description>Source abstract</description></item>`).join('')}</channel></rss>`;
 const embeddings={embedTexts:async texts=>{embedded++;if(broken)throw new Error('Embedding unavailable');return {configId:'embedding-fixture',revision:revision+(drift&&texts.length>1?1:0),vectors:texts.map(text=>text.startsWith('Unrelated')?[0,1]:[1,0])};}};
 const {radar}=radarFixture(f,embeddings,async()=>{fetched++;return feed;});
 try{
   const first=await radar.recommend(f.project.id,['cs.AI'],false);
   assert.equal(first.cached,false);assert.equal(first.corpusSize,1);assert.deepEqual(first.articles.map(row=>row.title),['Related','Unrelated']);
   assert.equal(first.articles[0].score,1);assert.equal(first.articles[1].score,0);assert.equal(first.articles[0].summary,'Source abstract');
   radar.mark(f.project.id,first.articles[0].id,true);
   const cached=await radar.recommend(f.project.id,['cs.AI'],false);assert.equal(cached.cached,true);assert.equal(cached.articles[0].read,true);assert.equal(fetched,1);assert.equal(embedded,3);
   revision++;const refreshed=await radar.recommend(f.project.id,['cs.AI'],false);assert.equal(refreshed.cached,false);assert.equal(refreshed.articles[0].read,true);assert.equal(fetched,2);
   broken=true;await assert.rejects(()=>radar.recommend(f.project.id,['cs.AI'],false),error=>error.code==='research_radar_probe_failed'&&error.retryable);broken=false;
   drift=true;await assert.rejects(()=>radar.recommend(f.project.id,['cs.AI'],true),/配置改变/);
   assert.equal(radar.articles(f.project.id,null).length,2,'failed recomputation retains prior articles');
 }finally{await radar.shutdown();f.close();}
});

test('bulk discovery imports persist original scholarly metadata and avoid duplicate library records',async()=>{
 const f=scene(),item=paper(f);let imports=0;
 const {radar,jobs}=radarFixture(f,{},undefined,()=>imports++);
 const discovery=new api.ReadingDiscoveryService(f.reading,radar,async()=>JSON.stringify({data:['2611.00003','2611.00004'].map(id=>({citingPaper:{paperId:id,title:`Citing ${id}`,abstract:'Citing abstract',year:2026,externalIds:{ArXiv:id},authors:[{name:'Fixture author'}]}}))}));
 try{
   const result=await discovery.discover({projectId:f.project.id,itemId:item.id,direction:'citations',offset:0,force:false});
   for(const article of result.articles){const added=await radar.importArticle(f.project.id,article.id);const stored=f.repository.library.get(added.itemId);assert.equal(stored.metadata.source,'arxiv');assert.equal(stored.metadata.externalId,article.arxivId);assert.equal(stored.metadata.abstract,'Citing abstract');assert.deepEqual(stored.metadata.authors,['Fixture author']);await radar.importArticle(f.project.id,article.id);}
   assert.equal(imports,2);assert.equal(f.repository.library.list({projectId:f.project.id,includeArchived:false,query:'',limit:100}).length,3);
   assert.equal(jobs.list({owner:'reading-fixture',projectId:f.project.id},{offset:0,limit:20}).total,2);
 }finally{await discovery.shutdown();await radar.shutdown();f.close();}
});

test('Radar metadata, article receipt and acquisition queue commit together', async () => {
  const f = scene(), {radar, jobs} = radarFixture(f);
  const article = api.parseRadarFeed(rss(), 'feed', 'https://example.org/rss')[0];
  const projectId = f.project.id, scope = {owner: 'reading-fixture', projectId};
  try {
    radar.captureArticles(projectId, [article]);
    f.db.exec(`CREATE TEMP TRIGGER reject_radar_job BEFORE INSERT ON research_paper_acquisition_jobs
      BEGIN SELECT RAISE(ABORT, 'fixture_acquisition_insert_failed'); END;`);
    await assert.rejects(radar.importArticle(projectId, article.id), /fixture_acquisition_insert_failed/u);
    assert.equal(radar.articles(projectId, null)[0].importedItemId, null);
    assert.equal(f.repository.library.list({projectId, includeArchived: false, query: '', limit: 10}).length, 0);
    f.db.exec('DROP TRIGGER reject_radar_job');
    const [first, second] = await Promise.all([radar.importArticle(projectId, article.id), radar.importArticle(projectId, article.id)]);
    assert.deepEqual(first, second);
    const list = () => jobs.list(scope, {offset: 0, limit: 20}).jobs;
    const [job] = list();
    assert.equal(job.libraryItemId, first.itemId);
    assert.equal(list().length, 1);

    // Simulate the pre-fix database, where the Radar receipt exists without a job.
    f.db.prepare('DELETE FROM research_paper_acquisition_jobs WHERE id=?').run(job.id);
    jobs.enqueueMissingRadarImports();
    const [repaired] = list();
    assert.equal(repaired.libraryItemId, first.itemId);
    assert.equal(repaired.status, 'queued');
    jobs.change(repaired, repaired.generation, 'cancel');
    jobs.enqueueMissingRadarImports();
    assert.equal(list().length, 1);
    assert.equal(list()[0].status, 'cancelled');
    f.db.prepare('DELETE FROM research_paper_acquisition_jobs WHERE id=?').run(repaired.id);
    f.repository.library.link(first.itemId, projectId, false, {notify: false});
    jobs.enqueueMissingRadarImports();
    assert.equal(list().length, 0);
  } finally {await radar.shutdown(); await f.close();}
});

test('daily recommendation timeouts identify probe, feed and ranking stages without leaking provider details',async()=>{
 const f=scene();paper(f);let failure='probe',fetches=0,normalized=false;
 const timeout=()=>new DOMException('https://provider.invalid/private?token=fixture-sensitive-provider-detail','TimeoutError');
 const embeddings={embedTexts:async texts=>{
   if(failure==='probe'&&texts.length===1||failure==='embedding'&&texts.length>1)
     throw normalized ? new Error('embedding_provider_timeout') : timeout();
   return {configId:'fixture',revision:1,vectors:texts.map(()=>[1,0])};
 }};
 const {radar}=radarFixture(f,embeddings,async()=>{fetches++;if(failure==='feed')throw timeout();return rss();});
 try{
   for(const [stage,label] of [['probe','嵌入模型连接探测'],['feed','arXiv 订阅读取（cs.AI）'],['embedding','推荐内容向量计算']]){
     failure=stage;
     await assert.rejects(()=>radar.recommend(f.project.id,['cs.AI'],true),error=>{
       assert.equal(error.code,`research_radar_${stage}_timeout`);assert.equal(error.retryable,true);
       assert.match(error.message,new RegExp(label.replace(/[（）]/gu,'\\$&')));
       assert.equal(error.message.includes('fixture-sensitive-provider-detail'),false);return true;
     });
     assert.equal(radar.articles(f.project.id,null).length,0,'failed recommendation stages publish no article or cache');
   }
   assert.equal(fetches,2,'failed embedding probe never fetches the RSS source');
   normalized=true;failure='embedding';
   await assert.rejects(()=>radar.recommend(f.project.id,['cs.AI'],true),error=>error.code==='research_radar_embedding_timeout');
   failure='none';const recovered=await radar.recommend(f.project.id,['cs.AI'],false);assert.equal(recovered.articles.length,1);
 }finally{await radar.shutdown();f.close();}
});

test('daily recommendation shutdown preserves cancellation instead of reporting a provider timeout',async()=>{
 const f=scene();paper(f);let started;
 const running=new Promise(resolve=>{started=resolve;});
 const embeddings={embedTexts:async (_texts,_version,signal)=>{started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}};
 const {radar}=radarFixture(f,embeddings,async()=>rss());
 try{
   const pending=radar.recommend(f.project.id,['cs.AI'],true);await running;const stopped=radar.shutdown();
   await assert.rejects(()=>pending,error=>error.name==='AbortError'&&error.code!=='research_radar_probe_timeout');await stopped;
 }finally{await radar.shutdown();f.close();}
});

test('daily recommendations preserve safe embedding domain errors and their non-retryable semantics',async()=>{
 const f=scene();paper(f);let failedStage='probe',domainError;
 const embeddings={embedTexts:async texts=>{
   if(failedStage==='probe'&&texts.length===1||failedStage==='embedding'&&texts.length>1)throw domainError;
   return {configId:'fixture',revision:1,vectors:texts.map(()=>[1,0])};
 }};
 const {radar}=radarFixture(f,embeddings,async()=>rss());
 try{
   for(const [code,category,message] of [
     ['research_embedding_config_changed','conflict','嵌入配置已变化，请重试。'],
     ['research_embedding_cancelled','conflict','嵌入任务已取消。'],
     ['research_embedding_key_unavailable','validation','嵌入密钥不可用。']
   ]){
     domainError=new api.RocDomainError({code,category,message,retryable:false,userAction:'请在设置中核对嵌入配置。'});
     for(const stage of ['probe','embedding']){
       failedStage=stage;
       await assert.rejects(()=>radar.recommend(f.project.id,['cs.AI'],true),error=>{
         assert.equal(error,domainError,'do not reinterpret a classified domain error as a provider failure');
         assert.equal(error.code,code);assert.equal(error.category,category);assert.equal(error.retryable,false);
         assert.equal(error.userAction,'请在设置中核对嵌入配置。');return true;
       });
     }
   }
   assert.equal(radar.articles(f.project.id,null).length,0);
 }finally{await radar.shutdown();f.close();}
});
