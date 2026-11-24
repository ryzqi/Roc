import {useEffect,useMemo,useRef,useState} from 'react';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import type {ReadingHighlight} from '../../shared/schemas/research-reading';
import type {RocClient} from '../shared/roc-client';
import {ActionButton} from '../shared/form-ui';
import {ActionStatus} from '../shared/action-status';
import type {PdfTextSelection} from './PdfTextLayer';
import {createPdfTextCache} from './pdf-text-cache';
import './reading.css';
export type TranslationSegment={label:string;text:string};
type OutlineItem={title:string;page:number;depth:number};
type ReadingAction={kind:'copy'}|{kind:'translate';all:boolean}|{kind:'highlight';id:string|null};
export default function PdfReadingTools({client,projectId,documentId,sourceHash,pdf,page,navigate,selection,writable,highlights,onHighlights,onQuery,onNote,onTranslate}: {
  client:RocClient;projectId:string;documentId:string;sourceHash:string;pdf:PDFDocumentProxy;page:number;navigate:(page:number)=>void;
  selection:PdfTextSelection|null;writable:boolean;highlights:ReadingHighlight[];onHighlights:(rows:ReadingHighlight[])=>void;
  onQuery:(query:string)=>void;onNote:(text:string)=>void;onTranslate:(segments:TranslationSegment[],label:string)=>void;
}):React.JSX.Element {
  const [outline,setOutline]=useState<OutlineItem[]>([]),[panel,setPanel]=useState<'outline'|'highlights'|null>(null);
  const [query,setQuery]=useState(''),[matches,setMatches]=useState<{page:number;count:number}[]>([]),[searching,setSearching]=useState(false);
  const [error,setError]=useState<string|null>(null),[operation,setOperation]=useState<ReadingAction|null>(null),[note,setNote]=useState(''),[color,setColor]=useState<ReadingHighlight['color']>('yellow');
  const alive=useRef(true),searchRun=useRef(0),busyRef=useRef(false);
  const busy=operation!==null;
  const pageText=useMemo(()=>createPdfTextCache(pdf),[pdf]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;searchRun.current++;};},[]);
  useEffect(()=>{
    let cancelled=false;
    void Promise.all([client.api.research.listReadingHighlights({projectId,documentId,sourceHash}),pdf.getOutline()]).then(async([result,tree])=>{
      if(cancelled)return;if(!result.ok)throw new Error(result.error.message);onHighlights(result.data);
      const entries:OutlineItem[]=[];
      const visit=async(items:NonNullable<typeof tree>,depth:number):Promise<void>=>{for(const item of items){
        const destination=typeof item.dest==='string'?await pdf.getDestination(item.dest):item.dest;
        if(destination){const ref=destination[0];const index=typeof ref==='number'?ref:await pdf.getPageIndex(ref);entries.push({title:item.title,page:index+1,depth});}
        await visit(item.items,depth+1);
      }};
      await visit(tree??[],0);if(!cancelled)setOutline(entries);
    }).catch(error=>{if(!cancelled)setError(String(error));});return()=>{cancelled=true;};
  },[client,projectId,documentId,sourceHash,pdf]);
  useEffect(()=>{
    const run=++searchRun.current;setMatches([]);onQuery(query.trim());if(!query.trim()){setSearching(false);return;}
    const timer=setTimeout(()=>{setSearching(true);void(async()=>{
      const hits:{page:number;count:number}[]=[];const needle=query.trim().toLocaleLowerCase();
      for(let number=1;number<=pdf.numPages;number++){
        const text=(await pageText(number)).toLocaleLowerCase();if(run!==searchRun.current)return;
        const count=text.split(needle).length-1;if(count)hits.push({page:number,count});
      }
      if(run===searchRun.current){setMatches(hits);setSearching(false);}
    })().catch(error=>{if(run===searchRun.current){setError(String(error));setSearching(false);}});},250);
    return()=>{clearTimeout(timer);searchRun.current++;};
  },[query,pdf,pageText]);
  const run=async(action:()=>Promise<void>,intent:ReadingAction):Promise<void>=>{
    if(busyRef.current)return;
    busyRef.current=true;setOperation(intent);setError(null);
    try{await action();}catch(error){if(alive.current)setError(String(error));}
    finally{busyRef.current=false;if(alive.current)setOperation(null);}
  };
  const saveHighlight=async(value:ReadingHighlight):Promise<void>=>{
    const {revision,createdAt,...record}=value;
    const result=await client.api.research.saveReadingHighlight({...record,expectedRevision:revision});
    if(!result.ok)throw new Error(result.error.message);
    if(alive.current)onHighlights([...highlights.filter(row=>row.id!==result.data.id),result.data]);
  };
  const translatePages=(all:boolean):void=>{void run(async()=>{
    const segments:TranslationSegment[]=[];
    for(let number=all?1:page;number<=(all?pdf.numPages:page);number++){
      if(!alive.current)return;const text=await pageText(number);if(text.trim())segments.push({label:`第 ${number} 页`,text});
    }
    if(!segments.length)throw new Error('这些页面没有可提取的文字；扫描件请使用解析文本翻译。');
    if(alive.current)onTranslate(segments,all?'全文翻译':'本页翻译');
  },{kind:'translate',all});};
  const operationLabel=operation?.kind==='translate'?operation.all?'正在准备全文翻译':'正在准备本页翻译':
    operation?.kind==='copy'?'正在复制选区':operation?.kind==='highlight'&&operation.id!==null?'正在更新高亮':'正在保存高亮';
  return <details className="reading-disclosure" data-testid="reader-pdf-tools" open={selection !== null || error !== null ? true : undefined}>
    <summary>查找与标记</summary>
    <div className="reading-toolbar reading-pdf-tools-bar">
      <button type="button" aria-expanded={panel==='outline'} onClick={()=>setPanel(panel==='outline'?null:'outline')}>目录 {outline.length}</button>
      <button type="button" aria-expanded={panel==='highlights'} onClick={()=>setPanel(panel==='highlights'?null:'highlights')}>高亮 {highlights.filter(row=>!row.archived).length}</button>
      <input type="search" aria-label="查找 PDF 全文" placeholder="查找全文" value={query} onChange={event=>setQuery(event.target.value)}/>
      {query?<><ActionStatus state={searching?'pending':'idle'} role="status">{searching?'查找中…':`${matches.reduce((sum,hit)=>sum+hit.count,0)} 处 / ${matches.length} 页`}</ActionStatus>
        <button type="button" disabled={!matches.length} onClick={()=>navigate([...matches].reverse().find(hit=>hit.page<page)?.page??matches.at(-1)!.page)}>上一个匹配页</button>
        <button type="button" disabled={!matches.length} onClick={()=>navigate(matches.find(hit=>hit.page>page)?.page??matches[0].page)}>下一个匹配页</button></>:null}
      <details className="reading-disclosure"><summary>翻译</summary><div className="reading-toolbar">
        <ActionButton variant="unstyled" aria-label="翻译本页" disabled={busy}
          loading={operation?.kind==='translate'&&!operation.all} loadingLabel="正在准备本页翻译" onClick={()=>translatePages(false)}>翻译本页</ActionButton>
        <ActionButton variant="unstyled" aria-label="翻译全文" disabled={busy}
          loading={operation?.kind==='translate'&&operation.all} loadingLabel="正在准备全文翻译" onClick={()=>translatePages(true)}>翻译全文</ActionButton>
      </div></details>
    </div>
    {selection?<div className="reading-toolbar" data-testid="reader-selection-actions">
      <span className="max-w-40 truncate" title={selection.text}>{selection.text}</span>
      <ActionButton variant="unstyled" aria-label="复制选区" disabled={busy} loading={operation?.kind==='copy'} loadingLabel="正在复制选区"
        onClick={()=>void run(()=>navigator.clipboard.writeText(selection.text),{kind:'copy'})}>复制选区</ActionButton>
      <button type="button" disabled={!writable} onClick={()=>onNote(`> ${selection.text.replace(/\n/g,'\n> ')}\n\n第 ${page} 页`)}>摘录到笔记</button>
      <button type="button" onClick={()=>onTranslate([{label:`第 ${page} 页选区`,text:selection.text}],'选区翻译')}>翻译选区</button>
      <select aria-label="高亮颜色" value={color} disabled={busy} onChange={event=>setColor(event.target.value as ReadingHighlight['color'])}>
        <option value="yellow">黄色</option><option value="green">绿色</option><option value="blue">蓝色</option><option value="pink">粉色</option></select>
      <input aria-label="高亮备注" placeholder="高亮备注（可选）" maxLength={10000} value={note} disabled={busy} onChange={event=>setNote(event.target.value)}/>
      <ActionButton variant="unstyled" aria-label="保存高亮" disabled={!writable||busy||!selection.rects.length}
        loading={operation?.kind==='highlight'&&operation.id===null} loadingLabel="正在保存高亮" onClick={()=>void run(async()=>{
        await saveHighlight({id:crypto.randomUUID(),projectId,documentId,sourceHash,page,text:selection.text,note,color,rects:selection.rects,revision:0,createdAt:'',archived:false});
        if(alive.current)setNote('');
      },{kind:'highlight',id:null})}>保存高亮</ActionButton>
    </div>:null}
    {busy?<ActionStatus state="pending" icon={null} className="p-2" testId="reader-pdf-feedback">{operationLabel}</ActionStatus>:null}
    {error?<ActionStatus state="error" className="p-2 text-[var(--st-bad)]">{error}</ActionStatus>:null}
    {panel==='outline'?<nav aria-label="PDF 目录" className="max-h-48 overflow-auto border-b-[0.5px] border-line p-2">
      {outline.length?outline.map((item,index)=><button type="button" key={index} className="block w-full rounded-control py-1 text-left hover:bg-[var(--overlay-hover)]" style={{paddingInlineStart:8+item.depth*12}} onClick={()=>navigate(item.page)}>{item.title}，{item.page}</button>):<p className="text-muted">原 PDF 未提供目录。</p>}
    </nav>:null}
    {panel==='highlights'?<div className="max-h-56 overflow-auto border-b-[0.5px] border-line p-2">
      {highlights.length?highlights.map(row=><div key={row.id} className="mb-2 border-b-[0.5px] border-line pb-2">
        <button type="button" className="block text-left" onClick={()=>navigate(row.page)}>第 {row.page} 页，{row.text}</button>
        <textarea aria-label={`第 ${row.page} 页高亮备注`} className="w-full rounded-control border-[0.5px] border-line bg-surface p-1" defaultValue={row.note} disabled={!writable||busy||row.archived}
          onBlur={event=>{if(event.target.value!==row.note)void run(()=>saveHighlight({...row,note:event.target.value}),{kind:'highlight',id:row.id});}}/>
        <ActionButton variant="unstyled" aria-label={row.archived?'恢复高亮':'归档高亮'} disabled={!writable||busy}
          loading={operation?.kind==='highlight'&&operation.id===row.id} loadingLabel="正在更新高亮"
          onClick={()=>void run(()=>saveHighlight({...row,archived:!row.archived}),{kind:'highlight',id:row.id})}>{row.archived?'恢复高亮':'归档高亮'}</ActionButton>
      </div>):<p className="text-muted">在 PDF 中选择文字以创建高亮。</p>}
    </div>:null}
  </details>;
}
