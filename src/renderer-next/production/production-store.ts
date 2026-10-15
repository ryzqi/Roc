import type {
  ResearchClaim,
  ResearchEmbeddingConfig,
  ResearchEvidence,
  ResearchExportBundle,
  ResearchExportDelivery,
  ResearchExportExecution,
  ResearchFigurePublication,
  ResearchFigureRun,
  ResearchExperimentEnvironment,
  ResearchExperimentExecution,
  ResearchExperimentFile,
  ResearchExperimentFileContent,
  ResearchIdeaCanvas,
  ResearchIdeaPromotion,
  ResearchManuscript,
  ResearchModelsStatus,
  ResearchProvenance,
  ResearchStagePolicy,
  ResearchTemplate,
  ResearchTemplateFile,
  ResearchTemplateFileContent,
  ResearchToolchainStatus
} from '../../shared/types';
import type { SettingsSnapshot } from '../../shared/types/settings';
import type { ResearchExperimentRuntime } from '../../shared/schemas/research-experiments';
import type { ResearchFigureOptions } from '../../shared/schemas/research-plotting';
/* ------------------------------------------------------------------ */
/* 项目设置组：阶段策略与嵌入配置摘要 (T7.8 / T7.9)                    */
/* ------------------------------------------------------------------ */

/** Writes a whole stage policy (the contract has no partial patch). */
export function saveStagePolicy(
  client: RocClient,
  policy: ResearchStagePolicy
): Promise<IpcLikeResult<ResearchStagePolicy>> {
  return client.api.research.saveStagePolicy(policy);
}

/**
 * The embedding configurations, for the **read-only** summary.
 *
 * The write path (`research.embedding.save`) requires a plaintext `apiKey` (B23) and the
 * settings centre is the single source of truth for index configuration (MASTER v2 §7), so this
 * store deliberately exposes only the read.
 */
export function listEmbeddingConfigs(client: RocClient): Promise<IpcLikeResult<ResearchEmbeddingConfig[]>> {
  return client.api.research.listEmbeddingConfigs();
}

/** Provider/model options for the policy editor come from the real settings snapshot. */
export function getSettings(client: RocClient): Promise<IpcLikeResult<SettingsSnapshot>> {
  return client.api.settings.get();
}

/**
 * The export reader's payload.
 *
 * `researchExportFileContentSchema` has no exported *type* (the `shared/types` barrel only
 * re-exports the export execution/delivery types), and importing the schema module would pull
 * zod into the renderer chunk — so the shape is expressed structurally from types that are
 * exported, which is exactly what the schema says.
 */
export type ExportFileContent = {
  file: ResearchExportExecution['files'][number];
  content: string;
  encoding: 'utf8' | 'base64';
};
import type { IpcLikeResult } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';

/**
 * Research-production data layer (P7/T7.1–T7.9).
 *
 * One wrapper per capability, exactly like P5/P6's stores, so no component ever names a
 * preload method. Four contract facts shape the signatures and are worth stating here
 * because they are the ones that go wrong when someone "simplifies" a call site (F20):
 *
 *  1. **Idea Canvas and manuscript are keyed by `artifactId`**, not `projectId`
 *     (`research.ideas.get/history/save`, `research.manuscript.get/save`). They hang off a
 *     stage artifact, which is also what the stage workspace already has.
 *  2. **A run executes a workspace file.** `research.experiment.start` / `figure.start` take
 *     `sourcePath` (workspace-relative) plus `engine` and a `runtime` that the schema
 *     cross-checks against that engine (`r`→`renv`, `julia`→`julia`, `python`→`bundled-python|uv`,
 *     and the extension must match). So the panels select an existing file; there is no
 *     "paste a script" path in the contract.
 *  3. **`research.experiment.evidenceSource` returns a *file locator*** (nullable
 *     `researchExperimentFileRequestSchema`), not the execution record: the evidence tells
 *     you which run file it came from.
 *  4. **Binary reads come back as base64 text** (`{content, encoding}`) — template preview,
 *     figures and exports have no protocol-URL path (B21), so the panels render what the
 *     contract can actually deliver and say so.
 */

/* ------------------------------------------------------------------ */
/* 构思 (T7.1)                                                         */
/* ------------------------------------------------------------------ */

export function getIdeaCanvas(client: RocClient, artifactId: string): Promise<IpcLikeResult<ResearchIdeaCanvas | null>> {
  return client.api.research.getIdeaCanvas({ artifactId });
}

export function listIdeaCanvasHistory(client: RocClient, artifactId: string): Promise<IpcLikeResult<ResearchIdeaCanvas[]>> {
  return client.api.research.getIdeaCanvasHistory({ artifactId });
}

