import {useCallback, useRef, useState} from 'react';
import type {RocClient} from '../shared/roc-client';
import {WikiView, type WikiViewProps} from './WikiView';
import {WikiPages} from './WikiPages';
import {BookOpen, Layers, Network} from 'lucide-react';
import './knowledge-workspace.css';
import {LiteratureEditorBoundary} from './literature-editor-guard';
import {ScientificKnowledgePanel} from './ScientificKnowledgePanel';

/** Both persisted drafts and the existing claim projection live in the same canvas. */
export function WikiWorkspace({client, projectId, writable, ...projection}: WikiViewProps & {
  client: RocClient; projectId: string | null; writable: boolean
}): React.JSX.Element {
  const [view, setView] = useState<'pages' | 'claims' | 'scientific'>('pages'), [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);
  const onLock = useCallback((value: boolean) => {lockedRef.current = value; setLocked(value);}, []);
  return <div className="knowledge-workspace flex min-h-0 min-w-0 flex-1 flex-col">
    <nav className="knowledge-view-switch" aria-label="知识库视图">
      {(['pages', 'claims', 'scientific'] as const).map(tab => <button key={tab} type="button" disabled={locked} aria-pressed={view === tab}
        className="knowledge-view-button"
        onClick={() => {if (!lockedRef.current) setView(tab);}}>
        {tab === 'pages' ? <BookOpen size={14} aria-hidden="true"/> : tab === 'claims' ? <Layers size={14} aria-hidden="true"/> : <Network size={14} aria-hidden="true"/>}
        {tab === 'pages' ? '知识页面' : tab === 'claims' ? '主张与证据' : '结构化知识'}</button>)}
    </nav>
    {view === 'claims' ? <WikiView {...projection} client={client} projectId={projectId}/> : projectId === null ? <p className="p-3 text-subtle">选择研究项目以维护持久 Wiki 页面。</p> :
      view === 'scientific' ? <ScientificKnowledgePanel client={client} projectId={projectId}/> :
      <LiteratureEditorBoundary key={projectId} projectId={projectId} protectReadingChange={false}>
        <WikiPages client={client} projectId={projectId} snapshot={projection.snapshot} writable={writable}
          onAskAssistant={projection.onAskAssistant} onLock={onLock}/>
      </LiteratureEditorBoundary>}
  </div>;
}
