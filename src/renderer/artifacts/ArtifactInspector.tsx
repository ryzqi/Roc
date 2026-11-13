import { LazyBoundary, retryableLazy } from '../shell/LazyBoundary';
import type {RocClient} from '../shared/roc-client';
import type {ArtifactReadingLocations} from './artifact-reading-location';
import type {ArtifactInspectorSelection} from './artifact-interactions';
import {StageArtifactInspector} from './StageArtifactInspector';
import type {ReviewProtocolDrafts} from './review-protocol-draft';
import {ArtifactEditorBoundary, useArtifactEditorGuard} from './artifact-editor-guard';

const ReviewInspector = retryableLazy(async () => ({default: (await import('./ReviewInspector')).ReviewInspector}));

export function ArtifactInspector({client, selection, writable, readingLocations, reviewDrafts, onClose, onOpenTask}: {
  client: RocClient; selection: ArtifactInspectorSelection; writable: boolean;
  readingLocations: ArtifactReadingLocations; reviewDrafts: ReviewProtocolDrafts;
  onClose: () => void; onOpenTask: (taskId: string) => void
}): React.JSX.Element {
  return <ArtifactEditorBoundary projectId={selection.request.projectId}>
    <InspectorContent client={client} selection={selection} writable={writable} readingLocations={readingLocations}
      reviewDrafts={reviewDrafts} onClose={onClose} onOpenTask={onOpenTask} />
  </ArtifactEditorBoundary>;
}

function InspectorContent({client, selection, writable, readingLocations, reviewDrafts, onClose, onOpenTask}:
  React.ComponentProps<typeof ArtifactInspector>): React.JSX.Element {
  const guard = useArtifactEditorGuard();
  const close = (): void => guard.request(onClose);
  return selection.kind === 'stage' ?
    <StageArtifactInspector client={client} request={selection.request} writable={writable} onReviewContext={selection.onReviewContext}
      readingLocations={readingLocations} onClose={close} onOpenTask={taskId => guard.request(() => onOpenTask(taskId))} /> :
    <LazyBoundary fallback={<p role="status">正在加载综述核查…</p>}>
      <ReviewInspector client={client} request={selection.request} writable={writable} drafts={reviewDrafts} onClose={close} />
    </LazyBoundary>;
}