export function saveIdeaCanvas(
  client: RocClient,
  input: {
    artifactId: string;
    expectedVersion: number | null;
    problem: string;
    hypothesis: string;
    novelty: string;
    supportingEvidence: string;
    counterevidence: string;
    experiment: string;
    risks: string;
    priority: ResearchIdeaCanvas['priority'];
    rationale: string;
    fields: ResearchIdeaCanvas['fields'];
  }
): Promise<IpcLikeResult<ResearchIdeaCanvas>> {
  return client.api.research.saveIdeaCanvas(input);
}

export function promoteIdeaCanvas(
  client: RocClient,
  input: {
    artifactId: string;
    expectedVersion: number;
    title?: string;
    description?: string;
    workspacePath: string;
    language?: 'zh' | 'en';
  }
): Promise<IpcLikeResult<ResearchIdeaPromotion>> {
  return client.api.research.promoteIdeaCanvas(input);
}

/* ------------------------------------------------------------------ */
/* 实验运行 (T7.2)                                                     */
/* ------------------------------------------------------------------ */

export function inspectExperimentEnvironment(
  client: RocClient,
  input: { projectId: string; runtime: ResearchExperimentRuntime }
): Promise<IpcLikeResult<ResearchExperimentEnvironment>> {
  return client.api.research.inspectExperimentEnvironment(input);
}

export function startExperiment(
  client: RocClient,
  input: {
    projectId: string;
    requestId: string;
    label: string;
    engine: 'python' | 'r' | 'julia';
    runtime: ResearchExperimentRuntime;
    sourcePath: string;
    inputPaths: string[];
    arguments: string[];
    parameters: Record<string, string>;
    expectedEnvironmentHash?: string;
    timeoutMs: number;
    network: 'disabled' | 'enabled';
  }
): Promise<IpcLikeResult<ResearchExperimentExecution>> {
  return client.api.research.startExperiment(input);
}

export function getExperiment(
  client: RocClient,
  input: { projectId: string; runId: string }
): Promise<IpcLikeResult<ResearchExperimentExecution>> {
  return client.api.research.getExperiment(input);
}

export function listExperiments(
  client: RocClient,
  input: { projectId: string; limit: number }
): Promise<IpcLikeResult<ResearchExperimentExecution[]>> {
  return client.api.research.listExperiments(input);
}

export function cancelExperiment(
  client: RocClient,
  input: { projectId: string; runId: string }
): Promise<IpcLikeResult<ResearchExperimentExecution>> {
  return client.api.research.cancelExperiment(input);
}

export function readExperimentFile(
  client: RocClient,
  input: { projectId: string; runId: string; area: ResearchExperimentFile['area']; path: string }
): Promise<IpcLikeResult<ResearchExperimentFileContent>> {
  return client.api.research.readExperimentFile(input);
}

export function publishExperiment(
  client: RocClient,
  input: { projectId: string; runId: string }
): Promise<IpcLikeResult<ResearchExperimentExecution>> {
  return client.api.research.publishExperiment(input);
}

/** Where an evidence record's originating run file lives (a locator, not the run record). */
export function getEvidenceExperimentSource(
  client: RocClient,
  input: { projectId: string; evidenceId: string }
): Promise<IpcLikeResult<{ projectId: string; runId: string; area: ResearchExperimentFile['area']; path: string } | null>> {
  return client.api.research.getEvidenceExperimentSource(input);
}

/* ------------------------------------------------------------------ */
/* 图稿 (T7.3)                                                         */
/* ------------------------------------------------------------------ */

export function inspectFigureEnvironment(
  client: RocClient,
  input: { projectId: string; runtime: ResearchExperimentRuntime }
): Promise<IpcLikeResult<ResearchExperimentEnvironment>> {
  return client.api.research.inspectFigureEnvironment(input);
}

export function startFigure(
  client: RocClient,
  input: {
    projectId: string;
    requestId: string;
    label: string;
    runtime: ResearchExperimentRuntime;
    sourcePath: string;
    inputPaths: string[];
    arguments: string[];
    parameters: Record<string, string>;
    expectedEnvironmentHash?: string;
    timeoutMs: number;
    figure: ResearchFigureOptions;
  }
): Promise<IpcLikeResult<ResearchFigureRun>> {
  return client.api.research.startFigure(input);
}

export function getFigureRun(
  client: RocClient,
  input: { projectId: string; runId: string }
): Promise<IpcLikeResult<ResearchFigureRun>> {
  return client.api.research.getFigureRun(input);
}

export function listFigureRuns(
  client: RocClient,
  input: { projectId: string; limit: number }
): Promise<IpcLikeResult<ResearchFigureRun[]>> {
  return client.api.research.listFigureRuns(input);
}

