import {useEffect,useRef,useState} from 'react';
import {TextLayer,type PDFDocumentProxy,type PDFPageProxy} from 'pdfjs-dist';
import type {ReadingHighlight} from '../../shared/schemas/research-reading';
import './pdf-reading.css';
export type PdfTextSelection={text:string;rects:ReadingHighlight['rects']};
export default function PdfTextLayer({pdf,page,viewport,ratio,disabled,query,highlights,onSelection}: {
  pdf:PDFDocumentProxy;page:number;viewport:ReturnType<PDFPageProxy['getViewport']>;ratio:number;disabled:boolean;query:string;
  highlights:ReadingHighlight[];onSelection:(value:PdfTextSelection)=>void;
}):React.JSX.Element {
  const element=useRef<HTMLDivElement>(null),[error,setError]=useState<string|null>(null),[rendered,setRendered]=useState(0);
  useEffect(()=>{
    const container=element.current!;let cancelled=false;let layer:TextLayer|null=null;container.replaceChildren();setError(null);
    void pdf.getPage(page).then(async document=>{
      const content=await document.getTextContent();if(cancelled)return;
      const cssViewport=viewport.clone({scale:viewport.scale/ratio});
      container.style.setProperty('--total-scale-factor',String(cssViewport.scale));
      layer=new TextLayer({textContentSource:content,container,viewport:cssViewport});await layer.render();if(!cancelled)setRendered(value=>value+1);
    }).catch(error=>{if(!cancelled)setError(String(error));}).finally(()=>TextLayer.cleanup());
    return()=>{cancelled=true;layer?.cancel();TextLayer.cleanup();};
  },[pdf,page,viewport,ratio]);
  useEffect(()=>{
    element.current?.querySelectorAll('span').forEach(span=>span.classList.toggle('pdf-find-hit',!!query&&!!span.textContent?.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  },[query,rendered]);
  const capture=():void=>{
    const selection=window.getSelection(),container=element.current;if(!container||!selection||selection.isCollapsed||!selection.rangeCount)return;
    const range=selection.getRangeAt(0);if(!container.contains(range.commonAncestorContainer))return;
    const bounds=container.getBoundingClientRect();if(!bounds.width||!bounds.height)return;
    const rects=[...range.getClientRects()].flatMap(rect=>{
      const left=Math.max(0,Math.min(1,(rect.left-bounds.left)/bounds.width)),top=Math.max(0,Math.min(1,(rect.top-bounds.top)/bounds.height));
      const width=Math.min(1-left,rect.width/bounds.width),height=Math.min(1-top,rect.height/bounds.height);
      return width>0&&height>0?[[left,top,width,height] as [number,number,number,number]]:[];
    });
    onSelection({text:selection.toString(),rects});
  };
  return <>
    <div ref={element} className="roc-pdf-text-layer" data-testid="reader-pdf-text" style={{pointerEvents:disabled?'none':'auto'}} onPointerUp={capture} onKeyUp={capture}/>
    {highlights.filter(highlight=>!highlight.archived&&highlight.page===page).flatMap(highlight=>highlight.rects.map(([x,y,w,h],index)=><div key={`${highlight.id}:${index}`} aria-label={highlight.note||highlight.text}
      className={`pdf-saved-highlight pdf-highlight-${highlight.color}`} style={{left:`${x*100}%`,top:`${y*100}%`,width:`${w*100}%`,height:`${h*100}%`}}/>))}
    {error?<p role="alert" className="absolute inset-x-0 top-0 bg-surface p-2 text-[var(--st-warn)]">文字层：{error}</p>:null}
  </>;
}
