import type {ResearchArtifactInspectRequest} from '../../shared/schemas/research-artifact-inspector';
import type {ResearchGateReviewContext, ResearchGateReviewRequest} from '../../shared/schemas/research-gate-review';
import type {IpcResult} from '../../shared/types';
import type {ResearchReviewLink} from '../../shared/schemas/research-review-links';

export type OpenResearchArtifact = (
  request: ResearchArtifactInspectRequest,
  onReviewContext: (context: ResearchGateReviewContext) => void
) => void;
export type ReadResearchGateContext = (request: ResearchGateReviewRequest) => Promise<IpcResult<ResearchGateReviewContext>>;

export type ReviewInspectorRequest =
  | {mode: 'manage'; projectId: string; versionId: string | null}
  | (ResearchReviewLink & {mode: 'readonly'});
export type OpenReviewInspector = (request: ReviewInspectorRequest) => void;
export type ArtifactInspectorSelection =
  | {kind: 'stage'; request: ResearchArtifactInspectRequest; onReviewContext: (context: ResearchGateReviewContext) => void}
  | {kind: 'review'; request: ReviewInspectorRequest};

export const BEFORE_ARTIFACT_CHANGE = 'roc:before-artifact-inspector-change';
export type ArtifactChangeRequest = {defer: () => () => void};
let latestChange = 0;

/** The active inspector must release its draft before a shell entry can replace it. */
export function requestArtifactInspectorChange(proceed: () => void): void {
  const revision = ++latestChange;
  let remaining = 0, dispatched = false, completed = false;
  const complete = (): void => {
    if (!dispatched || remaining !== 0 || completed || event.defaultPrevented || revision !== latestChange) return;
    completed = true; proceed();
  };
  const event = new CustomEvent<ArtifactChangeRequest>(BEFORE_ARTIFACT_CHANGE, {cancelable: true, detail: {
    defer: () => {
      remaining++;
      let resumed = false;
      return () => {if (resumed) return; resumed = true; remaining--; complete();};
    }
  }});
  window.dispatchEvent(event); dispatched = true; complete();
}
