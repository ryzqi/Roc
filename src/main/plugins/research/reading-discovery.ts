import {createHash} from 'node:crypto';
import {z} from 'zod';
import {Parser} from 'htmlparser2';
import type {ReadingRepository} from './reading-repository';
import type {RadarService} from './radar-service';
import {fetchReadingText,type ReadingFetch} from './reading-network';
import {plainArticleText} from './radar-parser';
import {readingDiscoveryRequestSchema,readingDiscoveryResultSchema,type RadarArticle} from '../../../shared/schemas/research-reading';
const paperSchema=z.object({paperId:z.string().nullable().optional(),title:z.string().nullable(),abstract:z.string().nullable().optional(),year:z.number().nullable().optional(),
  authors:z.array(z.object({name:z.string()})).optional(),externalIds:z.record(z.string(),z.string().nullable()).nullable().optional(),url:z.string().nullable().optional()});
const pageSchema=z.object({data:z.array(z.object({citedPaper:paperSchema.nullable().optional(),citingPaper:paperSchema.nullable().optional()})),next:z.number().int().nonnegative().optional()});
export class ReadingDiscoveryService {
  private readonly controller=new AbortController();
  private readonly jobs=new Set<Promise<unknown>>();
  constructor(private readonly reading:ReadingRepository,private readonly radar:RadarService,private readonly fetchText:ReadingFetch=fetchReadingText){}
  private track<T>(work:()=>Promise<T>):Promise<T>{this.controller.signal.throwIfAborted();const task=work();this.jobs.add(task);void task.finally(()=>this.jobs.delete(task)).catch(()=>{});return task;}
  async shutdown():Promise<void>{this.controller.abort();await Promise.allSettled([...this.jobs]);}
  discover(raw:z.infer<typeof readingDiscoveryRequestSchema>):Promise<z.infer<typeof readingDiscoveryResultSchema>>{return this.track(()=>this.discoverOne(raw));}
  private async discoverOne(raw:z.infer<typeof readingDiscoveryRequestSchema>):Promise<z.infer<typeof readingDiscoveryResultSchema>>{
    const input=readingDiscoveryRequestSchema.parse(raw);this.reading.scope(input.projectId,true);
    const item=this.reading.research.library.get(input.itemId);
    if(!item.projectIds.includes(input.projectId)||item.archived)throw new Error('文献不属于当前项目或已归档。');
    const feedId=`relations:${input.projectId}:${item.id}:${input.direction}`,cacheKey=`${feedId}:${input.offset}:${item.revision}`;
    const cached=this.reading.db.prepare('SELECT snapshot_json FROM research_radar_recommendations WHERE project_id=? AND cache_key=?').get(input.projectId,cacheKey) as {snapshot_json:string}|undefined;
    if(cached&&!input.force){const result=readingDiscoveryResultSchema.parse(JSON.parse(cached.snapshot_json));const current=new Map(this.radar.articles(input.projectId,null).map(article=>[article.id,article]));return {...result,articles:result.articles.map(article=>current.get(article.id)??article),cached:true};}
    const warnings:string[]=[];let articles:RadarArticle[]=[];let source='Semantic Scholar',nextOffset:number|null=null;
    const doi=item.metadata.doi,arxiv=item.metadata.source==='arxiv'?item.metadata.externalId:null;
    const identifier=doi?`DOI:${doi}`:arxiv?`ARXIV:${arxiv}`:null;
    if(identifier){try{
      const url=`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(identifier)}/${input.direction}?offset=${input.offset}&limit=100&fields=title,authors,abstract,year,externalIds,url`;
      const page=pageSchema.parse(JSON.parse(await this.fetchText(url,{signal:this.controller.signal})));
      nextOffset=page.next??null;
      articles=page.data.flatMap(row=>{const paper=input.direction==='references'?row.citedPaper:row.citingPaper;if(!paper?.title)return [];
        const doi=paper.externalIds?.DOI??null,arxivId=paper.externalIds?.ArXiv??null;
        const identity=doi??arxivId??paper.paperId;if(!identity)return [];
        return [this.article(feedId,identity,{title:paper.title,summary:paper.abstract??'',authors:paper.authors?.map(author=>author.name)??[],doi,arxivId,
          url:doi?`https://doi.org/${doi}`:arxivId?`https://arxiv.org/abs/${arxivId}`:paper.url??`https://www.semanticscholar.org/paper/${paper.paperId}`,
          publishedAt:paper.year?`${paper.year}-01-01T00:00:00.000Z`:null})];});
    }catch(error){warnings.push(`Semantic Scholar：${String(error)}`);}}
    if(!articles.length&&input.direction==='references'&&doi&&input.offset===0){try{
      const payload=z.object({message:z.object({reference:z.array(z.object({DOI:z.string().optional(),'article-title':z.string().optional(),unstructured:z.string().optional(),author:z.string().optional(),year:z.string().optional()})).optional()})})
        .parse(JSON.parse(await this.fetchText(`https://api.crossref.org/works/${encodeURIComponent(doi)}`,{signal:this.controller.signal})));
      articles=(payload.message.reference??[]).flatMap(reference=>reference.DOI?[this.article(feedId,reference.DOI,{title:reference['article-title']??reference.unstructured??reference.DOI,doi:reference.DOI,url:`https://doi.org/${reference.DOI}`,summary:reference.unstructured??'',authors:reference.author?[reference.author]:[]})]:[]);
      source='Crossref';
    }catch(error){warnings.push(`Crossref：${String(error)}`);}}
    if(!articles.length&&input.direction==='references'&&input.offset===0){
      source='本地解析：参考文献 DOI';
      for(const document of this.reading.research.documents.list(item.id)){
        if(!document.currentParseId)continue;
        const {data}=this.reading.research.documents.parsed(document.id,document.currentParseId);
        const start=data.content.blocks.findIndex(block=>block.kind==='heading'&&/^(?:\d+\.?\s*)?(?:references|bibliography|参考文献)\s*$/iu.test(block.text.trim()));
        if(start<0)continue;
        for(const block of data.content.blocks.slice(start+1)){
          if(block.kind==='heading'&&!/references|bibliography|参考文献/iu.test(block.text))break;
          for(const match of block.text.matchAll(/\b10\.\d{4,9}\/[\w.()/:;-]+/giu)){
            const found=match[0].replace(/[.,;]+$/u,'');articles.push(this.article(feedId,found,{title:found,doi:found,url:`https://doi.org/${found}`,summary:block.text}));
          }
        }
      }
    }
    this.controller.signal.throwIfAborted();this.reading.scope(input.projectId,true);
    if(this.reading.research.library.get(item.id).revision!==item.revision)throw new Error('查询期间文献已更新，请重试。');
    if(!articles.length&&warnings.length)throw new Error(warnings.join('\n'));
    const unique=[...new Map(articles.map(article=>[article.id,article])).values()];
    const result=readingDiscoveryResultSchema.parse({articles:this.radar.captureArticles(input.projectId,unique),source,fetchedAt:this.reading.now(),cached:false,nextOffset,warnings});
    this.reading.db.prepare('INSERT OR REPLACE INTO research_radar_recommendations(project_id,cache_key,snapshot_json) VALUES(?,?,?)').run(input.projectId,cacheKey,JSON.stringify(result));
    return result;
  }
  capturePage(projectId:string,raw:string):Promise<RadarArticle>{return this.track(async()=>{
    this.reading.scope(projectId,true);const url=new URL(raw);
    if(url.origin!=='https://papers.cool'||!/^\/(?:arxiv|venue)\/[^/]+$/u.test(url.pathname))throw new Error('请选择 Cool Papers 的论文详情页。');
    const html=await this.fetchText(url.href,{signal:this.controller.signal}),metadata=new Map<string,string[]>();
    const parser=new Parser({onopentag(name,attrs){if(name!=='meta'||!attrs.name||!attrs.content)return;const key=attrs.name.toLowerCase();metadata.set(key,[...(metadata.get(key)??[]),attrs.content]);}},{decodeEntities:true});parser.write(html);parser.end();
    const first=(key:string)=>metadata.get(key)?.[0]??'';const title=first('citation_title');if(!title)throw new Error('页面未提供 citation_title，无法可靠入库。');
    const arxivId=/^\/arxiv\/(.+)$/u.exec(url.pathname)?.[1]??null,doi=first('citation_doi')||null;
    const value=this.article(`cool:${projectId}`,url.href,{title,doi,arxivId,url:first('citation_public_url')||url.href,pdfUrl:first('citation_pdf_url')||null,publisher:first('citation_publisher')||null,publishedAt:first('citation_date')||first('citation_publication_date')||null,summary:plainArticleText(first('citation_abstract')),authors:metadata.get('citation_author')??first('citation_authors').split(';').map(value=>value.trim()).filter(Boolean)});
    this.controller.signal.throwIfAborted();return this.radar.captureArticles(projectId,[value])[0]!;
  });}
  private article(feedId:string,identity:string,fields:Partial<RadarArticle>&Pick<RadarArticle,'title'|'url'>):RadarArticle{return {id:createHash('sha256').update(`${feedId}:${identity}`).digest('hex'),feedId,summary:'',authors:[],publishedAt:null,arxivId:null,doi:null,read:false,importedItemId:null,score:null,...fields};}
}
