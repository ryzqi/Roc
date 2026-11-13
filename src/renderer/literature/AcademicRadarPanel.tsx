import {useEffect,useRef,useState} from 'react';
import {Radar,Rss,RefreshCw,Pin,Check} from 'lucide-react';
import type {RadarArticle,RadarFeed} from '../../shared/schemas/research-reading';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {useImeGuard} from '../shared/hooks/use-ime-guard';
import {LiteratureEditorBoundary,useLiteratureEditor} from './literature-editor-guard';
import RadarBrowser from './RadarBrowser';
import './reading.css';
type Source='feeds'|'daily'|'cool'|'modelscope';
const tabs:{id:Source;label:string}[]=[{id:'cool',label:'Cool Papers'},{id:'modelscope',label:'魔搭论文'},{id:'feeds',label:'RSS 订阅'},{id:'daily',label:'每日 arXiv'}];
type Props={
  client:RocClient;projectId:string;writable:boolean;active:boolean;onImported:()=>void;
};
type RenameDraft={value:string;original:RadarFeed};
export default function AcademicRadarPanel(props:Props):React.JSX.Element {
  return <LiteratureEditorBoundary key={props.projectId} projectId={props.projectId} protectReadingChange={false}>
    <AcademicRadarContent {...props}/>
  </LiteratureEditorBoundary>;
}
function AcademicRadarContent({client,projectId,writable,active,onImported}:Props):React.JSX.Element {
  const [source,setSource]=useState<Source>('feeds'),[feedId,setFeedId]=useState<string|null>(null),[unread,setUnread]=useState(false);
  const [filter,setFilter]=useState(''),[type,setType]=useState('all'),[selected,setSelected]=useState<Set<string>>(new Set());
  const [article,setArticle]=useState<RadarArticle|null>(null),[title,setTitle]=useState(''),[url,setUrl]=useState('');
  const [categories,setCategories]=useState('cs.AI, cs.CL, cs.LG, cs.CV, stat.ML'),[daily,setDaily]=useState<RadarArticle[]|null>(null);
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
  const mounted=useRef(true),pending=useRef(false),ime=useImeGuard();
  const draft=useRef({title:'',url:'',names:new Map<string,RenameDraft>()});
  const [names,setNames]=useState<ReadonlyMap<string,RenameDraft>>(draft.current.names);
  const guard=useLiteratureEditor({label:'RSS 订阅',busy:()=>pending.current,
    dirty:()=>draft.current.title!==''||draft.current.url!==''||[...draft.current.names.values()].some(name=>name.value!==name.original.title),
    discard:()=>{draft.current={title:'',url:'',names:new Map()};setTitle('');setUrl('');setNames(draft.current.names);}});
  const updateName=(feed:RadarFeed,value:string):void=>{
    if(pending.current)return;
    const next=new Map(draft.current.names);
    const original=next.get(feed.id)?.original??feed;
    if(value===original.title)next.delete(feed.id);else next.set(feed.id,{value,original});
    draft.current.names=next;setNames(next);
  };
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const feeds=useAsyncResource(projectId,()=>client.api.research.listRadarFeeds({projectId}),{label:'读取订阅'});
  const articles=useAsyncResource(JSON.stringify([projectId,feedId,unread]),()=>client.api.research.listRadarArticles({projectId,feedId,unread}),{label:'读取订阅文章'});
  const run=async(operation:()=>Promise<void>):Promise<void>=>{
    if(pending.current||!mounted.current||!writable)return;
    pending.current=true;guard.notify();setBusy(true);setError(null);setStatus('');
    try{await operation();}
    catch(error){if(mounted.current)setError(error instanceof Error?error.message:String(error));}
    finally{pending.current=false;if(mounted.current){setBusy(false);guard.notify();}}
  };
  const saveFeed=async(feed:RadarFeed,patch:Partial<RadarFeed>):Promise<void>=>{
    const {revision,refreshedAt:_date,error:_error,...body}=feed;
    const result=await client.api.research.saveRadarFeed({...body,...patch,expectedRevision:revision});
    if(!mounted.current)return;if(!result.ok)throw new Error(result.error.message);feeds.reload();
  };
  const rename=async(feed:RadarFeed):Promise<void>=>{
    const name=draft.current.names.get(feed.id);
    if(!name||name.value===name.original.title)return;
    const {revision,refreshedAt:_date,error:_error,...body}=name.original;
    const result=await client.api.research.saveRadarFeed({...body,title:name.value,expectedRevision:revision});
    if(!mounted.current)return;
    if(!result.ok)throw new Error(result.error.message);
    const next=new Map(draft.current.names);next.set(feed.id,{value:result.data.title,original:result.data});
    draft.current.names=next;setNames(next);feeds.reload();setStatus('订阅名称已保存');
  };
  const addFeed=async(feedTitle:string,feedUrl:string,clearForm:boolean):Promise<void>=>{
    const result=await client.api.research.saveRadarFeed({id:crypto.randomUUID(),projectId,title:feedTitle,url:feedUrl,pinned:false,archived:false,expectedRevision:0});
    if(!mounted.current)return;
    if(!result.ok)throw new Error(result.error.message);
    feeds.reload();setFeedId(result.data.id);
    if(clearForm){draft.current.title='';draft.current.url='';setTitle('');setUrl('');}
    const refreshed=await client.api.research.refreshRadarFeed({projectId,feedId:result.data.id});
    if(!mounted.current)return;articles.reload();feeds.reload();if(!refreshed.ok)throw new Error(refreshed.error.message);
  };
  const refresh=async():Promise<void>=>{
    const targets=(feeds.data??[]).filter(feed=>!feed.archived&&(!feedId||feed.id===feedId));const errors:string[]=[];
    for(const feed of targets){
      if(!mounted.current)return;
      try{const result=await client.api.research.refreshRadarFeed({projectId,feedId:feed.id});if(!result.ok)throw new Error(result.error.message);}
      catch(error){errors.push(`${feed.title}: ${error instanceof Error?error.message:String(error)}`);}
    }
    if(!mounted.current)return;
    feeds.reload();articles.reload();setStatus(`刷新了 ${(targets.length-errors.length).toLocaleString('zh-CN')} 个订阅`);if(errors.length)throw new Error(errors.join('\n'));
  };
  const recommend=async(force:boolean):Promise<void>=>{
    setDaily(null);const result=await client.api.research.recommendRadar({projectId,categories:categories.split(/[,，\s]+/u).filter(Boolean),force});
    if(!mounted.current)return;
    if(!result.ok)throw new Error(result.error.message);setDaily(result.data.articles);setStatus(`${result.data.date}，基于 ${result.data.corpusSize.toLocaleString('zh-CN')} 篇文献${result.data.cached?'，今日缓存':''}`);articles.reload();
  };
  const importSelected=async(ids:string[]):Promise<void>=>{
    const targets=[...new Set(ids)].filter(id=>{
      const row=articles.data?.find(row=>row.id===id)??daily?.find(row=>row.id===id);
      return row!==undefined&&row.importedItemId===null;
    });
    const errors:string[]=[],committed=new Set<string>();
    for(const id of targets){
      if(!mounted.current)return;
      try{
        const result=await client.api.research.importRadarArticle({projectId,articleId:id});
        if(!mounted.current)return;
        if(!result.ok)throw new Error(result.error.message);
        committed.add(id);
        const update=(row:RadarArticle):RadarArticle=>row.id===id?{...row,importedItemId:result.data.itemId,read:true}:row;
        setDaily(previous=>previous?.map(update)??null);setArticle(previous=>previous?update(previous):null);
      }catch(error){errors.push(error instanceof Error?error.message:String(error));}
    }
    if(!mounted.current)return;
    articles.reload();setSelected(previous=>new Set([...previous].filter(id=>!committed.has(id))));
    setStatus(`已入库 ${committed.size.toLocaleString('zh-CN')} 篇`);
    if(committed.size>0)onImported();if(errors.length)throw new Error(errors.join('\n'));
  };
  const raw=source==='daily'?daily??[]:(articles.data??[]).filter(value=>(feeds.data??[]).some(feed=>feed.id===value.feedId&&!feed.archived));
  const rows=raw.map(value=>articles.data?.find(current=>current.id===value.id)??value).filter(value=>(!unread||!value.read)&&
    `${value.title} ${value.summary}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())&&(type==='all'||(type==='paper')===(value.arxivId!==null||value.doi!==null)));
  const selectSource=(next:Source):void=>{
    if(pending.current)return;setSource(next);setArticle(null);setError(null);setSelected(new Set());
  };
  const filtered=filter!==''||type!=='all'||unread;
  const loading=source==='feeds'&&(feeds.status==='loading'||articles.status==='loading');
  return <section className="flex h-full min-h-0 flex-col" data-testid="radar-panel" aria-label="学术雷达">
    <div className="reading-toolbar" role="tablist" aria-label="发现来源"><Radar size={15} aria-hidden="true"/>{tabs.map((tab,index)=><button type="button" role="tab" aria-selected={source===tab.id} tabIndex={source===tab.id?0:-1} key={tab.id}
      disabled={busy} className={source===tab.id?'bg-[var(--accent-soft)] text-accent':''} onClick={()=>selectSource(tab.id)}
      onKeyDown={event=>{
        if(pending.current||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
        const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:null;
        if(next===null)return;event.preventDefault();selectSource(tabs[next]!.id);
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus({preventScroll:true});
      }}>{tab.label}</button>)}</div>
    {source==='cool'||source==='modelscope'?<RadarBrowser key={source} client={client} projectId={projectId} writable={writable} source={source} active={active} onImported={onImported}
      onBusyChange={value=>{pending.current=value;if(mounted.current){setBusy(value);guard.notify();}}}/>:<>
      {source==='feeds'?<>
        <form className="reading-toolbar" onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={event=>{if(event.key==='Enter'&&ime.shouldIgnoreKeyDown(event))event.preventDefault();}}
          onSubmit={event=>{event.preventDefault();void run(()=>addFeed(draft.current.title,draft.current.url,true));}}>
          <Rss size={14} aria-hidden="true"/><input aria-label="订阅名称" placeholder="订阅名称" required disabled={busy||!writable} value={title} onChange={event=>{if(!pending.current){draft.current.title=event.target.value;setTitle(event.target.value);}}}/>
          <input aria-label="RSS 地址" placeholder="https://… RSS / Atom" required type="url" disabled={busy||!writable} value={url} onChange={event=>{if(!pending.current){draft.current.url=event.target.value;setUrl(event.target.value);}}}/>
          <button type="submit" disabled={busy||!writable}>添加订阅</button>
          <button type="button" disabled={busy||!writable} onClick={()=>void run(()=>addFeed('arXiv cs.AI','https://rss.arxiv.org/rss/cs.AI',false))}>订阅 cs.AI</button>
        </form>
        <div className="reading-toolbar"><select aria-label="订阅来源" disabled={busy} value={feedId??''} onChange={event=>{if(pending.current)return;setFeedId(event.target.value||null);setSelected(new Set());}}>
          <option value="">全部订阅</option>{(feeds.data??[]).filter(feed=>!feed.archived).map(feed=><option key={feed.id} value={feed.id}>{feed.pinned?'[置顶] ':''}{feed.title}</option>)}</select>
          <button type="button" disabled={busy||!writable} onClick={()=>void run(refresh)}><RefreshCw size={13}/>刷新{feedId?'订阅':'全部'}</button>
          <details><summary className="cursor-pointer">管理订阅</summary><div className="space-y-2 py-2">{(feeds.data??[]).map(feed=><div key={feed.id} className="flex flex-wrap items-center gap-2">
            <input aria-label={`重命名 ${feed.title}`} value={names.get(feed.id)?.value??feed.title} onChange={event=>updateName(feed,event.target.value)} disabled={busy||!writable}/>
            <button type="button" disabled={busy||!writable||!names.get(feed.id)?.value.trim()||names.get(feed.id)?.value===names.get(feed.id)?.original.title}
              onClick={()=>void run(()=>rename(feed))}>保存名称</button>
            {names.get(feed.id)&&names.get(feed.id)?.value!==names.get(feed.id)?.original.title?<button type="button" disabled={busy}
              onClick={()=>guard.request(()=>{const next=new Map(draft.current.names);next.delete(feed.id);draft.current.names=next;setNames(next);},`将放弃“${feed.title}”尚未保存的名称。`)}>放弃修改</button>:null}
            <button type="button" disabled={busy||!writable} onClick={()=>void run(()=>saveFeed(feed,{pinned:!feed.pinned}))}><Pin size={12}/>{feed.pinned?'取消置顶':'置顶'}</button>
            <button type="button" disabled={busy||!writable} onClick={()=>void run(()=>saveFeed(feed,{archived:!feed.archived}))}>{feed.archived?'恢复':'移除'}</button>
            {feed.error?<span className="text-[var(--st-warn)]">{feed.error}</span>:<span className="text-muted">{feed.refreshedAt??'未刷新'}</span>}
          </div>)}</div></details>
        </div>
      </>:<div className="reading-toolbar"><label className="text-muted">arXiv 分类</label><input aria-label="推荐分类" disabled={busy||!writable} value={categories} onChange={event=>{if(!pending.current)setCategories(event.target.value);}}/>
        <button type="button" disabled={busy||!writable} onClick={()=>void run(()=>recommend(false))}>获取今日推荐</button><button type="button" disabled={busy||!writable} onClick={()=>void run(()=>recommend(true))}>重新计算</button>
      </div>}
      <div className="reading-toolbar"><input aria-label="筛选论文" placeholder="筛选标题 / 摘要" disabled={busy} value={filter} onChange={event=>{if(!pending.current)setFilter(event.target.value);}}/>
        <select aria-label="文章类型" disabled={busy} value={type} onChange={event=>{if(!pending.current)setType(event.target.value);}}><option value="all">全部文章</option><option value="paper">论文</option><option value="other">其他</option></select>
        <label><input type="checkbox" disabled={busy} checked={unread} onChange={event=>{if(!pending.current)setUnread(event.target.checked);}}/>仅未读</label>
        <button type="button" disabled={busy} onClick={()=>{if(!pending.current)setSelected(new Set(rows.filter(row=>!row.importedItemId).map(row=>row.id)));}}>全选</button><button type="button" className="tabular-nums" disabled={busy||!writable||selected.size===0} onClick={()=>void run(()=>importSelected([...selected]))}>入库所选 ({selected.size.toLocaleString('zh-CN')})</button>
      </div>
      {error||feeds.error||articles.error?<div className="p-2"><p role="alert" className="whitespace-pre-wrap text-[var(--st-warn)]">{error??feeds.error??articles.error}</p>
        {feeds.error||articles.error?<button type="button" disabled={busy} onClick={()=>{if(!pending.current){feeds.reload();articles.reload();}}}>重新读取</button>:null}</div>:null}
      <p role="status" className="tabular-nums px-3 py-1 text-muted">{busy?'正在处理…':loading?'正在读取订阅…':status||`${rows.length.toLocaleString('zh-CN')} 篇文章`}</p>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-y-auto px-3" data-testid="radar-articles">
          {rows.length===0&&!busy&&!loading&&!feeds.error&&!articles.error?<div className="py-8 text-center text-muted"><p>{filtered?'没有符合筛选条件的文章。':source==='daily'?'根据项目文献生成今日推荐。需先启用嵌入模型。':'添加订阅并刷新后，文章将保存在这里。'}</p>
            {filtered?<button type="button" onClick={()=>{setFilter('');setType('all');setUnread(false);}}>清除筛选</button>:null}</div>:rows.map(row=><article key={row.id} className="border-b-[0.5px] border-line py-3">
            <div className="flex items-start gap-2"><input type="checkbox" aria-label={`选择 ${row.title}`} disabled={busy||row.importedItemId!==null} checked={selected.has(row.id)} onChange={event=>{if(pending.current)return;const checked=event.target.checked;setSelected(current=>{const next=new Set(current);if(checked)next.add(row.id);else next.delete(row.id);return next;});}}/>
              <button type="button" disabled={busy} className={`text-left ${row.read?'text-muted':'font-medium text-ink'}`} onClick={()=>{if(pending.current)return;setArticle(row);if(writable)void run(async()=>{const result=await client.api.research.markRadarArticle({projectId,articleId:row.id,read:true});if(!mounted.current)return;if(!result.ok)throw new Error(result.error.message);articles.reload();});}}>{row.title}</button></div>
            <p className="mt-1 line-clamp-2 text-muted">{row.summary}</p><div className="mt-2 flex flex-wrap items-center gap-3 text-[length:var(--font-meta-size)] text-muted"><span>{row.publishedAt?.slice(0,10)??'日期未知'}</span>
              {row.score!==null?<span className="tabular-nums">相关度 {row.score.toFixed(3)}</span>:null}<span>{row.read?'已读':'未读'}</span>
              {row.importedItemId?<span className="inline-flex items-center gap-1"><Check size={12}/>已入库</span>:<button className="text-accent" type="button" disabled={busy||!writable} onClick={()=>void run(()=>importSelected([row.id]))}>加入文献库</button>}
            </div>
          </article>)}
        </div>
        {article?<aside className="w-[45%] min-w-0 overflow-y-auto border-l-[0.5px] border-line p-3"><button type="button" onClick={()=>setArticle(null)}>关闭详情</button><h3 className="my-3 font-semibold">{article.title}</h3><p className="text-muted">{article.authors.join(', ')}</p><p className="my-3 whitespace-pre-wrap">{article.summary}</p><p className="break-all text-muted">{article.url}</p>
          <div className="reading-toolbar"><button type="button" disabled={busy||!writable||article.importedItemId!==null} onClick={()=>void run(()=>importSelected([article.id]))}>入库</button><button type="button" disabled={busy||!writable} onClick={()=>void run(async()=>{const result=await client.api.research.markRadarArticle({projectId,articleId:article.id,read:false});if(!mounted.current)return;if(!result.ok)throw new Error(result.error.message);articles.reload();setArticle(null);})}>标为未读</button></div>
        </aside>:null}
      </div>
    </>}
  </section>;
}
