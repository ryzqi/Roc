import {useCallback, useRef, useState} from 'react';
import type {RocClient} from '../shared/roc-client';
import {WikiView, type WikiViewProps} from './WikiView';
import {WikiPages} from './WikiPages';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {LiteratureEditorBoundary} from './literature-editor-guard';

/** Both persisted drafts and the existing claim projection live in the same canvas. */
export function WikiWorkspace({client, projectId, writable, ...projection}: WikiViewProps & {
  client: RocClient; projectId: string | null; writable: boolean
}): React.JSX.Element {
  const [view, setView] = useState<'pages' | 'claims'>('pages'), [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);
  const onLock = useCallback((value: boolean) => {lockedRef.current = value; setLocked(value);}, []);
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex flex-wrap gap-2 border-b-[0.5px] border-line px-3 py-2" aria-label="知识库视图">
      {(['pages', 'claims'] as const).map(tab => <button key={tab} type="button" disabled={locked} aria-pressed={view === tab}
        className={`${formSecondaryButtonClass} aria-pressed:bg-[var(--overlay-active)]`}
        onClick={() => {if (!lockedRef.current) setView(tab);}}>{tab === 'pages' ? '持久 Wiki' : '主张与证据'}</button>)}
    </div>
    {view === 'claims' ? <WikiView {...projection}/> : projectId === null ? <p className="p-3 text-subtle">选择研究项目以维护持久 Wiki 页面。</p> :
      <LiteratureEditorBoundary key={projectId} projectId={projectId} protectReadingChange={false}>
        <WikiPages client={client} projectId={projectId} snapshot={projection.snapshot} writable={writable}
          onAskAssistant={projection.onAskAssistant} onLock={onLock}/>
      </LiteratureEditorBoundary>}
  </div>;
}
