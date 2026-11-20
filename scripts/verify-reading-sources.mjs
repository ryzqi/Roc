// Opt-in live checks: public synthetic translation text and public academic metadata only.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createResearchFixture,loadResearchTestApi} from '../tests/unit/fixtures/research-test-kit.mjs';

const api=await loadResearchTestApi(),fixture=createResearchFixture(api,'reading');
const reading=new api.ReadingRepository(fixture.db,fixture.repository);
let rssXml='';
const radar=new api.RadarService(reading,{},{},async(url,options)=>{const text=await api.fetchReadingText(url,options);rssXml=text;return text;});
const discovery=new api.ReadingDiscoveryService(reading,radar);
const results=[],values=new Map(),secrets=new Map();
const translation=new api.ReadingTranslationService({
 config:{get:key=>values.get(key),set:(key,value)=>values.set(key,value)},
 secrets:{get:async key=>secrets.get(key)??null,set:async(key,value)=>secrets.set(key,value),clear:key=>secrets.delete(key)},
});
const check=async(name,work)=>{
 const started=Date.now();
 try{const detail=await work();results.push({name,ok:true,elapsedMs:Date.now()-started,detail});console.log(`PASS ${name}`,JSON.stringify(detail));}
 catch(error){results.push({name,ok:false,elapsedMs:Date.now()-started,error:String(error)});console.log(`FAIL ${name}`,String(error));process.exitCode=1;}
};
try{
 await Promise.allSettled([
  check('arXiv RSS through persistent radar service',async()=>{
   const feed=radar.saveFeed({id:'live-arxiv',projectId:fixture.project.id,title:'arXiv cs.AI',url:'https://rss.arxiv.org/rss/cs.AI',pinned:false,archived:false,expectedRevision:0});
   await radar.refresh(fixture.project.id,feed.id);const articles=radar.articles(fixture.project.id,feed.id);
   writeFileSync('.artifacts/reading-radar/live-arxiv.xml',rssXml);
   const published=(rssXml.match(/<item(?:\s|>)/gu)??[]).length;
   assert.equal(articles.length,published);
   if(published)assert.ok(articles.some(article=>article.arxivId));
   else assert.match(rssXml,/<skipDays>[\s\S]*<day>Saturday<\/day>/u);
   return {count:articles.length,first:articles[0]?.title??null,emptySource:published===0};
  }),
  check('Cool Papers metadata capture',async()=>{
   const article=await discovery.capturePage(fixture.project.id,'https://papers.cool/arxiv/1706.03762');
   assert.match(article.title,/Attention/);return {title:article.title,arxivId:article.arxivId,pdfUrl:article.pdfUrl};
  }),
  check('reference discovery with real provider/fallback',async()=>{
   const record={id:'crossref:10.1038/nature14539',source:'crossref',externalId:'10.1038/nature14539',doi:'10.1038/nature14539',title:'Deep learning',authors:['Yann LeCun','Yoshua Bengio','Geoffrey Hinton'],abstract:null,publishedYear:2015,citationCount:null,url:'https://doi.org/10.1038/nature14539',openAccessUrl:null,importedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
   const item=fixture.repository.library.import([{metadata:record,bibliography:api.bibliographyFromRecord(record,new Set())}],fixture.project.id).items[0];
   const result=await discovery.discover({projectId:fixture.project.id,itemId:item.id,direction:'references',offset:0,force:true});
   assert.ok(result.articles.length>0);return {source:result.source,count:result.articles.length,warnings:result.warnings};
  }),
 ]);
 for(const provider of ['google','tencent'])await check(`${provider} live translation`,async()=>{
  await translation.save({provider,baseUrl:provider==='google'?'https://translate.googleapis.com':'https://transmart.qq.com',model:'',region:'',target:'zh-CN',apiKey:null});
  const result=await translation.translate({projectId:fixture.project.id,text:'This synthetic sentence tests academic paper translation.',target:'zh-CN'});
  assert.match(result.text,/[\u3400-\u9fff]/u);return result;
 });
}finally{
 await Promise.allSettled([translation.shutdown(),discovery.shutdown(),radar.shutdown()]);fixture.close();api.dispose();
 mkdirSync('.artifacts/reading-radar',{recursive:true});
 writeFileSync('.artifacts/reading-radar/live-sources.json',JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));
}
