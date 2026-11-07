import {useRef,useState,useEffect} from 'react';
import type {z} from 'zod';
import type {RadarArticle,readingDiscoveryResultSchema} from '../../shared/schemas/research-reading';
import type {RocClient} from '../shared/roc-client';
import './reading.css';

export default function ReadingDiscoveryPanel({client,projectId,itemId,writable,onImported}:{
  client:RocClient;projectId:string;itemId:string;writable:boolean;onImported:()=>void;
}):React.JSX.Element {
  const [direction,setDirection]=useState<'references'|'citations'>('references');
  const [result,setResult]=useState<z.infer<typeof readingDiscoveryResultSchema>|null>(null);
  const [selected,setSelected]=useState<Set<string>>(new Set()),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[status,setStatus]=useState('');
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const load=async(force:boolean,offset=0):Promise<void>=>{
    setBusy(true);setError(null);
    try{const response=await client.api.research.discoverReadingRelations({projectId,itemId,direction,offset,force});
      if(!response.ok)throw new Error(response.error.message);if(!alive.current)return;
      setResult(previous=>({...response.data,articles:offset&&previous?[...new Map([...previous.articles,...response.data.articles].map(article=>[article.id,article])).values()]:response.data.articles}));
      if(!offset)setSelected(new Set());
    }catch(error){if(alive.current)setError(String(error));}finally{if(alive.current)setBusy(false);}
  };
  const importSelected=async():Promise<void>=>{
    setBusy(true);setError(null);let count=0;const errors:string[]=[];
    for(const article of result?.articles??[]){if(!selected.has(article.id)||article.importedItemId)continue;
      try{const response=await client.api.research.importRadarArticle({projectId,articleId:article.id});if(!response.ok)throw new Error(response.error.message);count++;
        if(alive.current){setResult(previous=>previous?{...previous,articles:previous.articles.map(row=>row.id===article.id?{...row,importedItemId:response.data.itemId,read:true}:row)}:null);setSelected(previous=>new Set([...previous].filter(id=>id!==article.id)));}
      }catch(error){errors.push(`${article.title}: ${String(error)}`);}
    }
    onImported();if(alive.current){setBusy(false);setStatus(`已加入文献库 ${count} 篇`);if(errors.length)setError(errors.join('\n'));}
  };
  const selectable=(article:RadarArticle):boolean=>!article.importedItemId;
  return <section className="p-3" data-testid="reader-discovery" aria-label="引文发现">
    <div className="reading-toolbar">
      <select aria-label="引文方向" disabled={busy} value={direction} onChange={event=>{setDirection(event.target.value as typeof direction);setResult(null);setSelected(new Set());setError(null);setStatus('');}}>
        <option value="references">参考文献</option><option value="citations">引用本文</option>
      </select>
      <button type="button" disabled={busy||!writable} onClick={()=>void load(false)}>发现论文</button>
      <button type="button" disabled={busy||!writable} onClick={()=>void load(true)}>重新获取</button>
      <button type="button" disabled={busy||!result} onClick={()=>setSelected(new Set((result?.articles??[]).filter(selectable).map(article=>article.id)))}>全选</button>
      <button type="button" disabled={busy||!writable||!selected.size} onClick={()=>void importSelected()}>批量入库 ({selected.size})</button>
    </div>
    {busy?<p role="status">正在处理…</p>:null}{error?<p role="alert" className="whitespace-pre-wrap text-[var(--st-warn)]">{error}</p>:null}{status?<p role="status">{status}</p>:null}
    {result?<><p className="text-muted">{result.source} · {result.articles.length} 篇 · {result.cached?'本地缓存':'刚刚获取'}</p>
      {result.warnings.map(warning=><p className="text-muted" key={warning}>{warning}</p>)}
      {result.articles.length===0?<p className="py-3">没有找到公开的引文记录。</p>:result.articles.map(article=><article className="border-b border-line py-2" key={article.id}>
        <label className="flex items-start gap-2"><input type="checkbox" disabled={busy||!selectable(article)} checked={selected.has(article.id)} onChange={event=>setSelected(previous=>{const next=new Set(previous);if(event.target.checked)next.add(article.id);else next.delete(article.id);return next;})}/>
          <span className="min-w-0"><span className="font-medium">{article.title}</span><span className="block text-muted">{article.authors.join(', ')} {article.publishedAt?.slice(0,4)} {article.importedItemId?' · 已入库':''}</span></span></label>
        {article.summary?<details className="ml-5"><summary>摘要</summary><p className="whitespace-pre-wrap">{article.summary}</p></details>:null}
      </article>)}
      {result.nextOffset!==null?<button type="button" disabled={busy} onClick={()=>void load(false,result.nextOffset!)}>加载更多</button>:null}
    </>:<p className="py-3 text-muted">根据当前论文查找参考文献或引用它的新论文，选中后批量加入当前项目。</p>}
  </section>;
}