export function cancelFigure(
  client: RocClient,
  input: { projectId: string; runId: string }
): Promise<IpcLikeResult<ResearchFigureRun>> {
  return client.api.research.cancelFigure(input);
}

export function readFigureFile(
  client: RocClient,
  input: { projectId: string; runId: string; area: ResearchExperimentFile['area']; path: string }
): Promise<IpcLikeResult<ResearchExperimentFileContent>> {
  return client.api.research.readFigureFile(input);
}

export function publishFigure(
  client: RocClient,
  input: { projectId: string; runId: string; replacesFigureId: string | null }
): Promise<IpcLikeResult<ResearchFigurePublication>> {
  return client.api.research.publishFigure(input);
}

export function getFigure(
  client: RocClient,
  input: { projectId: string; figureId: string }
): Promise<IpcLikeResult<ResearchFigurePublication>> {
  return client.api.research.getFigure(input);
}

export function listFigures(
  client: RocClient,
  input: { projectId: string; limit: number }
): Promise<IpcLikeResult<ResearchFigurePublication[]>> {
  return client.api.research.listFigures(input);
}

/* ------------------------------------------------------------------ */
/* 证据与主张 (T7.6)                                                   */
/* ------------------------------------------------------------------ */

/** Still needs a `chunkId` — arbitrary text capture has no interface (B15, F16). */
export function captureEvidence(
  client: RocClient,
  input: { projectId: string; chunkId: string }
): Promise<IpcLikeResult<ResearchEvidence>> {
  return client.api.research.captureEvidence(input);
}

export function listEvidence(client: RocClient, projectId: string): Promise<IpcLikeResult<ResearchEvidence[]>> {
  return client.api.research.listEvidence({ projectId });
}

export function createClaim(
  client: RocClient,
  input: {
    projectId: string;
    artifactId: string;
    subjectType: ResearchClaim['subjectType'];
    content: string;
    status: ResearchClaim['status'];
    evidenceIds: string[];
  }
): Promise<IpcLikeResult<ResearchClaim>> {
  return client.api.research.createClaim(input);
}

export function updateClaim(
  client: RocClient,
  input: {
    id: string;
    content: string;
    status: ResearchClaim['status'];
    evidenceIds: string[];
    expectedVersion: number;
  }
): Promise<IpcLikeResult<ResearchClaim>> {
  return client.api.research.updateClaim(input);
}

export function listClaims(
  client: RocClient,
  input: { projectId: string; artifactId?: string }
): Promise<IpcLikeResult<ResearchClaim[]>> {
  return input.artifactId === undefined
    ? client.api.research.listClaims({ projectId: input.projectId })
    : client.api.research.listClaims({ projectId: input.projectId, artifactId: input.artifactId });
}

export function getClaimHistory(client: RocClient, claimId: string): Promise<IpcLikeResult<ResearchClaim[]>> {
  return client.api.research.getClaimHistory({ id: claimId });
}

/* ------------------------------------------------------------------ */
/* 正文 (T7.4)                                                         */
/* ------------------------------------------------------------------ */

export function getManuscript(client: RocClient, artifactId: string): Promise<IpcLikeResult<ResearchManuscript | null>> {
  return client.api.research.getManuscript({ artifactId });
}

export function saveManuscript(
  client: RocClient,
  input: { artifactId: string; sections: ResearchManuscript['sections'] }
): Promise<IpcLikeResult<ResearchManuscript>> {
  return client.api.research.saveManuscript(input);
}

export function getExportBundle(
  client: RocClient,
  input: { projectId: string; artifactId: string }
): Promise<IpcLikeResult<ResearchExportBundle>> {
  return client.api.research.getExportBundle(input);
}

/* ------------------------------------------------------------------ */
/* 模板包与工具链 (T7.5)                                               */
/* ------------------------------------------------------------------ */

export function importTemplate(
  client: RocClient,
  input: { projectId: string; sourcePath: string }
): Promise<IpcLikeResult<ResearchTemplate>> {
  return client.api.research.importTemplate(input);
}

export function listTemplates(client: RocClient, projectId: string): Promise<IpcLikeResult<ResearchTemplate[]>> {
  return client.api.research.listTemplates({ projectId });
}

export function getTemplate(
  client: RocClient,
  input: { projectId: string; templateId: string }
): Promise<IpcLikeResult<ResearchTemplate>> {
  return client.api.research.getTemplate(input);
}

export function compileTemplate(
  client: RocClient,
  input: { projectId: string; templateId: string }
): Promise<IpcLikeResult<ResearchTemplate>> {
  return client.api.research.compileTemplate(input);
}

