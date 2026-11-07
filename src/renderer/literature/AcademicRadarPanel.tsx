import {useState} from 'react';
import {Radar,Rss,RefreshCw,Pin,Check} from 'lucide-react';
import type {RadarArticle,RadarFeed} from '../../shared/schemas/research-reading';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import RadarBrowser from './RadarBrowser';
import './reading.css';
type Source='feeds'|'daily'|'cool'|'modelscope';
const tabs:{id:Source;label:string}[]=[{id:'cool',label:'Cool Papers'},{id:'modelscope',label:'魔搭论文'},{id:'feeds',label:'RSS 订阅'},{id:'daily',label:'每日 arXiv'}];
export default function AcademicRadarPanel({client,projectId,writable,active,onImported}: {
  client:RocClient;projectId:string;writable:boolean;active:boolean;onImported:()=>void;
}):React.JSX.Element {
  const [source,setSource]=useState<Source>('feeds'),[feedId,setFeedId]=useState<string|null>(null),[unread,setUnread]=useState(false);
  const [filter,setFilter]=useState(''),[type,setType]=useState('all'),[selected,setSelected]=useState<Set<string>>(new Set());
  const [article,setArticle]=useState<RadarArticle|null>(null),[title,setTitle]=useState(''),[url,setUrl]=useState('');
  const [categories,setCategories]=useState('cs.AI, cs.CL, cs.LG, cs.CV, stat.ML'),[daily,setDaily]=useState<RadarArticle[]|null>(null);
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
  const feeds=useAsyncResource(projectId,()=>client.api.research.listRadarFeeds({projectId}),{label:'读取订阅'});
  const articles=useAsyncResource(JSON.stringify([projectId,feedId,unread]),()=>client.api.research.listRadarArticles({projectId,feedId,unread}),{label:'读取订阅文章'});
  const run=async(operation:()=>Promise<void>):Promise<void>=>{setBusy(true);setError(null);try{await operation();}catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}};
  const saveFeed=async(feed:RadarFeed,patch:Partial<RadarFeed>):Promise<void>=>{
    const {revision,refreshedAt:_date,error:_error,...body}=feed;
    const result=await client.api.research.saveRadarFeed({...body,...patch,expectedRevision:revision});if(!result.ok)throw new Error(result.error.message);feeds.reload();
  };
  const addFeed=async(feedTitle:string,feedUrl:string):Promise<void>=>{
    const result=await client.api.research.saveRadarFeed({id:crypto.randomUUID(),projectId,title:feedTitle,url:feedUrl,pinned:false,archived:false,expectedRevision:0});
    if(!result.ok)throw new Error(result.error.message);feeds.reload();setTitle('');setUrl('');setFeedId(result.data.id);
    const refreshed=await client.api.research.refreshRadarFeed({projectId,feedId:result.data.id});articles.reload();feeds.reload();if(!refreshed.ok)throw new Error(refreshed.error.message);
  };
  const refresh=async():Promise<void>=>{
    const targets=(feeds.data??[]).filter(feed=>!feed.archived&&(!feedId||feed.id===feedId));const errors:string[]=[];
    for(const feed of targets){const result=await client.api.research.refreshRadarFeed({projectId,feedId:feed.id});if(!result.ok)errors.push(`${feed.title}: ${result.error.message}`);}
    feeds.reload();articles.reload();setStatus(`刷新了 ${targets.length-errors.length} 个订阅`);if(errors.length)throw new Error(errors.join('\n'));
  };
  const recommend=async(force:boolean):Promise<void>=>{
    setDaily(null);const result=await client.api.research.recommendRadar({projectId,categories:categories.split(/[,，\s]+/u).filter(Boolean),force});
    if(!result.ok)throw new Error(result.error.message);setDaily(result.data.articles);setStatus(`${result.data.date} · 基于 ${result.data.corpusSize} 篇文献${result.data.cached?' · 今日缓存':''}`);articles.reload();
  };
  const importSelected=async(ids:string[]):Promise<void>=>{
    const errors:string[]=[];for(const id of ids){const result=await client.api.research.importRadarArticle({projectId,articleId:id});if(!result.ok)errors.push(result.error.message);}
    articles.reload();onImported();setSelected(new Set());setStatus(`已入库 ${ids.length-errors.length} 篇`);if(errors.length)throw new Error(errors.join('\n'));
  };
  const raw=source==='daily'?daily??[]:(articles.data??[]).filter(value=>(feeds.data??[]).some(feed=>feed.id===value.feedId&&!feed.archived));
  const rows=raw.map(value=>articles.data?.find(current=>current.id===value.id)??value).filter(value=>(!unread||!value.read)&&
    `${value.title} ${value.summary}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())&&(type==='all'||(type==='paper')===(value.arxivId!==null||value.doi!==null)));
  return <section className="flex h-full min-h-0 flex-col" data-testid="radar-panel" aria-label="学术雷达">
    <div className="reading-toolbar" role="tablist" aria-label="发现来源"><Radar size={15}/>{tabs.map(tab=><button type="button" role="tab" aria-selected={source===tab.id} key={tab.id}
      className={source===tab.id?'bg-[var(--accent-soft)] text-accent':''} onClick={()=>{setSource(tab.id);setArticle(null);setError(null);setSelected(new Set());}}>{tab.label}</button>)}</div>
    {source==='cool'||source==='modelscope'?<RadarBrowser key={source} client={client} projectId={projectId} writable={writable} source={source} active={active} onImported={onImported}/>:<>
      {source==='feeds'?<>
        <form className="reading-toolbar" onSubmit={event=>{event.preventDefault();void run(()=>addFeed(title,url));}}>
          <Rss size={14}/><input aria-label="订阅名称" placeholder="订阅名称" required value={title} onChange={event=>setTitle(event.target.value)}/>
          <input aria-label="RSS 地址" placeholder="https://… RSS / Atom" required type="url" value={url} onChange={event=>setUrl(event.target.value)}/>
          <button type="submit" disabled={busy||!writable}>添加订阅</button>
          <button type="button" disabled={busy||!writable} onClick={()=>void run(()=>addFeed('arXiv cs.AI','https://rss.arxiv.org/rss/cs.AI'))}>订阅 cs.AI</button>
        </form>
        <div className="reading-toolbar"><select aria-label="订阅来源" value={feedId??''} onChange={event=>{setFeedId(event.target.value||null);setSelected(new Set());}}>
          <option value="">全部订阅</option>{(feeds.data??[]).filter(feed=>!feed.archived).map(feed=><option key={feed.id} value={feed.id}>{feed.pinned?'[置顶] ':''}{feed.title}</option>)}</select>
          <button type="button" disabled={busy||!writable} onClick={()=>void run(refresh)}><RefreshCw size={13}/>刷新{feedId?'订阅':'全部'}</button>
          <details><summary className="cursor-pointer">管理订阅</summary><div className="space-y-2 py-2">{(feeds.data??[]).map(feed=><div key={feed.id} className="flex flex-wrap items-center gap-2">
            <input aria-label={`重命名 ${feed.title}`} defaultValue={feed.title} key={`${feed.id}:${feed.revision}`} onBlur={event=>{if(event.target.value!==feed.title)void run(()=>saveFeed(feed,{title:event.target.value}));}} disabled={busy||!writable}/>
            <button type="button" disabled={busy||!writable} onClick={()=>void run(()=>saveFeed(feed,{pinned:!feed.pinned}))}><Pin size={12}/>{feed.pinned?'取消置顶':'置顶'}</button>
            <button type="button" disabled={busy||!writable} onClick={()=>void run(()=>saveFeed(feed,{archived:!feed.archived}))}>{feed.archived?'恢复':'移除'}</button>
            {feed.error?<span className="text-[var(--st-warn)]">{feed.error}</span>:<span className="text-muted">{feed.refreshedAt??'未刷新'}</span>}
          </div>)}</div></details>
        </div>
      </>:<div className="reading-toolbar"><label className="text-muted">arXiv 分类</label><input aria-label="推荐分类" value={categories} onChange={event=>setCategories(event.target.value)}/>
        <button type="button" disabled={busy||!writable} onClick={()=>void run(()=>recommend(false))}>获取今日推荐</button><button type="button" disabled={busy||!writable} onClick={()=>void run(()=>recommend(true))}>重新计算</button>
      </div>}
      <div className="reading-toolbar"><input aria-label="筛选论文" placeholder="筛选标题 / 摘要" value={filter} onChange={event=>setFilter(event.target.value)}/>
        <select aria-label="文章类型" value={type} onChange={event=>setType(event.target.value)}><option value="all">全部文章</option><option value="paper">论文</option><option value="other">其他</option></select>
        <label><input type="checkbox" checked={unread} onChange={event=>setUnread(event.target.checked)}/>仅未读</label>
        <button type="button" onClick={()=>setSelected(new Set(rows.map(row=>row.id)))}>全选</button><button type="button" disabled={busy||!writable||selected.size===0} onClick={()=>void run(()=>importSelected([...selected]))}>入库所选 ({selected.size})</button>
      </div>
      {error||feeds.error||articles.error?<p role="alert" className="whitespace-pre-wrap p-2 text-[var(--st-warn)]">{error??feeds.error??articles.error}</p>:null}
      <p role="status" className="px-3 py-1 text-muted">{busy?'正在处理…':status||`${rows.length} 篇文章`}</p>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-y-auto px-3" data-testid="radar-articles">
          {rows.length===0&&!busy?<p className="py-8 text-center text-muted">{source==='daily'?'根据项目文献生成今日推荐。需先启用嵌入模型。':'添加订阅并刷新后，文章将保存在这里。'}</p>:rows.map(row=><article key={row.id} className="border-b border-line py-3">
            <div className="flex items-start gap-2"><input type="checkbox" aria-label={`选择 ${row.title}`} checked={selected.has(row.id)} onChange={event=>setSelected(current=>{const next=new Set(current);if(event.target.checked)next.add(row.id);else next.delete(row.id);return next;})}/>
              <button type="button" className={`text-left ${row.read?'text-muted':'font-medium text-ink'}`} onClick={()=>{setArticle(row);if(writable)void run(async()=>{const result=await client.api.research.markRadarArticle({projectId,articleId:row.id,read:true});if(!result.ok)throw new Error(result.error.message);articles.reload();});}}>{row.title}</button></div>
            <p className="mt-1 line-clamp-2 text-muted">{row.summary}</p><div className="mt-2 flex flex-wrap items-center gap-3 text-[var(--font-meta-size)] text-muted"><span>{row.publishedAt?.slice(0,10)??'日期未知'}</span>
              {row.score!==null?<span>相关度 {row.score.toFixed(3)}</span>:null}<span>{row.read?'已读':'未读'}</span>
              {row.importedItemId?<span className="inline-flex items-center gap-1"><Check size={12}/>已入库</span>:<button className="text-accent" type="button" disabled={busy||!writable} onClick={()=>void run(()=>importSelected([row.id]))}>加入文献库</button>}
            </div>
          </article>)}
        </div>
        {article?<aside className="w-[45%] min-w-0 overflow-y-auto border-l border-line p-3"><button type="button" onClick={()=>setArticle(null)}>关闭详情</button><h3 className="my-3 font-semibold">{article.title}</h3><p className="text-muted">{article.authors.join(', ')}</p><p className="my-3 whitespace-pre-wrap">{article.summary}</p><p className="break-all text-muted">{article.url}</p>
          <div className="reading-toolbar"><button type="button" disabled={busy||!writable} onClick={()=>void run(()=>importSelected([article.id]))}>入库</button><button type="button" disabled={busy||!writable} onClick={()=>void run(async()=>{const result=await client.api.research.markRadarArticle({projectId,articleId:article.id,read:false});if(!result.ok)throw new Error(result.error.message);articles.reload();setArticle(null);})}>标为未读</button></div>
        </aside>:null}
      </div>
    </>}
  </section>;
}
