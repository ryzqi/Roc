import {useEffect,useRef,useState} from 'react';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import type {ReadingHighlight} from '../../shared/schemas/research-reading';
import type {RocClient} from '../shared/roc-client';
import type {PdfTextSelection} from './PdfTextLayer';
import './reading.css';
export type TranslationSegment={label:string;text:string};
type OutlineItem={title:string;page:number;depth:number};
export default function PdfReadingTools({client,projectId,documentId,sourceHash,pdf,page,navigate,selection,writable,highlights,onHighlights,onQuery,onNote,onTranslate}: {
  client:RocClient;projectId:string;documentId:string;sourceHash:string;pdf:PDFDocumentProxy;page:number;navigate:(page:number)=>void;
  selection:PdfTextSelection|null;writable:boolean;highlights:ReadingHighlight[];onHighlights:(rows:ReadingHighlight[])=>void;
  onQuery:(query:string)=>void;onNote:(text:string)=>void;onTranslate:(segments:TranslationSegment[],label:string)=>void;
}):React.JSX.Element {
  const [outline,setOutline]=useState<OutlineItem[]>([]),[panel,setPanel]=useState<'outline'|'highlights'|null>(null);
  const [query,setQuery]=useState(''),[matches,setMatches]=useState<{page:number;count:number}[]>([]),[searching,setSearching]=useState(false);
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[note,setNote]=useState(''),[color,setColor]=useState<ReadingHighlight['color']>('yellow');
  const alive=useRef(true),searchRun=useRef(0),textCache=useRef(new Map<number,Promise<string>>());
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
  const pageText=(number:number):Promise<string>=>{
    let pending=textCache.current.get(number);
    if(!pending){pending=pdf.getPage(number).then(page=>page.getTextContent()).then(content=>content.items.map(item=>'str'in item?`${item.str}${item.hasEOL?'\n':' '}`:'').join('')).catch(error=>{textCache.current.delete(number);throw error;});textCache.current.set(number,pending);}
    return pending;
  };
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
  },[query,pdf]);
  const run=async(action:()=>Promise<void>):Promise<void>=>{setBusy(true);setError(null);try{await action();}catch(error){if(alive.current)setError(String(error));}finally{if(alive.current)setBusy(false);}};
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
  });};
  return <div className="shrink-0" data-testid="reader-pdf-tools">
    <div className="reading-toolbar">
      <button type="button" aria-expanded={panel==='outline'} onClick={()=>setPanel(panel==='outline'?null:'outline')}>目录 {outline.length}</button>
      <button type="button" aria-expanded={panel==='highlights'} onClick={()=>setPanel(panel==='highlights'?null:'highlights')}>高亮 {highlights.filter(row=>!row.archived).length}</button>
      <input type="search" aria-label="查找 PDF 全文" placeholder="查找全文" value={query} onChange={event=>setQuery(event.target.value)}/>
      {query?<><span role="status">{searching?'查找中…':`${matches.reduce((sum,hit)=>sum+hit.count,0)} 处 / ${matches.length} 页`}</span>
        <button type="button" disabled={!matches.length} onClick={()=>navigate([...matches].reverse().find(hit=>hit.page<page)?.page??matches.at(-1)!.page)}>上一个匹配页</button>
        <button type="button" disabled={!matches.length} onClick={()=>navigate(matches.find(hit=>hit.page>page)?.page??matches[0].page)}>下一个匹配页</button></>:null}
      <button type="button" disabled={busy} onClick={()=>translatePages(false)}>翻译本页</button>
      <button type="button" disabled={busy} onClick={()=>translatePages(true)}>翻译全文</button>
    </div>
    {selection?<div className="reading-toolbar" data-testid="reader-selection-actions">
      <span className="max-w-40 truncate" title={selection.text}>{selection.text}</span>
      <button type="button" onClick={()=>void run(()=>navigator.clipboard.writeText(selection.text))}>复制选区</button>
      <button type="button" disabled={!writable} onClick={()=>onNote(`> ${selection.text.replace(/\n/g,'\n> ')}\n\n第 ${page} 页`)}>摘录到笔记</button>
      <button type="button" onClick={()=>onTranslate([{label:`第 ${page} 页选区`,text:selection.text}],'选区翻译')}>翻译选区</button>
      <select aria-label="高亮颜色" value={color} onChange={event=>setColor(event.target.value as ReadingHighlight['color'])}>
        <option value="yellow">黄色</option><option value="green">绿色</option><option value="blue">蓝色</option><option value="pink">粉色</option></select>
      <input aria-label="高亮备注" placeholder="高亮备注（可选）" maxLength={10000} value={note} onChange={event=>setNote(event.target.value)}/>
      <button type="button" disabled={!writable||busy||!selection.rects.length} onClick={()=>void run(async()=>{
        await saveHighlight({id:crypto.randomUUID(),projectId,documentId,sourceHash,page,text:selection.text,note,color,rects:selection.rects,revision:0,createdAt:'',archived:false});setNote('');
      })}>保存高亮</button>
    </div>:null}
    {error?<p role="alert" className="p-2 text-[var(--st-warn)]">{error}</p>:null}
    {panel==='outline'?<nav aria-label="PDF 目录" className="max-h-48 overflow-auto border-b-[0.5px] border-line p-2">
      {outline.length?outline.map((item,index)=><button type="button" key={index} className="block w-full rounded-control py-1 text-left hover:bg-[var(--overlay-hover)]" style={{paddingInlineStart:8+item.depth*12}} onClick={()=>navigate(item.page)}>{item.title}，{item.page}</button>):<p className="text-muted">原 PDF 未提供目录。</p>}
    </nav>:null}
    {panel==='highlights'?<div className="max-h-56 overflow-auto border-b-[0.5px] border-line p-2">
      {highlights.length?highlights.map(row=><div key={row.id} className="mb-2 border-b-[0.5px] border-line pb-2">
        <button type="button" className="block text-left" onClick={()=>navigate(row.page)}>第 {row.page} 页，{row.text}</button>
        <textarea aria-label={`第 ${row.page} 页高亮备注`} className="w-full rounded-control border-[0.5px] border-line bg-surface p-1" defaultValue={row.note} disabled={!writable||busy||row.archived}
          onBlur={event=>{if(event.target.value!==row.note)void run(()=>saveHighlight({...row,note:event.target.value}));}}/>
        <button type="button" disabled={!writable||busy} onClick={()=>void run(()=>saveHighlight({...row,archived:!row.archived}))}>{row.archived?'恢复高亮':'归档高亮'}</button>
      </div>):<p className="text-muted">在 PDF 中选择文字以创建高亮。</p>}
    </div>:null}
  </div>;
}
