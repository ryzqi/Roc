import {useState} from 'react';
import type {ResearchArtifactInspectResult} from '../../shared/schemas/research-artifact-inspector';
import type {RocClient} from '../shared/roc-client';
import {LazyBoundary, retryableLazy} from '../shell/LazyBoundary';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {useArtifactEditorGuard} from './artifact-editor-guard';

const Feedback = retryableLazy(async () => ({default: (await import('./CollaborationFeedback')).CollaborationFeedback}));
const External = retryableLazy(async () => ({default: (await import('./CollaborationExternal')).CollaborationExternal}));
export type CollaborationProps = {client: RocClient; snapshot: ResearchArtifactInspectResult['snapshot']; writable: boolean; onChanged: () => void};

export function ArtifactCollaboration(props: CollaborationProps): React.JSX.Element {
  const [active, setActive] = useState<'feedback' | 'external' | null>(null);
  const guard = useArtifactEditorGuard();
  return <section className="mt-3 flex min-w-0 flex-col gap-3" data-testid="artifact-collaboration" aria-label="外部协作">
    <div className="flex flex-wrap gap-2">
      {(['feedback', 'external'] as const).map(key => <button key={key} type="button" className={formSecondaryButtonClass}
        disabled={guard.busy()} aria-pressed={active === key} data-testid={`artifact-collaboration-${key}`}
        onClick={() => guard.request(() => setActive(active === key ? null : key), '切换将放弃当前协作表单修改。')}>
        {key === 'feedback' ? 'Word / PDF 意见' : '外部实验回传'}
      </button>)}
    </div>
    {active === null ? null : <LazyBoundary fallback={<p role="status">正在读取协作记录…</p>}>
      {active === 'feedback' ? <Feedback {...props}/> : <External {...props}/>}
    </LazyBoundary>}
  </section>;
}
