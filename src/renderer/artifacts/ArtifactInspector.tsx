import {lazy, Suspense} from 'react';
import type {RocClient} from '../shared/roc-client';
import type {ArtifactReadingLocations} from './artifact-reading-location';
import type {ArtifactInspectorSelection} from './artifact-interactions';
import {StageArtifactInspector} from './StageArtifactInspector';
import type {ReviewProtocolDrafts} from './review-protocol-draft';

const ReviewInspector = lazy(async () => ({default: (await import('./ReviewInspector')).ReviewInspector}));

export function ArtifactInspector({client, selection, writable, readingLocations, reviewDrafts, onClose, onOpenTask}: {
  client: RocClient; selection: ArtifactInspectorSelection; writable: boolean;
  readingLocations: ArtifactReadingLocations; reviewDrafts: ReviewProtocolDrafts;
  onClose: () => void; onOpenTask: (taskId: string) => void
}): React.JSX.Element {
  return selection.kind === 'stage' ?
    <StageArtifactInspector client={client} request={selection.request} writable={writable} onReviewContext={selection.onReviewContext}
      readingLocations={readingLocations} onClose={onClose} onOpenTask={onOpenTask} /> :
    <Suspense fallback={<p role="status">正在加载综述核查…</p>}>
      <ReviewInspector client={client} request={selection.request} writable={writable} drafts={reviewDrafts} onClose={onClose} />
    </Suspense>;
}
