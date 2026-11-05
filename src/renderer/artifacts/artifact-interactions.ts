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
