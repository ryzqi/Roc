import type {ResearchArtifactInspectRequest} from '../../shared/schemas/research-artifact-inspector';
import type {ResearchGateReviewContext, ResearchGateReviewRequest} from '../../shared/schemas/research-gate-review';
import type {IpcResult} from '../../shared/types';

export type OpenResearchArtifact = (
  request: ResearchArtifactInspectRequest,
  onReviewContext: (context: ResearchGateReviewContext) => void
) => void;
export type ReadResearchGateContext = (request: ResearchGateReviewRequest) => Promise<IpcResult<ResearchGateReviewContext>>;
