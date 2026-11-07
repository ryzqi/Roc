import {useEffect,useRef,useState} from 'react';
import type {z} from 'zod';
import type {radarBrowserPaperSchema} from '../../shared/schemas/research-reading';
import type {RocClient} from '../shared/roc-client';
export default function RadarBrowser({client,source,active,projectId,writable,onImported}: {
  client:RocClient;source:'cool'|'modelscope';active:boolean;projectId:string;writable:boolean;onImported:()=>void;
}):React.JSX.Element {
  const area=useRef<HTMLDivElement>(null),[papers,setPapers]=useState<z.infer<typeof radarBrowserPaperSchema>[]|null>(null);
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
  const bounds=()=>{const rect=area.current?.getBoundingClientRect();return{x:Math.max(0,Math.round(rect?.x??0)),y:Math.max(0,Math.round(rect?.y??0)),width:Math.max(0,Math.floor(rect?.width??0)),height:Math.max(0,Math.floor(rect?.height??0))};};
  const command=async(action:'open'|'bounds'|'hide'|'back'|'reload'|'inspect'):Promise<void>=>{
    try{const result=await client.api.research.radarBrowser({action,source,bounds:bounds()});
      if(!result.ok){setError(result.error.message);return;}
      if(action==='inspect'){const found=result.data.papers;if(source==='cool' && /^https:\/\/papers\.cool\/(?:venue\/[^/?#]+|arxiv\/\d{4}\.\d{4,5}(?:v\d+)?)(?:[?#]|$)/u.test(result.data.url))found.unshift({title:'当前 Cool Papers 论文',url:result.data.url,doi:null,arxivId:null});setPapers(found);}
    }catch(error){setError(String(error));}
  };
  useEffect(()=>{
    if(!active || papers!==null){void command('hide');return;}
    let disposed=false,scheduled=0,last='',opened=false;
    const update=():void=>{
      if(disposed)return;
      cancelAnimationFrame(scheduled);
      scheduled=requestAnimationFrame(()=>{
        const blocked=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].some(element=>element.getClientRects().length>0);
        const rect=bounds(),next=JSON.stringify([blocked,rect]);if(next===last)return;last=next;
        if(blocked)void command('hide');else{void command(opened?'bounds':'open');opened=true;}
      });
    };
    update();
    const observer=new ResizeObserver(update);if(area.current)observer.observe(area.current);
    window.addEventListener('resize',update);window.addEventListener('scroll',update,true);
    const overlays=new MutationObserver(update);overlays.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-modal','role','hidden','style','class']});
    return()=>{disposed=true;cancelAnimationFrame(scheduled);observer.disconnect();overlays.disconnect();window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true);void command('hide');};
  },[active,source,papers]);
  const importPaper=async(paper:z.infer<typeof radarBrowserPaperSchema>):Promise<void>=>{
    setBusy(true);setError(null);
    try{
      if(paper.url.startsWith('https://papers.cool/')){const captured=await client.api.research.captureRadarPage({projectId,url:paper.url});if(!captured.ok)throw new Error(captured.error.message);const imported=await client.api.research.importRadarArticle({projectId,articleId:captured.data.id});if(!imported.ok)throw new Error(imported.error.message);}
      else if(paper.doi){const result=await client.api.research.importLibraryDoi({projectId,doi:paper.doi});if(!result.ok)throw new Error(result.error.message);}
      else if(paper.arxivId){
        const search=await client.api.research.searchLiterature({projectId,query:`id:${paper.arxivId}`,sources:['arxiv'],limit:10,maxPages:1});
        if(!search.ok)throw new Error(search.error.message);
        const candidate=search.data.candidates.find(value=>value.record.externalId.replace(/v\d+$/u,'')===paper.arxivId!.replace(/v\d+$/u,''));
        if(!candidate)throw new Error('arXiv 未返回匹配的论文，请稍后重试。');
        const result=await client.api.research.addLiterature({projectId,destination:'current_project',requestId:crypto.randomUUID(),entries:[{kind:'candidate',searchId:search.data.searchId,candidateId:candidate.candidateId}]});
        if(!result.ok)throw new Error(result.error.message);
        if(result.data.counts.failed)throw new Error(result.data.items.find(item=>item.errorCode)?.errorCode??'入库未完成');
      }
      else throw new Error('论文缺少可导入的标识。');
      setStatus(`已入库：${paper.title}`);onImported();
    }catch(error){setError(String(error));}finally{setBusy(false);}
  };
  return <div className="flex min-h-0 flex-1 flex-col" data-testid="radar-browser">
    <div className="reading-toolbar"><button type="button" onClick={()=>void command('back')}>后退</button><button type="button" onClick={()=>void command('reload')}>刷新网页</button>
      <button type="button" onClick={()=>{setError(null);void command('inspect');}}>读取当前页论文 / 入库</button>
      {papers!==null?<button type="button" onClick={()=>setPapers(null)}>返回浏览</button>:null}
    </div>
    {error?<p role="alert" className="p-2 text-[var(--st-warn)]">{error}</p>:null}{status?<p role="status" className="p-2">{status}</p>:null}
    <div ref={area} className="relative min-h-0 flex-1 overflow-auto" aria-label={source==='cool'?'Cool Papers 浏览区':'魔搭论文浏览区'}>
      {papers!==null?<div className="p-3">{papers.length===0?<p>当前页没有可识别的论文链接，请打开论文详情后重试。</p>:papers.map(paper=><article className="border-b border-line py-3" key={paper.url}>
        <h3 className="font-medium">{paper.title}</h3><p className="break-all text-muted">{paper.url}</p><button className="mt-2 rounded-control border border-line px-3 py-1" type="button" disabled={busy||!writable} onClick={()=>void importPaper(paper)}>加入文献库</button>
      </article>)}</div>:<p className="p-4 text-muted">正在加载 {source==='cool'?'Cool Papers':'魔搭论文'}…</p>}
    </div>
  </div>;
}