export function cancelTemplateCompile(
  client: RocClient,
  input: { projectId: string; templateId: string }
): Promise<IpcLikeResult<ResearchTemplate>> {
  return client.api.research.cancelTemplateCompile(input);
}

export function getTemplateFiles(
  client: RocClient,
  input: { projectId: string; templateId: string }
): Promise<IpcLikeResult<ResearchTemplateFile[]>> {
  return client.api.research.getTemplateFiles(input);
}

export function readTemplateFile(
  client: RocClient,
  input: { projectId: string; templateId: string; path: string }
): Promise<IpcLikeResult<ResearchTemplateFileContent>> {
  return client.api.research.readTemplateFile(input);
}

export function saveTemplateFile(
  client: RocClient,
  input: { projectId: string; templateId: string; path: string; content: string; expectedHash: string | null }
): Promise<IpcLikeResult<ResearchTemplateFileContent>> {
  return client.api.research.saveTemplateFile(input);
}

export function setTemplateEntry(
  client: RocClient,
  input: { projectId: string; templateId: string; entryPath: string; expectedRevision: number }
): Promise<IpcLikeResult<ResearchTemplate>> {
  return client.api.research.setTemplateEntry(input);
}

export function getToolchainStatus(client: RocClient): Promise<IpcLikeResult<ResearchToolchainStatus>> {
  return client.api.research.getToolchainStatus();
}

export function getModelsStatus(client: RocClient): Promise<IpcLikeResult<ResearchModelsStatus>> {
  return client.api.research.getModelsStatus();
}

export function downloadModels(client: RocClient): Promise<IpcLikeResult<ResearchModelsStatus>> {
  return client.api.research.downloadModels();
}

/* ------------------------------------------------------------------ */
/* 导出包 (T7.7)                                                       */
/* ------------------------------------------------------------------ */

export function prepareExport(
  client: RocClient,
  input: {
    projectId: string;
    requestId: string;
    title: string;
    manuscriptArtifactId: string;
    figureIds: string[];
    template:
      | { kind: 'default'; language: 'zh' | 'en' }
      | { kind: 'imported'; templateId: string; expectedRevision: number; expectedSourceDigest: string };
  }
): Promise<IpcLikeResult<ResearchExportExecution>> {
  return client.api.research.prepareExport(input);
}

export function getExport(
  client: RocClient,
  input: { projectId: string; exportId: string }
): Promise<IpcLikeResult<ResearchExportExecution>> {
  return client.api.research.getExport(input);
}

export function listExports(
  client: RocClient,
  input: { projectId: string; limit: number }
): Promise<IpcLikeResult<ResearchExportExecution[]>> {
  return client.api.research.listExports(input);
}

export function cancelExport(
  client: RocClient,
  input: { projectId: string; exportId: string }
): Promise<IpcLikeResult<ResearchExportExecution>> {
  return client.api.research.cancelExport(input);
}

export function publishExport(
  client: RocClient,
  input: { projectId: string; exportId: string; replacesExportId: string | null }
): Promise<IpcLikeResult<ResearchExportExecution>> {
  return client.api.research.publishExport(input);
}

export function readExportFile(
  client: RocClient,
  input: { projectId: string; exportId: string; path: string }
): Promise<IpcLikeResult<ExportFileContent>> {
  return client.api.research.readExportFile(input);
}

/**
 * Writes the prepared archive to an **absolute** destination ending in `.zip`.
 *
 * The destination cannot be chosen by the user: there is no save dialog in the contract
 * (`files.selectFromDialog` picks files, not destinations — B22), so the panel only offers
 * this when it has a path from the backend/operator.
 */
export function writeExport(
  client: RocClient,
  input: { projectId: string; exportId: string; destinationPath: string }
): Promise<IpcLikeResult<ResearchExportDelivery>> {
  return client.api.research.writeExport(input);
}

/* ------------------------------------------------------------------ */
/* 溯源 (T7.x)                                                         */
/* ------------------------------------------------------------------ */

export function listProvenance(
  client: RocClient,
  input: { projectId: string; subjectId?: string }
): Promise<IpcLikeResult<ResearchProvenance[]>> {
  return input.subjectId === undefined
    ? client.api.research.listProvenance({ projectId: input.projectId })
    : client.api.research.listProvenance({ projectId: input.projectId, subjectId: input.subjectId });
}

export function addProvenance(
  client: RocClient,
  input: {
    projectId: string;
    artifactId: string | null;
    subjectType: ResearchProvenance['subjectType'];
    subjectId: string;
    sourceType: ResearchProvenance['sourceType'];
    sourceId: string;
    locator: string | null;
    excerpt: string | null;
  }
): Promise<IpcLikeResult<ResearchProvenance>> {
  return client.api.research.addProvenance(input);
}
