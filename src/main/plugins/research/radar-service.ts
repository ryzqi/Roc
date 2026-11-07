import {createHash} from 'node:crypto';
import type {z} from 'zod';
import {radarFeedSchema, radarFeedSaveSchema, radarArticleSchema, radarRecommendationsSchema,
  type RadarArticle, type RadarFeed} from '../../../shared/schemas/research-reading';
import type {ReadingRepository} from './reading-repository';
import type {ResearchEmbeddingService} from './embedding-service';
import type {ResearchLibraryService} from './library-service';
import {fetchReadingText, publicReadingUrl, type ReadingFetch} from './reading-network';
import {parseRadarFeed, cosineSimilarity} from './radar-parser';

export class RadarService {
  private readonly controller = new AbortController();
  private readonly refreshes = new Map<string, Promise<RadarFeed>>();
  constructor(readonly reading: ReadingRepository, private readonly embeddings: ResearchEmbeddingService,
    private readonly library: ResearchLibraryService, private readonly fetchText: ReadingFetch = fetchReadingText) {}
  private readonly jobs=new Set<Promise<unknown>>();
  private track<T>(work:()=>Promise<T>):Promise<T>{this.controller.signal.throwIfAborted();const task=work();this.jobs.add(task);void task.finally(()=>this.jobs.delete(task)).catch(()=>{});return task;}
  async shutdown(): Promise<void> {this.controller.abort();await Promise.allSettled([...this.jobs,...this.refreshes.values()]);}
  feeds(projectId: string): RadarFeed[] {
    this.reading.scope(projectId);
    return (this.reading.db.prepare('SELECT snapshot_json FROM research_radar_feeds WHERE project_id=?').all(projectId) as {snapshot_json:string}[])
      .map(row => radarFeedSchema.parse(JSON.parse(row.snapshot_json))).sort((a,b) => Number(b.pinned)-Number(a.pinned) || a.title.localeCompare(b.title));
  }
  saveFeed(raw: z.infer<typeof radarFeedSaveSchema>): RadarFeed {
    const input = radarFeedSaveSchema.parse(raw); this.reading.scope(input.projectId, true); publicReadingUrl(input.url);
    const prior = this.feeds(input.projectId).find(feed => feed.id === input.id);
    if ((prior?.revision ?? 0) !== input.expectedRevision) throw new Error('订阅已更新，请刷新。');
    if (this.feeds(input.projectId).some(feed => feed.id !== input.id && !feed.archived && feed.url === input.url)) throw new Error('已订阅此地址。');
    const {expectedRevision, ...body} = input;
    const feed = radarFeedSchema.parse({...body, revision: expectedRevision + 1, refreshedAt: prior?.refreshedAt ?? null, error: prior?.error ?? null});
    const result = this.reading.db.prepare(`INSERT INTO research_radar_feeds(id,project_id,snapshot_json) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET snapshot_json=excluded.snapshot_json WHERE research_radar_feeds.project_id=excluded.project_id`)
      .run(feed.id,feed.projectId,JSON.stringify(feed));
    if (!result.changes) throw new Error('订阅 ID 冲突。');
    return feed;
  }
  articles(projectId: string, feedId: string | null, unread = false): RadarArticle[] {
    this.reading.scope(projectId);
    return (this.reading.db.prepare(`SELECT snapshot_json FROM research_radar_articles WHERE project_id=? AND (? IS NULL OR feed_id=?)`)
      .all(projectId,feedId,feedId) as {snapshot_json:string}[]).map(row => radarArticleSchema.parse(JSON.parse(row.snapshot_json)))
      .filter(article => !unread || !article.read).sort((a,b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  }
  captureArticles(projectId:string,articles:RadarArticle[]):RadarArticle[]{
    this.reading.scope(projectId,true);const old=new Map(this.articles(projectId,null).map(article=>[article.id,article]));
    return this.reading.db.transaction(()=>articles.map(article=>{const value={...article,read:old.get(article.id)?.read??false,importedItemId:old.get(article.id)?.importedItemId??null};this.store(projectId,value);return value;}))();
  }
  private store(projectId: string, article: RadarArticle): void {
    const result=this.reading.db.prepare(`INSERT INTO research_radar_articles(id,project_id,feed_id,snapshot_json) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET snapshot_json=excluded.snapshot_json WHERE research_radar_articles.project_id=excluded.project_id`)
      .run(article.id,projectId,article.feedId,JSON.stringify(article));
    if(result.changes!==1)throw new Error('雷达文章 ID 已用于其他项目。');
  }
  private article(projectId: string, id: string): RadarArticle {
    const value = this.articles(projectId,null).find(article => article.id === id);
    if (!value) throw new Error('文章不存在或不属于当前项目。'); return value;
  }
  mark(projectId: string, id: string, read: boolean): RadarArticle {
    this.reading.scope(projectId,true); const article = {...this.article(projectId,id),read}; this.store(projectId,article); return article;
  }
  async refresh(projectId: string, feedId: string): Promise<RadarFeed> {
    this.reading.scope(projectId,true);
    const key = `${projectId}:${feedId}`, pending = this.refreshes.get(key);
    if (pending) return pending;
    const operation = this.refreshOne(projectId,feedId); this.refreshes.set(key,operation);
    try {return await operation;} finally {this.refreshes.delete(key);}
  }
  private async refreshOne(projectId: string, feedId: string): Promise<RadarFeed> {
    const feed = this.feeds(projectId).find(feed => feed.id === feedId && !feed.archived);
    if (!feed) throw new Error('订阅不存在或已移除。');
    try {
      const parsed = parseRadarFeed(await this.fetchText(feed.url,{signal:this.controller.signal}),feed.id,feed.url);
      this.reading.scope(projectId,true); this.controller.signal.throwIfAborted();
      return this.reading.db.transaction(() => {
        const current = this.feeds(projectId).find(value => value.id === feedId);
        if (!current || current.revision !== feed.revision) throw new Error('刷新期间订阅已改变，请重试。');
        const old = new Map(this.articles(projectId,feedId).map(article => [article.id,article]));
        for (const article of parsed) this.store(projectId,{...article,read:old.get(article.id)?.read ?? false,importedItemId:old.get(article.id)?.importedItemId ?? null});
        const updated = {...current,refreshedAt:this.reading.now(),error:null};
        this.reading.db.prepare('UPDATE research_radar_feeds SET snapshot_json=? WHERE id=? AND project_id=?').run(JSON.stringify(updated),feedId,projectId);
        return updated;
      })();
    } catch (error) {
      const current = this.feeds(projectId).find(value => value.id === feedId);
      if (current?.revision === feed.revision && !this.controller.signal.aborted) this.reading.db.prepare('UPDATE research_radar_feeds SET snapshot_json=? WHERE id=? AND project_id=?')
        .run(JSON.stringify({...current,error:error instanceof Error ? error.message : String(error)}),feedId,projectId);
      throw error;
    }
  }
  importArticle(projectId:string,articleId:string):Promise<{itemId:string}>{return this.track(()=>this.importOne(projectId,articleId));}
  private async importOne(projectId: string, articleId: string): Promise<{itemId:string}> {
    this.reading.scope(projectId,true); const article = this.article(projectId,articleId);
    if (article.importedItemId) {
      const item = this.reading.research.library.get(article.importedItemId);
      if (item.archived) throw new Error('此文献已归档，请先在文献库恢复。');
      if (item.projectIds.includes(projectId)) return {itemId:item.id};
    }
    const now = this.reading.now();
    const result = article.doi ? await this.library.importDoi({projectId,doi:article.doi}) : await this.library.importRecord({projectId,citationKey:`radar_${article.id.slice(0,12)}`,
      record:{id:`${article.arxivId ? 'arxiv' : 'rss'}:${article.arxivId ?? article.id}`,source:article.arxivId ? 'arxiv' : 'local',
        externalId:article.arxivId ?? article.url,doi:null,title:article.title,authors:article.authors,abstract:article.summary || null,
        publishedYear:article.publishedAt ? new Date(article.publishedAt).getUTCFullYear() : null,citationCount:null,url:article.url,
        openAccessUrl:article.pdfUrl ?? (article.arxivId ? `https://arxiv.org/pdf/${article.arxivId}` : null),importedAt:now,updatedAt:now}});
    const item = result.items[0]; if (!item) throw new Error('入库没有返回文献，请重试。');
    this.store(projectId,{...this.article(projectId,articleId),importedItemId:item.id,read:true}); return {itemId:item.id};
  }
  recommend(projectId:string,categories:string[],force:boolean):Promise<z.infer<typeof radarRecommendationsSchema>>{return this.track(()=>this.recommendOne(projectId,categories,force));}
  private async recommendOne(projectId: string, categories: string[], force: boolean): Promise<z.infer<typeof radarRecommendationsSchema>> {
    this.reading.scope(projectId,true);
    const corpus = this.reading.research.library.list({projectId,includeArchived:false,query:'',limit:500}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    if (!corpus.length) throw new Error('项目文献库为空，先导入论文以建立兴趣画像。');
    // Probe even on cache hits: a broken current endpoint must not appear to work from old results.
    const probe = await this.embeddings.embedReadingTexts(['academic recommendation endpoint probe'],this.controller.signal);
    const date = this.reading.now().slice(0,10), sorted = [...new Set(categories)].sort();
    const cacheKey = createHash('sha256').update(JSON.stringify([date,sorted,probe.configId,probe.revision,corpus.map(item=>[item.id,item.revision])])).digest('hex');
    const cached = this.reading.db.prepare('SELECT snapshot_json FROM research_radar_recommendations WHERE project_id=? AND cache_key=?').get(projectId,cacheKey) as {snapshot_json:string}|undefined;
    if(cached&&!force){const result=radarRecommendationsSchema.parse(JSON.parse(cached.snapshot_json));const current=new Map(this.articles(projectId,null).map(article=>[article.id,article]));return {...result,articles:result.articles.map(article=>current.get(article.id)??article),cached:true};}
    const candidates = new Map<string,RadarArticle>();
    for (const category of sorted) {
      const url = `https://rss.arxiv.org/rss/${category}`, feedId = `daily:${projectId}:${category}`;
      for (const article of parseRadarFeed(await this.fetchText(url,{signal:this.controller.signal}),feedId,url)) {
        if (article.arxivId && !corpus.some(item => item.metadata.source==='arxiv' && item.metadata.externalId.replace(/v\d+$/u,'') === article.arxivId!.replace(/v\d+$/u,'')))
          candidates.set(article.arxivId.replace(/v\d+$/u,''),article);
      }
    }
    if (!candidates.size) throw new Error('所选分类本期没有尚未入库的 arXiv 论文。');
    const papers = [...candidates.values()].slice(0,200);
    const embedded = await this.embeddings.embedReadingTexts([...corpus.map(item=>`${item.metadata.title}\n${item.metadata.abstract ?? ''}`.slice(0,8000)),
      ...papers.map(article=>`${article.title}\n${article.summary}`.slice(0,8000))],this.controller.signal);
    if (embedded.configId !== probe.configId || embedded.revision !== probe.revision) throw new Error('推荐期间嵌入配置改变，请重试。');
    const profile = embedded.vectors.slice(0,corpus.length);
    const weights = profile.map((_,index)=>1/(1+Math.log10(index+1)));
    const totalWeight = weights.reduce((sum,value)=>sum+value,0);
    const articles = papers.map((article,index) => ({...article,score:profile.reduce((sum,vector,rank)=>sum+cosineSimilarity(vector,embedded.vectors[corpus.length+index]!)*weights[rank]!/totalWeight,0)}))
      .sort((a,b)=>b.score-a.score).slice(0,20);
    this.reading.scope(projectId,true); this.controller.signal.throwIfAborted();
    return this.reading.db.transaction(()=>{
      const result = radarRecommendationsSchema.parse({date,cached:false,corpusSize:corpus.length,configId:embedded.configId,
        articles:this.captureArticles(projectId,articles)});
      this.reading.db.prepare('INSERT OR REPLACE INTO research_radar_recommendations(project_id,cache_key,snapshot_json) VALUES(?,?,?)')
        .run(projectId,cacheKey,JSON.stringify(result));
      return result;
    })();
  }
}
