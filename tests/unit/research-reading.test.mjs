import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {createResearchFixture,loadResearchTestApi} from './fixtures/research-test-kit.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});after(()=>api.dispose());
const rss=(title='First')=>`<rss version="2.0"><channel><title>Feed</title><item><guid>paper-1</guid><title>${title}</title><link>https://arxiv.org/abs/2611.00001</link><description><![CDATA[<p>Abstract</p><script>bad()</script>]]></description><pubDate>Fri, 06 Nov 2026 00:00:00 GMT</pubDate></item></channel></rss>`;
function scene(){const f=createResearchFixture(api,'reading');f.reading=new api.ReadingRepository(f.db,f.repository,()=> '2026-11-07T00:00:00.000Z');return f;}
function paper(f){const record={id:'crossref:10.1234/seed',source:'crossref',externalId:'10.1234/seed',doi:'10.1234/seed',title:'Seed paper',authors:['Author'],abstract:'Seed abstract',publishedYear:2026,citationCount:null,url:null,openAccessUrl:null,importedAt:'2026-11-07T00:00:00.000Z',updatedAt:'2026-11-07T00:00:00.000Z'};return f.repository.library.import([{metadata:record,bibliography:api.bibliographyFromRecord(record,new Set())}],f.project.id).items[0];}

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
 const radar=new api.RadarService(f.reading,{}, {importRecord:async()=>({items:[paper(f)]})},async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,5));return invalid?'<html/>':rss();});
 try{const feed=radar.saveFeed({id:'feed',projectId:f.project.id,title:'Feed',url:'https://example.org/rss',pinned:false,archived:false,expectedRevision:0});
 await Promise.all([radar.refresh(f.project.id,feed.id),radar.refresh(f.project.id,feed.id)]);assert.equal(calls,1);
 const article=radar.articles(f.project.id,feed.id)[0];radar.mark(f.project.id,article.id,true);const imported=await radar.importArticle(f.project.id,article.id);
 await radar.refresh(f.project.id,feed.id);assert.equal(radar.articles(f.project.id,feed.id)[0].importedItemId,imported.itemId);assert.equal(radar.articles(f.project.id,feed.id)[0].read,true);
 invalid=true;await assert.rejects(()=>radar.refresh(f.project.id,feed.id),/RSS/);assert.equal(radar.articles(f.project.id,feed.id).length,1);assert.match(radar.feeds(f.project.id)[0].error,/RSS/);
 }finally{await radar.shutdown();f.close();}
});
test('citation discovery caches pages, preserves marks, validates membership and falls back to Crossref',async()=>{
 const f=scene(),item=paper(f),radar=new api.RadarService(f.reading,{},{});let calls=0,fail=false;
 const discovery=new api.ReadingDiscoveryService(f.reading,radar,async url=>{calls++;if(url.includes('semanticscholar')){if(fail)throw new Error('HTTP 429');return JSON.stringify({data:[{citedPaper:{paperId:'s2',title:'Reference',externalIds:{DOI:'10.1234/ref'},authors:[{name:'A'}]}}],next:100});}return JSON.stringify({message:{reference:[{DOI:'10.1234/fallback','article-title':'Fallback'}]}});});
 try{const request={projectId:f.project.id,itemId:item.id,direction:'references',offset:0,force:false};const result=await discovery.discover(request);assert.equal(result.nextOffset,100);assert.equal(result.articles.length,1);
 radar.mark(f.project.id,result.articles[0].id,true);assert.equal((await discovery.discover(request)).articles[0].read,true);assert.equal(calls,1);
 fail=true;const fallback=await discovery.discover({...request,force:true});assert.equal(fallback.source,'Crossref');assert.equal(fallback.articles[0].doi,'10.1234/fallback');assert.equal(fallback.warnings.length,1);
 const other=f.repository.createProject({title:'Other',description:'',workspacePath:'/tmp/roc-reading-other'});await assert.rejects(()=>discovery.discover({...request,projectId:other.id}),/不属于/);
 }finally{await discovery.shutdown();await radar.shutdown();f.close();}
});
test('Cool venue capture retains PDF metadata and rejects unsupported hosts',async()=>{
 const f=scene(),radar=new api.RadarService(f.reading,{},{}),discovery=new api.ReadingDiscoveryService(f.reading,radar,async()=>'<meta name="citation_title" content="Venue paper"><meta name="citation_authors" content="A; B"><meta name="citation_pdf_url" content="https://example.org/paper.pdf">');
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
 const embeddings={embedReadingTexts:async texts=>{embedded++;if(broken)throw new Error('Embedding unavailable');return {configId:'embedding-fixture',revision:revision+(drift&&texts.length>1?1:0),vectors:texts.map(text=>text.startsWith('Unrelated')?[0,1]:[1,0])};}};
 const radar=new api.RadarService(f.reading,embeddings,{},async()=>{fetched++;return feed;});
 try{
   const first=await radar.recommend(f.project.id,['cs.AI'],false);
   assert.equal(first.cached,false);assert.equal(first.corpusSize,1);assert.deepEqual(first.articles.map(row=>row.title),['Related','Unrelated']);
   assert.equal(first.articles[0].score,1);assert.equal(first.articles[1].score,0);assert.equal(first.articles[0].summary,'Source abstract');
   radar.mark(f.project.id,first.articles[0].id,true);
   const cached=await radar.recommend(f.project.id,['cs.AI'],false);assert.equal(cached.cached,true);assert.equal(cached.articles[0].read,true);assert.equal(fetched,1);assert.equal(embedded,3);
   revision++;const refreshed=await radar.recommend(f.project.id,['cs.AI'],false);assert.equal(refreshed.cached,false);assert.equal(refreshed.articles[0].read,true);assert.equal(fetched,2);
   broken=true;await assert.rejects(()=>radar.recommend(f.project.id,['cs.AI'],false),/unavailable/);broken=false;
   drift=true;await assert.rejects(()=>radar.recommend(f.project.id,['cs.AI'],true),/配置改变/);
   assert.equal(radar.articles(f.project.id,null).length,2,'failed recomputation retains prior articles');
 }finally{await radar.shutdown();f.close();}
});

test('bulk discovery imports persist original scholarly metadata and avoid duplicate library records',async()=>{
 const f=scene(),item=paper(f);let imports=0;
 const radar=new api.RadarService(f.reading,{}, {importRecord:async({projectId,record})=>{imports++;return f.repository.library.import([{metadata:record,bibliography:api.bibliographyFromRecord(record,new Set())}],projectId);}});
 const discovery=new api.ReadingDiscoveryService(f.reading,radar,async()=>JSON.stringify({data:['2611.00003','2611.00004'].map(id=>({citingPaper:{paperId:id,title:`Citing ${id}`,abstract:'Citing abstract',year:2026,externalIds:{ArXiv:id},authors:[{name:'Fixture author'}]}}))}));
 try{
   const result=await discovery.discover({projectId:f.project.id,itemId:item.id,direction:'citations',offset:0,force:false});
   for(const article of result.articles){const added=await radar.importArticle(f.project.id,article.id);const stored=f.repository.library.get(added.itemId);assert.equal(stored.metadata.source,'arxiv');assert.equal(stored.metadata.externalId,article.arxivId);assert.equal(stored.metadata.abstract,'Citing abstract');assert.deepEqual(stored.metadata.authors,['Fixture author']);await radar.importArticle(f.project.id,article.id);}
   assert.equal(imports,2);assert.equal(f.repository.library.list({projectId:f.project.id,includeArchived:false,query:'',limit:100}).length,3);
 }finally{await discovery.shutdown();await radar.shutdown();f.close();}
});
