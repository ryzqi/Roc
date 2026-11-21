import {useCallback,useEffect,useRef,useState} from 'react';
import {FilePlus2,Link2,Loader2,NotebookPen,Trash2} from 'lucide-react';
import type {ReadingNote} from '../../shared/schemas/research-reading';
import type {ResearchLibraryItem} from '../../shared/types';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction,useAsyncResource} from '../app/use-async-resource';
import {BEFORE_NAVIGATE} from '../app/navigation-guard';
import {ConfirmDialog} from '../shell/ConfirmDialog';
import ReadingNoteEditor from './ReadingNoteEditor';
import './reading.css';
type Draft = Pick<ReadingNote,'id'|'title'|'markdown'|'itemId'|'archived'>;
type Operation = 'export'|'reload'|'delete';
export default function ReadingNotesPanel({client,projectId,items,writable,itemId=null,seed=null,onSeedConsumed,onReveal}: {
  client:RocClient;projectId:string;items:ResearchLibraryItem[];writable:boolean;itemId?:string|null;
  seed?:{id:string;text:string}|null;onSeedConsumed?:()=>void;onReveal?:()=>void;
}):React.JSX.Element {
  const list=useAsyncResource(projectId,()=>client.api.research.listReadingNotes({projectId}),{label:'读取笔记'});
  const [draft,setDraft]=useState<Draft|null>(null),[baseline,setBaseline]=useState<ReadingNote|null>(null);
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[filter,setFilter]=useState(''),[archived,setArchived]=useState(false);
  const [conflict,setConflict]=useState(false),[session,setSession]=useState(0);
  const [operation,setOperation]=useState<Operation|null>(null),[discardOpen,setDiscardOpen]=useState(false);
  const [deleting,setDeleting]=useState(false),[deleted,setDeleted]=useState(false);
  const saving=useRef(false),mounted=useRef(true),lastSeed=useRef<string|null>(null);
  const operationRef=useRef<Operation|null>(null),deletingRef=useRef(false);
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
  const beginOperation=(next:Operation):boolean=>{
    if(saving.current || operationRef.current!==null)return false;
    operationRef.current=next;setOperation(next);setError(null);exportNote.reset();reread.reset();return true;
  };
  const finishOperation=():void=>{operationRef.current=null;if(mounted.current)setOperation(null);};
  const deleteCurrentNote=async():Promise<void>=>{
    const {draft:current,baseline:stored}=latest.current;
    if(!current || !writable || operationRef.current!=='delete' || deletingRef.current)return;
    deletingRef.current=true;setDeleting(true);
    try{
      if(stored){
        const result=await client.api.research.deleteReadingNote({projectId,noteId:stored.id,expectedRevision:stored.revision});
        if(!mounted.current)return;
        if(!result.ok){setError(result.error.message);setConflict(true);return;}
      }
      latest.current={draft:null,baseline:null};setDraft(null);setBaseline(null);setConflict(false);setDeleted(true);list.reload();
    }catch(error){if(mounted.current){setError(String(error));setConflict(true);}}
    finally{deletingRef.current=false;if(mounted.current)setDeleting(false);finishOperation();}
  };
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
    if(!dirty && operation!=='delete')return;
    const navigation=(event:Event):void=>{event.preventDefault();onReveal?.();setError(operation==='delete'?'请先完成或取消删除笔记。':'笔记尚未保存。保存成功后可切换工作区。');};
    const unload=(event:BeforeUnloadEvent):void=>{event.preventDefault();event.returnValue='';};
    window.addEventListener(BEFORE_NAVIGATE,navigation);window.addEventListener('beforeunload',unload);
    return()=>{window.removeEventListener(BEFORE_NAVIGATE,navigation);window.removeEventListener('beforeunload',unload);};
  },[dirty,operation,onReveal]);
  const open=(note:ReadingNote):void=>{if(dirty || saving.current || operationRef.current!==null){setError('请先保存当前笔记。');return;}setDraft(note);setBaseline(note);setConflict(false);setError(null);setDeleted(false);exportNote.reset();reread.reset();setSession(value=>value+1);};
  const create=(title='未命名笔记',markdown=''):void=>{
    if(dirty || saving.current || operationRef.current!==null){setError('请先保存当前笔记。');return;}
    const existing=list.data??[];let candidate=title;let number=2;while(existing.some(note=>note.title===candidate && !note.archived))candidate=`${title} ${number++}`;
    setBaseline(null);setDraft({id:crypto.randomUUID(),title:candidate,markdown,itemId,archived:false});setConflict(false);setError(null);setDeleted(false);exportNote.reset();reread.reset();setSession(value=>value+1);
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
  const visibleNotes=(list.data??[]).filter(note=>(archived||!note.archived)&&(!itemId||note.itemId===itemId)&&`${note.title} ${note.markdown}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return <section className="reading-notes" data-testid="notes-panel" aria-label="阅读笔记"
    onKeyDown={event=>{if((event.metaKey||event.ctrlKey)&&event.key==='s'&&!event.nativeEvent.isComposing){event.preventDefault();void save();}}}>
    <header className="reading-toolbar reading-notes-header">
      <NotebookPen size={15} aria-hidden="true"/><h2>阅读笔记</h2>
      <span className="tabular-nums text-muted">{visibleNotes.length.toLocaleString('zh-CN')} 篇</span>
      <button type="button" disabled={!writable || dirty || pending} onClick={()=>create()} data-testid="notes-create"><FilePlus2 size={13} aria-hidden="true"/>新建</button>
    </header>
    {list.error?<p role="alert" className="p-2">{list.error}<button type="button" onClick={list.reload}>重试</button></p>:null}
    <div className="reading-notes-workspace">
      <aside className="reading-notes-index" aria-label="笔记列表">
        <div className="reading-notes-search">
          <input aria-label="搜索笔记" placeholder="搜索笔记" value={filter} onChange={event=>setFilter(event.target.value)}/>
          <label><input type="checkbox" checked={archived} onChange={event=>setArchived(event.target.checked)}/>含归档</label>
        </div>
        <select className="reading-notes-picker" aria-label="选择笔记" value={draft?.id??''} disabled={dirty||pending} onChange={event=>{const note=list.data?.find(note=>note.id===event.target.value);if(note)open(note);}}>
          <option value="">选择笔记</option>{visibleNotes.map(note=><option key={note.id} value={note.id}>{note.archived?'[归档] ':''}{note.title}</option>)}
        </select>
        <ul className="reading-notes-list">
          {visibleNotes.map(note=><li key={note.id}><button type="button" disabled={dirty||pending} aria-current={draft?.id===note.id?'true':undefined} onClick={()=>open(note)}>
            <strong>{note.title}</strong>
            <span className="reading-note-excerpt">{note.markdown.replace(/[#*`$>]/g,'').trim().slice(0,140)||'空白笔记'}</span>
            <small>{note.archived?'已归档':note.itemId?'文献笔记':'独立笔记'}</small>
          </button></li>)}
          {list.status==='ready'&&visibleNotes.length===0?<li className="reading-notes-no-results">{filter?'没有匹配的笔记':'尚无笔记'}</li>:null}
        </ul>
      </aside>
      <div className="reading-note-detail">
        <div className="reading-toolbar reading-note-savebar">
          <span role="status" className="text-muted">{operation==='delete'?(deleting?'删除中…':'等待确认删除'):operation==='export'?'导出中…':operation==='reload'?'重读中…':busy?'保存中…':conflict?'保存未完成':dirty?'未保存':draft?'已保存':deleted?'笔记已删除':list.status==='loading'?'读取笔记…':'未选择笔记'}</span>
          {draft?<button type="button" disabled={!writable||pending||!draft.title.trim()} aria-busy={busy} onClick={()=>void save()} data-testid="notes-save">
            {busy?<Loader2 size={13} className="animate-spin" aria-hidden="true"/>:null}{busy?'保存中…':'保存 ⌘S'}</button>:null}
        </div>
        {error||exportNote.error||reread.error?<p role="alert" className="p-2 text-[var(--st-warn)]">{error??exportNote.error??reread.error}</p>:null}
        {!draft?<div className="reading-notes-empty"><NotebookPen size={28} aria-hidden="true"/><h3>记录阅读中的发现</h3><p>选择一篇笔记，或新建笔记。</p></div>:<>
          <input className="reading-note-title" aria-label="笔记标题" value={draft.title} maxLength={200} disabled={!writable||draft.archived||operation==='reload'||operation==='delete'} onChange={event=>setDraft({...draft,title:event.target.value})}/>
          <details className="reading-disclosure reading-note-options">
            <summary data-testid="notes-options">笔记信息</summary>
            <div className="reading-toolbar">
              <label>关联文献 <select aria-label="关联文献" value={draft.itemId??''} disabled={!writable||draft.archived||operation==='reload'||operation==='delete'} onChange={event=>setDraft({...draft,itemId:event.target.value||null})}>
                <option value="">独立笔记</option>{items.map(item=><option key={item.id} value={item.id}>{item.metadata.title}</option>)}
              </select></label>
              <button type="button" disabled={dirty||pending||!baseline} onClick={()=>void exportStoredNote()}>导出 .md</button>
              <button type="button" disabled={!writable||pending} onClick={()=>setDraft({...draft,archived:!draft.archived})}>{draft.archived?'恢复笔记':'归档笔记'}</button>
              <button type="button" disabled={!writable||pending} onClick={()=>beginOperation('delete')} data-testid="notes-delete"><Trash2 size={13} aria-hidden="true"/>删除笔记</button>
            </div>
          </details>
          {conflict?<div className="reading-toolbar">
            <button type="button" disabled={pending} onClick={()=>setDiscardOpen(true)}>放弃草稿并重读</button>
            <button type="button" disabled={pending} onClick={()=>{setBaseline(null);setDraft({...draft,id:crypto.randomUUID(),title:`${draft.title}（副本）`});setConflict(false);}}>将草稿另存为副本</button>
          </div>:null}
          <ReadingNoteEditor key={`${draft.id}:${session}:${draft.archived}`} markdown={draft.markdown} editable={writable&&!draft.archived&&operation!=='reload'&&operation!=='delete'}
            titles={(list.data??[]).filter(note=>!note.archived&&note.id!==draft.id).map(note=>note.title)}
            onChange={markdown=>setDraft(current=>current?{...current,markdown}:current)} onLink={link}/>
          {backlinks.length?<details className="reading-disclosure reading-note-backlinks"><summary><Link2 size={13} aria-hidden="true"/>反向链接 {backlinks.length}</summary><div className="reading-toolbar">{backlinks.map(note=><button type="button" key={note.id} disabled={dirty||pending} onClick={()=>open(note)}>{note.title}</button>)}</div></details>:null}
        </>}
      </div>
    </div>
    <ConfirmDialog open={discardOpen} title="重读当前笔记" message="放弃未保存的草稿并载入已保存版本。重读成功后无法恢复这份草稿。"
      confirmLabel="放弃草稿并重读" tone="destructive" confirmDisabled={pending} testId="notes-discard-dialog"
      onCancel={()=>setDiscardOpen(false)} onConfirm={()=>void reloadStoredNote()}/>
    <ConfirmDialog open={operation==='delete'} title="删除阅读笔记" message={`删除“${draft?.title??''}”及其未保存修改？此操作无法撤销。`}
      confirmLabel="删除笔记" tone="destructive" confirmDisabled={!writable} pending={deleting} testId="notes-delete-dialog"
      onCancel={()=>{if(!deletingRef.current)finishOperation();}} onConfirm={deleteCurrentNote}/>
  </section>;
}
