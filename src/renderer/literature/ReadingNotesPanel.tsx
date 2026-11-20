import {useCallback,useEffect,useRef,useState} from 'react';
import {FilePlus2,Link2,NotebookPen} from 'lucide-react';
import type {ReadingNote} from '../../shared/schemas/research-reading';
import type {ResearchLibraryItem} from '../../shared/types';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction,useAsyncResource} from '../app/use-async-resource';
import {BEFORE_NAVIGATE} from '../app/navigation-guard';
import {ConfirmDialog} from '../shell/ConfirmDialog';
import ReadingNoteEditor from './ReadingNoteEditor';
import './reading.css';
type Draft = Pick<ReadingNote,'id'|'title'|'markdown'|'itemId'|'archived'>;
export default function ReadingNotesPanel({client,projectId,items,writable,itemId=null,seed=null,onSeedConsumed,onReveal}: {
  client:RocClient;projectId:string;items:ResearchLibraryItem[];writable:boolean;itemId?:string|null;
  seed?:{id:string;text:string}|null;onSeedConsumed?:()=>void;onReveal?:()=>void;
}):React.JSX.Element {
  const list=useAsyncResource(projectId,()=>client.api.research.listReadingNotes({projectId}),{label:'读取笔记'});
  const [draft,setDraft]=useState<Draft|null>(null),[baseline,setBaseline]=useState<ReadingNote|null>(null);
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[filter,setFilter]=useState(''),[archived,setArchived]=useState(false);
  const [conflict,setConflict]=useState(false),[session,setSession]=useState(0);
  const [operation,setOperation]=useState<'export'|'reload'|null>(null),[discardOpen,setDiscardOpen]=useState(false);
  const saving=useRef(false),mounted=useRef(true),lastSeed=useRef<string|null>(null);
  const operationRef=useRef<'export'|'reload'|null>(null);
  const exportNote=useAsyncAction((note:ReadingNote)=>client.api.research.exportReadingNote({
    projectId,noteId:note.id,expectedRevision:note.revision
  }),{label:'导出笔记'});
  const reread=useAsyncAction(()=>client.api.research.listReadingNotes({projectId}),{label:'重读笔记'});
  const pending=busy||operation!==null;
  const dirty=draft!==null && (baseline===null || ['title','markdown','itemId','archived'].some(key=>draft[key as keyof Draft]!==baseline[key as keyof ReadingNote]));
  const latest=useRef({draft,baseline});latest.current={draft,baseline};
  const save=useCallback(async():Promise<boolean>=>{
    const {draft:current,baseline:previous}=latest.current;
    if(!current || saving.current || operationRef.current!==null || !writable)return false;
    saving.current=true;setBusy(true);setError(null);exportNote.reset();reread.reset();
    try{const {id,title,markdown,itemId,archived}=current;
      const result=await client.api.research.saveReadingNote({id,title,markdown,itemId,archived,projectId,expectedRevision:previous?.revision??0});
      if(!mounted.current)return result.ok;
      if(!result.ok){setError(result.error.message);setConflict(true);return false;}
      latest.current.baseline=result.data;setBaseline(result.data);setConflict(false);setDiscardOpen(false);list.reload();return true;
    }catch(error){if(mounted.current){setError(String(error));setConflict(true);}return false;}
    finally{saving.current=false;if(mounted.current)setBusy(false);}
  },[client,projectId,writable,list.reload,exportNote.reset,reread.reset]);
  const beginOperation=(next:'export'|'reload'):boolean=>{
    if(saving.current || operationRef.current!==null)return false;
    operationRef.current=next;setOperation(next);setError(null);exportNote.reset();reread.reset();return true;
  };
  const finishOperation=():void=>{operationRef.current=null;if(mounted.current)setOperation(null);};
  const exportStoredNote=async():Promise<void>=>{
    const note=latest.current.baseline;
    if(!note || dirty || !beginOperation('export'))return;
    try{await exportNote.run(note);}finally{finishOperation();}
  };
  const reloadStoredNote=async():Promise<void>=>{
    const current=latest.current.draft;
    if(!current || !beginOperation('reload'))return;
    setDiscardOpen(false);
    try{
      const result=await reread.run();
      if(!mounted.current || !result.ok)return;
      const stored=result.data.find(note=>note.id===current.id)??null;
      setDraft(stored);setBaseline(stored);setConflict(false);setSession(value=>value+1);list.reload();
    }finally{finishOperation();}
  };
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    if(!dirty || pending || conflict || !draft?.title.trim())return;
    const timer=setTimeout(()=>void save(),900);return()=>clearTimeout(timer);
  },[dirty,pending,conflict,draft,save]);
  useEffect(()=>{
    if(!dirty)return;
    const navigation=(event:Event):void=>{event.preventDefault();onReveal?.();setError('笔记尚未保存。保存成功后可切换工作区。');};
    const unload=(event:BeforeUnloadEvent):void=>{event.preventDefault();event.returnValue='';};
    window.addEventListener(BEFORE_NAVIGATE,navigation);window.addEventListener('beforeunload',unload);
    return()=>{window.removeEventListener(BEFORE_NAVIGATE,navigation);window.removeEventListener('beforeunload',unload);};
  },[dirty,onReveal]);
  const open=(note:ReadingNote):void=>{if(dirty || saving.current || operationRef.current!==null){setError('请先保存当前笔记。');return;}setDraft(note);setBaseline(note);setConflict(false);setError(null);exportNote.reset();reread.reset();setSession(value=>value+1);};
  const create=(title='未命名笔记',markdown=''):void=>{
    if(dirty || saving.current || operationRef.current!==null){setError('请先保存当前笔记。');return;}
    const existing=list.data??[];let candidate=title;let number=2;while(existing.some(note=>note.title===candidate && !note.archived))candidate=`${title} ${number++}`;
    setBaseline(null);setDraft({id:crypto.randomUUID(),title:candidate,markdown,itemId,archived:false});setConflict(false);setError(null);exportNote.reset();reread.reset();setSession(value=>value+1);
  };
  useEffect(()=>{
    if(!seed || seed.id===lastSeed.current || list.status!=='ready' || dirty || pending)return;
    lastSeed.current=seed.id;create('阅读摘录',seed.text);onSeedConsumed?.();
  },[seed,list.status,dirty,pending]);
  const link=(title:string):void=>{
    const note=list.data?.find(note=>!note.archived && note.title.toLocaleLowerCase()===title.toLocaleLowerCase());
    if(note)open(note);else create(title);
  };
  const backlinks=(list.data??[]).filter(note=>!note.archived && note.id!==draft?.id && note.links.some(title=>title.toLocaleLowerCase()===draft?.title.toLocaleLowerCase()));
  return <section className="reading-notes flex h-full min-h-0 flex-col" data-testid="notes-panel" aria-label="阅读笔记"
    onKeyDown={event=>{if((event.metaKey||event.ctrlKey)&&event.key==='s'&&!event.nativeEvent.isComposing){event.preventDefault();void save();}}}>
    <div className="reading-toolbar">
      <NotebookPen size={15}/><span className="font-medium">阅读笔记</span>
      <button type="button" disabled={!writable || dirty || pending} onClick={()=>create()} data-testid="notes-create"><FilePlus2 size={13}/>新建</button>
      <input aria-label="搜索笔记" placeholder="搜索标题或正文" value={filter} onChange={event=>setFilter(event.target.value)}/>
      <label><input type="checkbox" checked={archived} onChange={event=>setArchived(event.target.checked)}/>含归档</label>
    </div>
    {list.error?<p role="alert" className="p-2">{list.error}<button type="button" onClick={list.reload}>重试</button></p>:null}
    <div className="reading-toolbar">
      <select aria-label="选择笔记" value={draft?.id??''} disabled={dirty||pending} onChange={event=>{const note=list.data?.find(note=>note.id===event.target.value);if(note)open(note);}}>
        <option value="">选择笔记</option>{(list.data??[]).filter(note=>(archived||!note.archived)&&(!itemId||note.itemId===itemId)&&`${note.title} ${note.markdown}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
          .map(note=><option key={note.id} value={note.id}>{note.archived?'[归档] ':''}{note.title}</option>)}
      </select>
      <span role="status" className="text-muted">{operation==='export'?'导出中…':operation==='reload'?'重读中…':busy?'保存中…':conflict?'保存未完成':dirty?'未保存':draft?'已保存':list.status==='loading'?'读取笔记…':'未选择笔记'}</span>
      {draft?<button type="button" disabled={!writable||pending||!draft.title.trim()} onClick={()=>void save()} data-testid="notes-save">保存 ⌘S</button>:null}
    </div>
    {error||exportNote.error||reread.error?<p role="alert" className="p-2 text-[var(--st-warn)]">{error??exportNote.error??reread.error}</p>:null}
    {!draft?<div className="m-auto p-6 text-center text-muted">选择笔记，或创建与当前论文关联的笔记。</div>:<>
      <div className="reading-toolbar">
        <input aria-label="笔记标题" value={draft.title} maxLength={200} disabled={!writable||draft.archived||operation==='reload'} onChange={event=>setDraft({...draft,title:event.target.value})}/>
        <select aria-label="关联文献" value={draft.itemId??''} disabled={!writable||draft.archived||operation==='reload'} onChange={event=>setDraft({...draft,itemId:event.target.value||null})}>
          <option value="">独立笔记</option>{items.map(item=><option key={item.id} value={item.id}>{item.metadata.title}</option>)}
        </select>
        <button type="button" disabled={dirty||pending||!baseline} onClick={()=>void exportStoredNote()}>导出 .md</button>
        <button type="button" disabled={!writable||pending} onClick={()=>setDraft({...draft,archived:!draft.archived})}>{draft.archived?'恢复笔记':'归档笔记'}</button>
        {conflict?<button type="button" disabled={pending} onClick={()=>setDiscardOpen(true)}>放弃草稿并重读</button>:null}
        {conflict?<button type="button" disabled={pending} onClick={()=>{setBaseline(null);setDraft({...draft,id:crypto.randomUUID(),title:`${draft.title}（副本）`});setConflict(false);}}>将草稿另存为副本</button>:null}
      </div>
      <ReadingNoteEditor key={`${draft.id}:${session}:${draft.archived}`} markdown={draft.markdown} editable={writable&&!draft.archived&&operation!=='reload'}
        titles={(list.data??[]).filter(note=>!note.archived&&note.id!==draft.id).map(note=>note.title)}
        onChange={markdown=>setDraft(current=>current?{...current,markdown}:current)} onLink={link}/>
      <div className="reading-toolbar"><Link2 size={13}/><span>反向链接 {backlinks.length}</span>{backlinks.map(note=><button type="button" key={note.id} disabled={dirty||pending} onClick={()=>open(note)}>{note.title}</button>)}</div>
    </>}
    <ConfirmDialog open={discardOpen} title="重读当前笔记" message="放弃未保存的草稿并载入已保存版本。重读成功后无法恢复这份草稿。"
      confirmLabel="放弃草稿并重读" tone="destructive" confirmDisabled={pending} testId="notes-discard-dialog"
      onCancel={()=>setDiscardOpen(false)} onConfirm={()=>void reloadStoredNote()}/>
  </section>;
}
