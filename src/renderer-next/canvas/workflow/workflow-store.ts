import type {
  ResearchArtifact,
  ResearchArtifactContent,
  ResearchReviewCycle,
  ResearchStagePolicy,
  ResearchStageRoleProfile,
  ResearchStageRun,
  ResearchWorkflowEvent,
  ResearchWorkflowSnapshot,
  ResearchWorkflowTransitionRequest
} from '../../../shared/types';
// `research-production-inputs.ts` has no `shared/types` re-export (P6 finding F18), so the
// two production-input types are taken from the schema module directly. Type-only: zod is
// erased at build time (same technique as `assistant/transcript.ts`).
import type {
  ResearchProductionInput,
  ResearchProductionInputContent
} from '../../../shared/schemas/research-production-inputs';
import type { IpcLikeResult } from '../../app/loaded-state';
import type { RocClient } from '../../shared/roc-client';

/**
 * Research-workflow data layer (P6/T6.4, T6.5, T6.9).
 *
 * One thin wrapper per capability, exactly like `literature/library-store.ts`, so
 * components never name preload methods. The **contract survey** this phase ran first
 * (F18) matters here, because three of the names the plan used do not exist and the
 * argument *shapes* differ in ways that are easy to get wrong:
 *
 *   | 计划原文                             | 实际 capability                        |
 *   |--------------------------------------|----------------------------------------|
 *   | `research.workflow.artifactContent`  | `research.artifacts.content`           |
 *   | `research.productionInputInspect`    | `research.artifacts.inspectProduction` |
 *   | `research.productionInputRead`       | `research.artifacts.readProductionFile`|
 *
 * And the preload **method** names differ again (`getWorkflow`, `startStageRun`,
 * `listStageRuns`, …), which is why nothing here is typed from the plan text.
 *
 * `research.workflow.get` takes `{ id }` (the project id) while everything else in the
 * domain takes `{ projectId }`; `research.artifacts.get` / `update` take `{ id }`. Those
 * asymmetries are the contract's, not ours.
 */

export function getWorkflow(client: RocClient, projectId: string): Promise<IpcLikeResult<ResearchWorkflowSnapshot>> {
  return client.api.research.getWorkflow({ id: projectId });
}

export function transitionWorkflow(
  client: RocClient,
  request: ResearchWorkflowTransitionRequest
): Promise<IpcLikeResult<ResearchWorkflowSnapshot>> {
  return client.api.research.transitionWorkflow(request);
}

export function listWorkflowEvents(
  client: RocClient,
  projectId: string,
  limit: number
): Promise<IpcLikeResult<ResearchWorkflowEvent[]>> {
  return client.api.research.listWorkflowEvents({ projectId, limit });
}

export function listStagePolicies(client: RocClient, projectId: string): Promise<IpcLikeResult<ResearchStagePolicy[]>> {
  return client.api.research.listStagePolicies({ projectId });
}

export function getReviewCycle(client: RocClient, projectId: string): Promise<IpcLikeResult<ResearchReviewCycle | null>> {
  return client.api.research.getReviewCycle({ projectId });
}

export function getRoleProfile(
  client: RocClient,
  stage: ResearchStageRun['stage']
): Promise<IpcLikeResult<ResearchStageRoleProfile>> {
  return client.api.research.getRoleProfile({ stage });
}

export function startStageRun(
  client: RocClient,
  input: { projectId: string; expectedStage: ResearchStageRun['stage']; instruction: string; requestId: string }
): Promise<IpcLikeResult<ResearchStageRun>> {
  return client.api.research.startStageRun(input);
}

export function listStageRuns(
  client: RocClient,
  projectId: string,
  limit: number
): Promise<IpcLikeResult<ResearchStageRun[]>> {
  return client.api.research.listStageRuns({ projectId, limit });
}

export function cancelStageRun(
  client: RocClient,
  projectId: string,
  runId: string
): Promise<IpcLikeResult<ResearchStageRun>> {
  return client.api.research.cancelStageRun({ projectId, runId });
}

export function retryStageRun(
  client: RocClient,
  input: { projectId: string; runId: string; requestId: string }
): Promise<IpcLikeResult<ResearchStageRun>> {
  return client.api.research.retryStageRun(input);
}

export function listArtifacts(
  client: RocClient,
  projectId: string,
  stage?: ResearchStageRun['stage']
): Promise<IpcLikeResult<ResearchArtifact[]>> {
  return stage === undefined
    ? client.api.research.listArtifacts({ projectId })
    : client.api.research.listArtifacts({ projectId, stage });
}

export function getArtifactContent(
  client: RocClient,
  projectId: string,
  artifactId: string
): Promise<IpcLikeResult<ResearchArtifactContent | null>> {
  return client.api.research.getArtifactContent({ projectId, artifactId });
}

export function createArtifact(
  client: RocClient,
  input: {
    projectId: string;
    stage: ResearchStageRun['stage'];
    kind: ResearchArtifact['kind'];
    title: string;
    path: string | null;
  }
): Promise<IpcLikeResult<ResearchArtifact>> {
  return client.api.research.createArtifact(input);
}

export function updateArtifact(
  client: RocClient,
  input: { id: string; title?: string; path?: string | null }
): Promise<IpcLikeResult<ResearchArtifact>> {
  return client.api.research.updateArtifact(input);
}

export function inspectProductionInput(
  client: RocClient,
  projectId: string,
  artifactId: string
): Promise<IpcLikeResult<ResearchProductionInput>> {
  return client.api.research.inspectProductionInput({ projectId, artifactId });
}

export function readProductionInputFile(
  client: RocClient,
  input: {
    projectId: string;
    artifactId: string;
    area: ResearchProductionInput['files'][number]['area'];
    path: string;
  }
): Promise<IpcLikeResult<ResearchProductionInputContent>> {
  return client.api.research.readProductionInputFile(input);
}

/**
 * Request ids for `startRun` / `retryRun`.
 *
 * The backend treats `requestId` as an idempotency key: replaying the same id with the
 * same instruction returns the existing run instead of starting a second one, while the
 * same id with a different instruction is rejected as `research_run_request_conflict`.
 * So it must be unique per *attempt*.
 */
export function createRequestId(): string {
  return `renderer_${crypto.randomUUID()}`;
}
