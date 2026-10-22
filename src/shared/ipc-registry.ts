import { z } from 'zod';

import { menuPages } from './surfaces';

import {
  agentCapabilityPreviewRequestSchema,
  agentCapabilityPreviewSchema,
  agentRuntimeStatusSchema,
  deepAgentConfigPreviewSchema
} from './schemas/agent';
import {
  pilotOptInRequestSchema,
  pilotStatusSchema
} from './schemas/harness-pilot';
import {
  activeChatRunSchema,
  chatActiveRunRequestSchema,
  chatCancelRunResultSchema,
  chatRunEventSchema,
  chatRunEventsReplayRequestSchema,
  chatRunEventsReplayResultSchema,
  chatCorrectRunRequestSchema,
  chatCorrectRunResultSchema,
  chatResumeRunRequestSchema,
  chatResumeRunResultSchema,
  chatStartRunIpcRequestSchema,
  chatStartRunResultSchema
} from './schemas/chat';
import {
  activeTaskItemSchema,
  appStatusSchema,
  backgroundTaskPreviewRequestSchema,
  backgroundTaskPreviewSchema,
  backgroundTaskSchema,
  closedResultSchema,
  deletedResultSchema,
  deliveredResultSchema,
  diagnosticCheckSchema,
  diagnosticPackageRequestSchema,
  diagnosticPackageSchema,
  healthCheckResultSchema,
  ipcResultSchema,
  metricFilterSchema,
  metricsSnapshotSchema,
  openedPageResultSchema,
  openedResultSchema,
  performanceSampleRequestSchema,
  performanceSampleSchema,
  scheduledTaskRunSchema,
  scheduledTaskRunsRequestSchema,
  schedulerStatusSchema,
  systemAppearanceSnapshotSchema,
  taskDeleteBackgroundResultSchema,
  taskDeleteThreadRequestSchema,
  taskDeleteThreadResultSchema,
  taskDetailSchema,
  taskIdRequestSchema,
  taskMessageHistoryPageSchema,
  taskMessageHistoryRequestSchema,
  taskRunNowResultSchema,
  taskSnapshotSchema,
  taskUpdateEventSchema,
  traySummarySchema,
  updateBackgroundTaskRequestSchema,
  windowBoundsSnapshotSchema,
  windowHiddenSnapshotSchema,
  windowStateSnapshotSchema
} from './schemas/ipc-core';
import {
  memoryFileReadRequestSchema,
  memoryFileWriteOutcomeSchema,
  memoryFileWriteRequestSchema,
  memorySnapshotPreviewSchema,
  memoryStatusSchema,
  providerSecretClearResultSchema,
  providerSecretSetRequestSchema,
  providerSecretSetResultSchema,
  providerTestRequestSchema,
  providerTestResultSchema,
  rocHookConfigSnapshotSchema,
  sessionListInputSchema,
  sessionMessageSchema,
  sessionMessageSearchRequestSchema,
  sessionMessageSearchResultSchema,
  settingsSaveHookConfigRequestSchema,
  settingsSaveRequestSchema,
  settingsSnapshotSchema,
  settingsTrustHookRequestSchema
} from './schemas/ipc-memory-settings';
import {
  builtinSkillsAutoUpdateRequestSchema,
  builtinSkillsCheckRequestSchema,
  builtinSkillsCheckResultSchema,
  builtinSkillsStatusSchema
} from './schemas/builtin-skills';
import {
  mcpApprovalModeRequestSchema,
  mcpServerConfigSchema,
  mcpServerEnabledRequestSchema,
  mcpServerSnapshotSchema,
  mcpServerTestResultSchema,
  mcpServersConfigSchema,
  skillEnabledRequestSchema,
  skillFilePreviewRequestSchema,
  skillFilePreviewResultSchema,
  skillFileTreeRequestSchema,
  skillFileTreeResultSchema,
  skillImportRequestSchema,
  skillSnapshotSchema
} from './schemas/ipc-mcp-skills';
import {
  researchProjectCreateRequestSchema,
  researchProjectIdRequestSchema,
  researchProjectSchema,
  researchProjectUpdateRequestSchema,
  researchEmbeddingConfigSaveRequestSchema,
  researchEmbeddingConfigSchema,
  researchKnowledgeDocumentSchema,
  researchKnowledgeDocumentUpsertRequestSchema,
  researchKnowledgeSearchRequestSchema,
  researchKnowledgeSearchResultSchema,
  researchLiteratureSearchRequestSchema,
  researchLiteratureSchema,
  researchStageRoleProfileSchema,
  researchStageRoleRequestSchema,
  researchProvenanceCreateRequestSchema,
  researchProvenanceListRequestSchema,
  researchProvenanceSchema,
  researchArtifactCreateRequestSchema,
  researchArtifactIdRequestSchema,
  researchArtifactListRequestSchema,
  researchArtifactSchema,
  researchArtifactUpdateRequestSchema,
  researchWorkflowEventSchema,
  researchWorkflowEventsRequestSchema,
  researchTemplateCompileRequestSchema,
  researchTemplateImportRequestSchema,
  researchTemplateSchema,
  researchWorkflowSnapshotSchema,
  researchWorkflowTransitionRequestSchema
} from './schemas/research';
import {
  researchTemplateEntryRequestSchema, researchTemplateFileContentSchema, researchTemplateFileRequestSchema,
  researchTemplateFileSaveRequestSchema, researchTemplateFileSchema, researchTemplateListRequestSchema,
  researchToolchainStatusSchema, researchModelsStatusSchema
} from './schemas/research-production';
import { researchProseLintReportSchema, researchProseLintRequestSchema } from './schemas/research-prose';
import {
  researchLibraryArchiveRequestSchema, researchLibraryCitationKeyRequestSchema, researchLibraryDoiImportRequestSchema,
  researchLibraryExportRequestSchema, researchLibraryExportSchema, researchLibraryFileImportRequestSchema,
  researchLibraryIdRequestSchema, researchLibraryImportResultSchema, researchLibraryItemSchema, researchLibraryLinkRequestSchema,
  researchLibraryListRequestSchema, researchLibraryRecordImportRequestSchema
} from './schemas/research-library';
import {
  researchDocumentIdRequestSchema, researchDocumentImportRequestSchema, researchDocumentListRequestSchema,
  researchDocumentParseRequestSchema, researchDocumentParseSchema, researchDocumentRunSchema, researchDocumentSchema
} from './schemas/research-documents';
import {
  researchIndexedFileSchema, researchIndexedSourceSchema, researchIndexControlRequestSchema, researchIndexEvidenceSourceRequestSchema,
  researchIndexFilesRequestSchema, researchIndexJobsRequestSchema, researchIndexJobSchema, researchIndexProjectRequestSchema,
  researchIndexSettingsSaveSchema, researchIndexStatusSchema
} from './schemas/research-index';
import { researchExperimentEnvironmentRequestSchema, researchExperimentEnvironmentSchema, researchExperimentEvidenceRequestSchema,
  researchExperimentExecutionSchema, researchExperimentFileContentSchema, researchExperimentFileRequestSchema, researchExperimentIdRequestSchema,
  researchExperimentListRequestSchema, researchExperimentStartSchema } from './schemas/research-experiments';
import { researchFigureIdRequestSchema, researchFigureListRequestSchema, researchFigurePublicationSchema,
  researchFigurePublishRequestSchema, researchFigureRunSchema, researchFigureStartSchema } from './schemas/research-figures';
import { researchExportDeliverySchema, researchExportExecutionSchema, researchExportFileContentSchema, researchExportIdRequestSchema,
  researchExportListRequestSchema, researchExportPrepareSchema, researchExportPublishRequestSchema, researchExportReadRequestSchema,
  researchExportWriteRequestSchema } from './schemas/research-exports';
import { researchProductionInputContentSchema, researchProductionInputReadSchema, researchProductionInputRequestSchema,
  researchProductionInputSchema } from './schemas/research-production-inputs';
import {
  fileDialogSelectionSchema,
  fileNameSearchRequestSchema,
  fileNameSearchResultSchema,
  filePdfPreviewRequestSchema,
  filePdfPreviewResultSchema,
  filePreviewRequestSchema,
  filePreviewResultSchema,
  fileSearchRequestSchema,
  fileSearchResultSchema,
  fileTreeRequestSchema,
  fileTreeResultSchema,
  fileWriteResultSchema,
  fileWriteTextRequestSchema,
  gitBatchFileOperationRequestSchema,
  gitBranchListResultSchema,
  gitBranchMutationResultSchema,
  gitCheckoutBranchRequestSchema,
  gitCommitRequestSchema,
  gitCommitResultSchema,
  gitCreateBranchRequestSchema,
  gitDiffStatResultSchema,
  gitFileDiffResultSchema,
  gitFileOperationRequestSchema,
  gitPushResultSchema,
  gitStatusResultSchema,
  rtkStatusSchema,
  shellConfirmationRequestSchema,
  shellConfirmationResultSchema,
  shellExecutionIpcRequestSchema,
  shellExecutionResultSchema,
  terminalSessionCloseRequestSchema,
  terminalSessionCreateRequestSchema,
  terminalSessionExitEventSchema,
  terminalSessionInputRequestSchema,
  terminalSessionOutputEventSchema,
  terminalSessionResizeRequestSchema,
  terminalSessionSnapshotSchema,
  workspaceChangedEventSchema,
  workspaceSchema,
  workspaceSelectRequestSchema
} from './schemas/ipc-workspace';
import type { IpcResult } from './types';
import {
  researchArtifactContentRequestSchema, researchArtifactContentSchema, researchStagePoliciesRequestSchema,
  researchStagePolicySchema, researchStageRunIdRequestSchema, researchStageRunRetryRequestSchema,
  researchStageRunSchema, researchStageRunStartRequestSchema, researchStageRunsRequestSchema, researchReviewCycleSchema
} from './schemas/research-runs';
import {
  researchClaimCreateRequestSchema,
  researchClaimHistoryRequestSchema,
  researchClaimListRequestSchema,
  researchClaimSchema,
  researchClaimUpdateRequestSchema,
  researchEvidenceCaptureRequestSchema,
  researchEvidenceListRequestSchema,
  researchEvidenceSchema,
  researchExportBundleRequestSchema,
  researchExportBundleSchema,
  researchManuscriptGetRequestSchema,
  researchManuscriptSaveRequestSchema,
  researchManuscriptSchema
} from './schemas/research-evidence';
import {
  researchIdeaCanvasGetRequestSchema,
  researchIdeaCanvasHistoryRequestSchema,
  researchIdeaCanvasSaveRequestSchema,
  researchIdeaCanvasSchema,
  researchIdeaPromoteRequestSchema,
  researchIdeaPromotionSchema
} from './schemas/research-ideas';

export type IpcInputTransform =
  | { readonly kind: 'none' }
  | { readonly kind: 'first' }
  | { readonly kind: 'optional-first' }
  | { readonly kind: 'id'; readonly key: 'id' | 'runId' };

type IpcArgsSchema = z.ZodType<unknown[]>;

export type IpcMethodContract<
  TArgsSchema extends IpcArgsSchema = IpcArgsSchema,
  TResultSchema extends z.ZodType = z.ZodType
> = {
  readonly args: TArgsSchema;
  readonly result: TResultSchema;
};

export type IpcEventContract<TPayloadSchema extends z.ZodType = z.ZodType> = {
  readonly payload: TPayloadSchema;
};

type IpcRequestMetadata = {
  readonly key: string;
  readonly channel: `roc:${string}`;
  readonly domain: string;
  readonly method: string;
  readonly contract: IpcMethodContract;
} & (
  | { readonly kind: 'direct' }
  | {
      readonly kind: 'plugin';
      readonly capabilityName: string;
      readonly inputTransform: IpcInputTransform;
    }
);

type IpcEventMetadata = {
  readonly key: string;
  readonly channel: `roc:${string}`;
  readonly domain: string;
  readonly method: string;
  readonly contract: IpcEventContract;
};

function methodContract<TArgsSchema extends IpcArgsSchema, TResultSchema extends z.ZodType>(
  args: TArgsSchema,
  result: TResultSchema
): IpcMethodContract<TArgsSchema, TResultSchema> {
  return { args, result };
}

function eventContract<TPayloadSchema extends z.ZodType>(
  payload: TPayloadSchema
): IpcEventContract<TPayloadSchema> {
  return { payload };
}

function request<const TDefinition extends IpcRequestMetadata>(definition: TDefinition): TDefinition {
  return definition;
}

function event<const TDefinition extends IpcEventMetadata>(definition: TDefinition): TDefinition {
  return definition;
}

const none = { kind: 'none' } as const;
const first = { kind: 'first' } as const;
const optionalFirst = { kind: 'optional-first' } as const;
const id = (key: 'id' | 'runId') => ({ kind: 'id', key }) as const;
const noArgs = z.tuple([]);
const oneArg = <TSchema extends z.ZodType>(schema: TSchema) => z.tuple([schema]);
const optionalArg = <TSchema extends z.ZodType>(schema: TSchema) => z.tuple([schema.optional()]);
const stringArg = oneArg(z.string());
/**
 * 一个原生菜单 / 托盘 / 全局热键能请壳打开的页面。
 *
 * 收窄成 `src/shared/surfaces.ts` 的 `menuPages` 而不是 `z.string()`：这个通道存在的目的是传给
 * `app.onNavigate` 并由渲染层兑现，所以一个"发得出、认不出"的 page 应当在入口就被契约拒掉，
 * 而不是变成一事件被渲染层默默丢弃。
 */
const menuPageArg = oneArg(z.enum(menuPages));

export const ipcRegistry = {
  version: 2,
  requests: [
    request({ key: 'appGetStatus', channel: 'roc:app:get-status', domain: 'app', method: 'getStatus', kind: 'plugin', capabilityName: 'app.status.get', inputTransform: none, contract: methodContract(noArgs, appStatusSchema) }),
    request({ key: 'appOpenSettings', channel: 'roc:app:open-settings', domain: 'app', method: 'openSettings', kind: 'direct', contract: methodContract(noArgs, openedResultSchema) }),
    request({ key: 'appOpenMainPage', channel: 'roc:app:open-main-page', domain: 'app', method: 'openMainPage', kind: 'direct', contract: methodContract(menuPageArg, openedPageResultSchema) }),
    request({ key: 'windowGetState', channel: 'roc:window:get-state', domain: 'window', method: 'getState', kind: 'direct', contract: methodContract(noArgs, windowStateSnapshotSchema) }),
    request({ key: 'windowGetBounds', channel: 'roc:window:get-bounds', domain: 'window', method: 'getBounds', kind: 'direct', contract: methodContract(noArgs, windowBoundsSnapshotSchema) }),
    request({ key: 'windowMinimize', channel: 'roc:window:minimize', domain: 'window', method: 'minimize', kind: 'direct', contract: methodContract(noArgs, windowStateSnapshotSchema) }),
    request({ key: 'windowToggleMaximize', channel: 'roc:window:toggle-maximize', domain: 'window', method: 'toggleMaximize', kind: 'direct', contract: methodContract(noArgs, windowStateSnapshotSchema) }),
    request({ key: 'windowClose', channel: 'roc:window:close', domain: 'window', method: 'close', kind: 'direct', contract: methodContract(noArgs, closedResultSchema) }),
    request({ key: 'tasksGetSnapshot', channel: 'roc:tasks:get-snapshot', domain: 'tasks', method: 'getSnapshot', kind: 'plugin', capabilityName: 'task.snapshot.get', inputTransform: none, contract: methodContract(noArgs, taskSnapshotSchema) }),
    request({ key: 'tasksGetThreadMessages', channel: 'roc:tasks:get-thread-messages', domain: 'tasks', method: 'getThreadMessages', kind: 'plugin', capabilityName: 'task.thread.messages.list', inputTransform: first, contract: methodContract(oneArg(taskMessageHistoryRequestSchema), taskMessageHistoryPageSchema) }),
    request({ key: 'tasksListBackgroundTasks', channel: 'roc:tasks:list-background-tasks', domain: 'tasks', method: 'listBackgroundTasks', kind: 'plugin', capabilityName: 'task.background.list', inputTransform: none, contract: methodContract(noArgs, backgroundTaskSchema.array()) }),
    request({ key: 'tasksDeleteThread', channel: 'roc:tasks:delete-thread', domain: 'tasks', method: 'deleteThread', kind: 'plugin', capabilityName: 'task.thread.delete', inputTransform: first, contract: methodContract(oneArg(taskDeleteThreadRequestSchema), taskDeleteThreadResultSchema) }),
    request({ key: 'tasksCreateBackgroundPreview', channel: 'roc:tasks:create-background-preview', domain: 'tasks', method: 'createBackgroundTaskPreview', kind: 'plugin', capabilityName: 'task.background.preview', inputTransform: first, contract: methodContract(oneArg(backgroundTaskPreviewRequestSchema), backgroundTaskPreviewSchema) }),
    request({ key: 'tasksCreateBackgroundTask', channel: 'roc:tasks:create-background-task', domain: 'tasks', method: 'createBackgroundTask', kind: 'plugin', capabilityName: 'task.background.create', inputTransform: first, contract: methodContract(oneArg(backgroundTaskPreviewRequestSchema), backgroundTaskSchema) }),
    request({ key: 'tasksPauseBackgroundTask', channel: 'roc:tasks:pause-background-task', domain: 'tasks', method: 'pauseBackgroundTask', kind: 'plugin', capabilityName: 'task.background.pause', inputTransform: id('id'), contract: methodContract(stringArg, backgroundTaskSchema) }),
    request({ key: 'tasksResumeBackgroundTask', channel: 'roc:tasks:resume-background-task', domain: 'tasks', method: 'resumeBackgroundTask', kind: 'plugin', capabilityName: 'task.background.resume', inputTransform: id('id'), contract: methodContract(stringArg, backgroundTaskSchema) }),
    request({ key: 'tasksCancelBackgroundTask', channel: 'roc:tasks:cancel-background-task', domain: 'tasks', method: 'cancelBackgroundTask', kind: 'plugin', capabilityName: 'task.background.cancel', inputTransform: id('id'), contract: methodContract(stringArg, backgroundTaskSchema) }),
    request({ key: 'tasksGetActiveTasks', channel: 'roc:tasks:get-active-tasks', domain: 'tasks', method: 'getActiveTasks', kind: 'plugin', capabilityName: 'task.active.list', inputTransform: none, contract: methodContract(noArgs, activeTaskItemSchema.array()) }),
    request({ key: 'tasksGetTaskDetail', channel: 'roc:tasks:get-task-detail', domain: 'tasks', method: 'getTaskDetail', kind: 'plugin', capabilityName: 'task.detail.get', inputTransform: first, contract: methodContract(oneArg(taskIdRequestSchema), taskDetailSchema) }),
    request({ key: 'tasksListScheduledRuns', channel: 'roc:tasks:list-scheduled-runs', domain: 'tasks', method: 'listScheduledRuns', kind: 'plugin', capabilityName: 'task.scheduledRuns.list', inputTransform: first, contract: methodContract(oneArg(scheduledTaskRunsRequestSchema), scheduledTaskRunSchema.array()) }),
    request({ key: 'tasksRunBackgroundNow', channel: 'roc:tasks:run-background-now', domain: 'tasks', method: 'runBackgroundNow', kind: 'plugin', capabilityName: 'task.background.runNow', inputTransform: id('id'), contract: methodContract(stringArg, taskRunNowResultSchema) }),
    request({ key: 'tasksDeleteBackgroundTask', channel: 'roc:tasks:delete-background-task', domain: 'tasks', method: 'deleteBackgroundTask', kind: 'plugin', capabilityName: 'task.background.delete', inputTransform: id('id'), contract: methodContract(stringArg, taskDeleteBackgroundResultSchema) }),
    request({ key: 'tasksUpdateBackgroundTask', channel: 'roc:tasks:update-background-task', domain: 'tasks', method: 'updateBackgroundTask', kind: 'plugin', capabilityName: 'task.background.update', inputTransform: first, contract: methodContract(oneArg(updateBackgroundTaskRequestSchema), backgroundTaskSchema) }),
    request({ key: 'tasksGetSchedulerStatus', channel: 'roc:tasks:get-scheduler-status', domain: 'tasks', method: 'getSchedulerStatus', kind: 'plugin', capabilityName: 'task.scheduler.status', inputTransform: none, contract: methodContract(noArgs, schedulerStatusSchema) }),
    request({ key: 'lifecycleGetTraySummary', channel: 'roc:lifecycle:get-tray-summary', domain: 'lifecycle', method: 'getTraySummary', kind: 'plugin', capabilityName: 'lifecycle.getTraySummary', inputTransform: none, contract: methodContract(noArgs, traySummarySchema) }),
    request({ key: 'lifecyclePauseBackground', channel: 'roc:lifecycle:pause-background', domain: 'lifecycle', method: 'pauseBackgroundExecution', kind: 'plugin', capabilityName: 'lifecycle.pauseBackgroundExecution', inputTransform: none, contract: methodContract(noArgs, traySummarySchema) }),
    request({ key: 'lifecycleResumeBackground', channel: 'roc:lifecycle:resume-background', domain: 'lifecycle', method: 'resumeBackgroundExecution', kind: 'plugin', capabilityName: 'lifecycle.resumeBackgroundExecution', inputTransform: none, contract: methodContract(noArgs, traySummarySchema) }),
    request({ key: 'diagnosticsSamplePerformance', channel: 'roc:diagnostics:sample-performance', domain: 'diagnostics', method: 'samplePerformance', kind: 'plugin', capabilityName: 'diagnostics.samplePerformance', inputTransform: first, contract: methodContract(oneArg(performanceSampleRequestSchema), performanceSampleSchema) }),
    request({ key: 'diagnosticsCreatePackage', channel: 'roc:diagnostics:create-package', domain: 'diagnostics', method: 'createDiagnosticPackage', kind: 'plugin', capabilityName: 'diagnostics.createPackage', inputTransform: first, contract: methodContract(oneArg(diagnosticPackageRequestSchema), diagnosticPackageSchema) }),
    request({ key: 'diagnosticsRunChecks', channel: 'roc:diagnostics:run-checks', domain: 'diagnostics', method: 'runChecks', kind: 'plugin', capabilityName: 'diagnostics.runChecks', inputTransform: none, contract: methodContract(noArgs, diagnosticCheckSchema.array()) }),
    request({ key: 'diagnosticsGetMetricsSnapshot', channel: 'roc:diagnostics:get-metrics-snapshot', domain: 'diagnostics', method: 'getMetricsSnapshot', kind: 'plugin', capabilityName: 'diagnostics.getMetricsSnapshot', inputTransform: optionalFirst, contract: methodContract(optionalArg(metricFilterSchema), metricsSnapshotSchema) }),
    request({ key: 'diagnosticsRunHealthCheck', channel: 'roc:diagnostics:health-check', domain: 'diagnostics', method: 'runHealthCheck', kind: 'plugin', capabilityName: 'diagnostics.runHealthCheck', inputTransform: none, contract: methodContract(noArgs, healthCheckResultSchema) }),
    request({ key: 'memoryStatus', channel: 'roc:memory:status', domain: 'memory', method: 'status', kind: 'plugin', capabilityName: 'memory.status.get', inputTransform: none, contract: methodContract(noArgs, memoryStatusSchema) }),
    request({ key: 'memoryReadFile', channel: 'roc:memory:read-file', domain: 'memory', method: 'readFile', kind: 'plugin', capabilityName: 'memory.file.read', inputTransform: first, contract: methodContract(oneArg(memoryFileReadRequestSchema), z.string().nullable()) }),
    request({ key: 'memoryWriteFile', channel: 'roc:memory:write-file', domain: 'memory', method: 'writeFile', kind: 'plugin', capabilityName: 'memory.file.write', inputTransform: first, contract: methodContract(oneArg(memoryFileWriteRequestSchema), memoryFileWriteOutcomeSchema) }),
    request({ key: 'memorySnapshotPreview', channel: 'roc:memory:snapshot-preview', domain: 'memory', method: 'snapshotPreview', kind: 'plugin', capabilityName: 'memory.snapshot.preview', inputTransform: none, contract: methodContract(noArgs, memorySnapshotPreviewSchema) }),
    request({ key: 'sessionMessagesList', channel: 'roc:session:messages-list', domain: 'sessions', method: 'list', kind: 'plugin', capabilityName: 'agent.sessions.list', inputTransform: first, contract: methodContract(oneArg(sessionListInputSchema), sessionMessageSchema.array()) }),
    request({ key: 'sessionMessagesSearch', channel: 'roc:session:messages-search', domain: 'sessions', method: 'search', kind: 'plugin', capabilityName: 'agent.sessions.search', inputTransform: first, contract: methodContract(oneArg(sessionMessageSearchRequestSchema), sessionMessageSearchResultSchema) }),
    request({ key: 'settingsGet', channel: 'roc:settings:get', domain: 'settings', method: 'get', kind: 'direct', contract: methodContract(noArgs, settingsSnapshotSchema) }),
    request({ key: 'settingsSave', channel: 'roc:settings:save', domain: 'settings', method: 'save', kind: 'direct', contract: methodContract(oneArg(settingsSaveRequestSchema), settingsSnapshotSchema) }),
    request({ key: 'settingsTestProvider', channel: 'roc:settings:test-provider', domain: 'settings', method: 'testProvider', kind: 'direct', contract: methodContract(oneArg(providerTestRequestSchema), providerTestResultSchema) }),
    request({ key: 'settingsSetProviderSecret', channel: 'roc:settings:set-provider-secret', domain: 'settings', method: 'setProviderSecret', kind: 'direct', contract: methodContract(oneArg(providerSecretSetRequestSchema), providerSecretSetResultSchema) }),
    request({ key: 'settingsClearProviderSecret', channel: 'roc:settings:clear-provider-secret', domain: 'settings', method: 'clearProviderSecret', kind: 'direct', contract: methodContract(stringArg, providerSecretClearResultSchema) }),
    request({ key: 'settingsHooksGet', channel: 'roc:settings:hooks:get', domain: 'settings', method: 'getHooks', kind: 'direct', contract: methodContract(noArgs, rocHookConfigSnapshotSchema) }),
    request({ key: 'settingsHooksSave', channel: 'roc:settings:hooks:save', domain: 'settings', method: 'saveHooks', kind: 'direct', contract: methodContract(oneArg(settingsSaveHookConfigRequestSchema), rocHookConfigSnapshotSchema) }),
    request({ key: 'settingsHooksTrust', channel: 'roc:settings:hooks:trust', domain: 'settings', method: 'trustHook', kind: 'direct', contract: methodContract(oneArg(settingsTrustHookRequestSchema), rocHookConfigSnapshotSchema) }),
    request({ key: 'mcpListServers', channel: 'roc:mcp:list-servers', domain: 'mcp', method: 'listServers', kind: 'plugin', capabilityName: 'mcp.listServers', inputTransform: none, contract: methodContract(noArgs, mcpServerSnapshotSchema.array()) }),
    request({ key: 'mcpEnsureExaPreset', channel: 'roc:mcp:ensure-exa-preset', domain: 'mcp', method: 'ensureExaPreset', kind: 'plugin', capabilityName: 'mcp.ensureExaPreset', inputTransform: none, contract: methodContract(noArgs, mcpServerConfigSchema) }),
    request({ key: 'mcpUpsertServer', channel: 'roc:mcp:upsert-server', domain: 'mcp', method: 'upsertServer', kind: 'plugin', capabilityName: 'mcp.upsertServer', inputTransform: first, contract: methodContract(oneArg(mcpServerConfigSchema), mcpServerConfigSchema) }),
    request({ key: 'mcpSetServerEnabled', channel: 'roc:mcp:set-server-enabled', domain: 'mcp', method: 'setServerEnabled', kind: 'plugin', capabilityName: 'mcp.setServerEnabled', inputTransform: first, contract: methodContract(oneArg(mcpServerEnabledRequestSchema), mcpServerConfigSchema) }),
    request({ key: 'mcpDeleteServer', channel: 'roc:mcp:delete-server', domain: 'mcp', method: 'deleteServer', kind: 'plugin', capabilityName: 'mcp.deleteServer', inputTransform: id('id'), contract: methodContract(stringArg, deletedResultSchema) }),
    request({ key: 'mcpTestServer', channel: 'roc:mcp:test-server', domain: 'mcp', method: 'testServer', kind: 'plugin', capabilityName: 'mcp.testServer', inputTransform: id('id'), contract: methodContract(stringArg, mcpServerTestResultSchema) }),
    request({ key: 'mcpGetConfig', channel: 'roc:mcp:get-config', domain: 'mcp', method: 'getConfig', kind: 'plugin', capabilityName: 'mcp.getConfig', inputTransform: none, contract: methodContract(noArgs, mcpServersConfigSchema) }),
    request({ key: 'mcpSetApprovalMode', channel: 'roc:mcp:set-approval-mode', domain: 'mcp', method: 'setApprovalMode', kind: 'plugin', capabilityName: 'mcp.setApprovalMode', inputTransform: first, contract: methodContract(oneArg(mcpApprovalModeRequestSchema), mcpServersConfigSchema) }),
    request({ key: 'skillsList', channel: 'roc:skills:list', domain: 'skills', method: 'list', kind: 'plugin', capabilityName: 'skills.list', inputTransform: none, contract: methodContract(noArgs, skillSnapshotSchema.array()) }),
    request({ key: 'skillsImport', channel: 'roc:skills:import', domain: 'skills', method: 'importSkill', kind: 'plugin', capabilityName: 'skills.import', inputTransform: first, contract: methodContract(oneArg(skillImportRequestSchema), skillSnapshotSchema) }),
    request({ key: 'skillsSetEnabled', channel: 'roc:skills:set-enabled', domain: 'skills', method: 'setEnabled', kind: 'plugin', capabilityName: 'skills.setEnabled', inputTransform: first, contract: methodContract(oneArg(skillEnabledRequestSchema), skillSnapshotSchema) }),
    request({ key: 'skillsDelete', channel: 'roc:skills:delete', domain: 'skills', method: 'deleteSkill', kind: 'plugin', capabilityName: 'skills.delete', inputTransform: id('id'), contract: methodContract(stringArg, deletedResultSchema) }),
    request({ key: 'skillsListFiles', channel: 'roc:skills:list-files', domain: 'skills', method: 'listFiles', kind: 'plugin', capabilityName: 'skills.files.list', inputTransform: first, contract: methodContract(oneArg(skillFileTreeRequestSchema), skillFileTreeResultSchema) }),
    request({ key: 'skillsReadFile', channel: 'roc:skills:read-file', domain: 'skills', method: 'readFile', kind: 'plugin', capabilityName: 'skills.file.read', inputTransform: first, contract: methodContract(oneArg(skillFilePreviewRequestSchema), skillFilePreviewResultSchema) }),
    request({ key: 'skillsBuiltinStatus', channel: 'roc:skills:builtin-status', domain: 'skills', method: 'builtinStatus', kind: 'plugin', capabilityName: 'skills.builtin.status', inputTransform: none, contract: methodContract(noArgs, builtinSkillsStatusSchema) }),
    request({ key: 'skillsBuiltinCheck', channel: 'roc:skills:builtin-check', domain: 'skills', method: 'builtinCheck', kind: 'plugin', capabilityName: 'skills.builtin.check', inputTransform: first, contract: methodContract(oneArg(builtinSkillsCheckRequestSchema), builtinSkillsCheckResultSchema) }),
    request({ key: 'skillsBuiltinAutoUpdate', channel: 'roc:skills:builtin-auto-update', domain: 'skills', method: 'builtinAutoUpdate', kind: 'plugin', capabilityName: 'skills.builtin.autoUpdate', inputTransform: first, contract: methodContract(oneArg(builtinSkillsAutoUpdateRequestSchema), builtinSkillsStatusSchema) }),
    request({ key: 'skillsBuiltinRestore', channel: 'roc:skills:builtin-restore', domain: 'skills', method: 'builtinRestore', kind: 'plugin', capabilityName: 'skills.builtin.restore', inputTransform: first, contract: methodContract(oneArg(z.object({ sourceId: z.string().min(1) }).strict()), builtinSkillsStatusSchema) }),
    request({ key: 'researchProjectsList', channel: 'roc:research:projects-list', domain: 'research', method: 'listProjects', kind: 'plugin', capabilityName: 'research.projects.list', inputTransform: none, contract: methodContract(noArgs, researchProjectSchema.array()) }),
    request({ key: 'researchProjectsGet', channel: 'roc:research:projects-get', domain: 'research', method: 'getProject', kind: 'plugin', capabilityName: 'research.projects.get', inputTransform: first, contract: methodContract(oneArg(researchProjectIdRequestSchema), researchProjectSchema) }),
    request({ key: 'researchProjectsCreate', channel: 'roc:research:projects-create', domain: 'research', method: 'createProject', kind: 'plugin', capabilityName: 'research.projects.create', inputTransform: first, contract: methodContract(oneArg(researchProjectCreateRequestSchema), researchProjectSchema) }),
    request({ key: 'researchProjectsUpdate', channel: 'roc:research:projects-update', domain: 'research', method: 'updateProject', kind: 'plugin', capabilityName: 'research.projects.update', inputTransform: first, contract: methodContract(oneArg(researchProjectUpdateRequestSchema), researchProjectSchema) }),
    request({ key: 'researchProjectsDelete', channel: 'roc:research:projects-delete', domain: 'research', method: 'deleteProject', kind: 'plugin', capabilityName: 'research.projects.delete', inputTransform: first, contract: methodContract(oneArg(researchProjectIdRequestSchema), deletedResultSchema.extend({ id: z.string() }).strict()) }),
    request({ key: 'researchWorkflowGet', channel: 'roc:research:workflow-get', domain: 'research', method: 'getWorkflow', kind: 'plugin', capabilityName: 'research.workflow.get', inputTransform: first, contract: methodContract(oneArg(researchProjectIdRequestSchema), researchWorkflowSnapshotSchema) }),
    request({ key: 'researchWorkflowTransition', channel: 'roc:research:workflow-transition', domain: 'research', method: 'transitionWorkflow', kind: 'plugin', capabilityName: 'research.workflow.transition', inputTransform: first, contract: methodContract(oneArg(researchWorkflowTransitionRequestSchema), researchWorkflowSnapshotSchema) }),
    request({ key: 'researchWorkflowEvents', channel: 'roc:research:workflow-events', domain: 'research', method: 'listWorkflowEvents', kind: 'plugin', capabilityName: 'research.workflow.events', inputTransform: first, contract: methodContract(oneArg(researchWorkflowEventsRequestSchema), researchWorkflowEventSchema.array()) }),
    request({ key: 'researchWorkflowPolicies', channel: 'roc:research:workflow-policies', domain: 'research', method: 'listStagePolicies', kind: 'plugin', capabilityName: 'research.workflow.policies', inputTransform: first, contract: methodContract(oneArg(researchStagePoliciesRequestSchema), researchStagePolicySchema.array()) }),
    request({ key: 'researchWorkflowReviewCycle', channel: 'roc:research:workflow-review-cycle', domain: 'research', method: 'getReviewCycle', kind: 'plugin', capabilityName: 'research.workflow.reviewCycle', inputTransform: first, contract: methodContract(oneArg(researchStagePoliciesRequestSchema), researchReviewCycleSchema.nullable()) }),
    request({ key: 'researchWorkflowSavePolicy', channel: 'roc:research:workflow-save-policy', domain: 'research', method: 'saveStagePolicy', kind: 'plugin', capabilityName: 'research.workflow.savePolicy', inputTransform: first, contract: methodContract(oneArg(researchStagePolicySchema), researchStagePolicySchema) }),
    request({ key: 'researchWorkflowStartRun', channel: 'roc:research:workflow-start-run', domain: 'research', method: 'startStageRun', kind: 'plugin', capabilityName: 'research.workflow.startRun', inputTransform: first, contract: methodContract(oneArg(researchStageRunStartRequestSchema), researchStageRunSchema) }),
    request({ key: 'researchWorkflowGetRun', channel: 'roc:research:workflow-get-run', domain: 'research', method: 'getStageRun', kind: 'plugin', capabilityName: 'research.workflow.getRun', inputTransform: first, contract: methodContract(oneArg(researchStageRunIdRequestSchema), researchStageRunSchema) }),
    request({ key: 'researchWorkflowListRuns', channel: 'roc:research:workflow-list-runs', domain: 'research', method: 'listStageRuns', kind: 'plugin', capabilityName: 'research.workflow.listRuns', inputTransform: first, contract: methodContract(oneArg(researchStageRunsRequestSchema), researchStageRunSchema.array()) }),
    request({ key: 'researchWorkflowCancelRun', channel: 'roc:research:workflow-cancel-run', domain: 'research', method: 'cancelStageRun', kind: 'plugin', capabilityName: 'research.workflow.cancelRun', inputTransform: first, contract: methodContract(oneArg(researchStageRunIdRequestSchema), researchStageRunSchema) }),
    request({ key: 'researchWorkflowRetryRun', channel: 'roc:research:workflow-retry-run', domain: 'research', method: 'retryStageRun', kind: 'plugin', capabilityName: 'research.workflow.retryRun', inputTransform: first, contract: methodContract(oneArg(researchStageRunRetryRequestSchema), researchStageRunSchema) }),
    request({ key: 'researchArtifactContent', channel: 'roc:research:artifact-content', domain: 'research', method: 'getArtifactContent', kind: 'plugin', capabilityName: 'research.artifacts.content', inputTransform: first, contract: methodContract(oneArg(researchArtifactContentRequestSchema), researchArtifactContentSchema.nullable()) }),
    request({ key: 'researchProductionInputInspect', channel: 'roc:research:production-input-inspect', domain: 'research', method: 'inspectProductionInput', kind: 'plugin', capabilityName: 'research.artifacts.inspectProduction', inputTransform: first, contract: methodContract(oneArg(researchProductionInputRequestSchema), researchProductionInputSchema) }),
    request({ key: 'researchProductionInputRead', channel: 'roc:research:production-input-read', domain: 'research', method: 'readProductionInputFile', kind: 'plugin', capabilityName: 'research.artifacts.readProductionFile', inputTransform: first, contract: methodContract(oneArg(researchProductionInputReadSchema), researchProductionInputContentSchema) }),
    request({ key: 'researchArtifactsCreate', channel: 'roc:research:artifacts-create', domain: 'research', method: 'createArtifact', kind: 'plugin', capabilityName: 'research.artifacts.create', inputTransform: first, contract: methodContract(oneArg(researchArtifactCreateRequestSchema), researchArtifactSchema) }),
    request({ key: 'researchArtifactsGet', channel: 'roc:research:artifacts-get', domain: 'research', method: 'getArtifact', kind: 'plugin', capabilityName: 'research.artifacts.get', inputTransform: first, contract: methodContract(oneArg(researchArtifactIdRequestSchema), researchArtifactSchema) }),
    request({ key: 'researchArtifactsList', channel: 'roc:research:artifacts-list', domain: 'research', method: 'listArtifacts', kind: 'plugin', capabilityName: 'research.artifacts.list', inputTransform: first, contract: methodContract(oneArg(researchArtifactListRequestSchema), researchArtifactSchema.array()) }),
    request({ key: 'researchArtifactsUpdate', channel: 'roc:research:artifacts-update', domain: 'research', method: 'updateArtifact', kind: 'plugin', capabilityName: 'research.artifacts.update', inputTransform: first, contract: methodContract(oneArg(researchArtifactUpdateRequestSchema), researchArtifactSchema) }),
    request({ key: 'researchEvidenceCapture', channel: 'roc:research:evidence-capture', domain: 'research', method: 'captureEvidence', kind: 'plugin', capabilityName: 'research.evidence.capture', inputTransform: first, contract: methodContract(oneArg(researchEvidenceCaptureRequestSchema), researchEvidenceSchema) }),
    request({ key: 'researchEvidenceList', channel: 'roc:research:evidence-list', domain: 'research', method: 'listEvidence', kind: 'plugin', capabilityName: 'research.evidence.list', inputTransform: first, contract: methodContract(oneArg(researchEvidenceListRequestSchema), researchEvidenceSchema.array()) }),
    request({ key: 'researchClaimsCreate', channel: 'roc:research:claims-create', domain: 'research', method: 'createClaim', kind: 'plugin', capabilityName: 'research.claims.create', inputTransform: first, contract: methodContract(oneArg(researchClaimCreateRequestSchema), researchClaimSchema) }),
    request({ key: 'researchClaimsUpdate', channel: 'roc:research:claims-update', domain: 'research', method: 'updateClaim', kind: 'plugin', capabilityName: 'research.claims.update', inputTransform: first, contract: methodContract(oneArg(researchClaimUpdateRequestSchema), researchClaimSchema) }),
    request({ key: 'researchClaimsList', channel: 'roc:research:claims-list', domain: 'research', method: 'listClaims', kind: 'plugin', capabilityName: 'research.claims.list', inputTransform: first, contract: methodContract(oneArg(researchClaimListRequestSchema), researchClaimSchema.array()) }),
    request({ key: 'researchClaimsHistory', channel: 'roc:research:claims-history', domain: 'research', method: 'getClaimHistory', kind: 'plugin', capabilityName: 'research.claims.history', inputTransform: first, contract: methodContract(oneArg(researchClaimHistoryRequestSchema), researchClaimSchema.array()) }),
    request({ key: 'researchManuscriptSave', channel: 'roc:research:manuscript-save', domain: 'research', method: 'saveManuscript', kind: 'plugin', capabilityName: 'research.manuscript.save', inputTransform: first, contract: methodContract(oneArg(researchManuscriptSaveRequestSchema), researchManuscriptSchema) }),
    request({ key: 'researchManuscriptGet', channel: 'roc:research:manuscript-get', domain: 'research', method: 'getManuscript', kind: 'plugin', capabilityName: 'research.manuscript.get', inputTransform: first, contract: methodContract(oneArg(researchManuscriptGetRequestSchema), researchManuscriptSchema.nullable()) }),
    request({ key: 'researchManuscriptExportBundle', channel: 'roc:research:manuscript-export-bundle', domain: 'research', method: 'getExportBundle', kind: 'plugin', capabilityName: 'research.manuscript.exportBundle', inputTransform: first, contract: methodContract(oneArg(researchExportBundleRequestSchema), researchExportBundleSchema) }),
    request({ key: 'researchIdeasSave', channel: 'roc:research:ideas-save', domain: 'research', method: 'saveIdeaCanvas', kind: 'plugin', capabilityName: 'research.ideas.save', inputTransform: first, contract: methodContract(oneArg(researchIdeaCanvasSaveRequestSchema), researchIdeaCanvasSchema) }),
    request({ key: 'researchIdeasGet', channel: 'roc:research:ideas-get', domain: 'research', method: 'getIdeaCanvas', kind: 'plugin', capabilityName: 'research.ideas.get', inputTransform: first, contract: methodContract(oneArg(researchIdeaCanvasGetRequestSchema), researchIdeaCanvasSchema.nullable()) }),
    request({ key: 'researchIdeasHistory', channel: 'roc:research:ideas-history', domain: 'research', method: 'getIdeaCanvasHistory', kind: 'plugin', capabilityName: 'research.ideas.history', inputTransform: first, contract: methodContract(oneArg(researchIdeaCanvasHistoryRequestSchema), researchIdeaCanvasSchema.array()) }),
    request({ key: 'researchIdeasPromote', channel: 'roc:research:ideas-promote', domain: 'research', method: 'promoteIdeaCanvas', kind: 'plugin', capabilityName: 'research.ideas.promote', inputTransform: first, contract: methodContract(oneArg(researchIdeaPromoteRequestSchema), researchIdeaPromotionSchema) }),
    request({ key: 'researchLiteratureSearch', channel: 'roc:research:literature-search', domain: 'research', method: 'searchLiterature', kind: 'plugin', capabilityName: 'research.literature.search', inputTransform: first, contract: methodContract(oneArg(researchLiteratureSearchRequestSchema), researchLiteratureSchema.array()) }),
    request({ key: 'researchEmbeddingList', channel: 'roc:research:embedding-list', domain: 'research', method: 'listEmbeddingConfigs', kind: 'plugin', capabilityName: 'research.embedding.list', inputTransform: none, contract: methodContract(noArgs, researchEmbeddingConfigSchema.array()) }),
    request({ key: 'researchEmbeddingSave', channel: 'roc:research:embedding-save', domain: 'research', method: 'saveEmbeddingConfig', kind: 'plugin', capabilityName: 'research.embedding.save', inputTransform: first, contract: methodContract(oneArg(researchEmbeddingConfigSaveRequestSchema), researchEmbeddingConfigSchema) }),
    request({ key: 'researchKnowledgeUpsert', channel: 'roc:research:knowledge-upsert', domain: 'research', method: 'upsertKnowledgeDocument', kind: 'plugin', capabilityName: 'research.knowledge.upsert', inputTransform: first, contract: methodContract(oneArg(researchKnowledgeDocumentUpsertRequestSchema), researchKnowledgeDocumentSchema) }),
    request({ key: 'researchKnowledgeSearch', channel: 'roc:research:knowledge-search', domain: 'research', method: 'searchKnowledge', kind: 'plugin', capabilityName: 'research.knowledge.search', inputTransform: first, contract: methodContract(oneArg(researchKnowledgeSearchRequestSchema), researchKnowledgeSearchResultSchema) }),
    request({ key: 'researchWorkflowRole', channel: 'roc:research:workflow-role', domain: 'research', method: 'getRoleProfile', kind: 'plugin', capabilityName: 'research.workflow.role', inputTransform: first, contract: methodContract(oneArg(researchStageRoleRequestSchema), researchStageRoleProfileSchema) }),
    request({ key: 'researchExperimentEnvironment', channel: 'roc:research:experiment-environment', domain: 'research', method: 'inspectExperimentEnvironment', kind: 'plugin', capabilityName: 'research.experiment.environment', inputTransform: first, contract: methodContract(oneArg(researchExperimentEnvironmentRequestSchema), researchExperimentEnvironmentSchema) }),
    request({ key: 'researchExperimentStart', channel: 'roc:research:experiment-start', domain: 'research', method: 'startExperiment', kind: 'plugin', capabilityName: 'research.experiment.start', inputTransform: first, contract: methodContract(oneArg(researchExperimentStartSchema), researchExperimentExecutionSchema) }),
    request({ key: 'researchExperimentGet', channel: 'roc:research:experiment-get', domain: 'research', method: 'getExperiment', kind: 'plugin', capabilityName: 'research.experiment.get', inputTransform: first, contract: methodContract(oneArg(researchExperimentIdRequestSchema), researchExperimentExecutionSchema) }),
    request({ key: 'researchExperimentList', channel: 'roc:research:experiment-list', domain: 'research', method: 'listExperiments', kind: 'plugin', capabilityName: 'research.experiment.list', inputTransform: first, contract: methodContract(oneArg(researchExperimentListRequestSchema), researchExperimentExecutionSchema.array()) }),
    request({ key: 'researchExperimentCancel', channel: 'roc:research:experiment-cancel', domain: 'research', method: 'cancelExperiment', kind: 'plugin', capabilityName: 'research.experiment.cancel', inputTransform: first, contract: methodContract(oneArg(researchExperimentIdRequestSchema), researchExperimentExecutionSchema) }),
    request({ key: 'researchExperimentRead', channel: 'roc:research:experiment-read', domain: 'research', method: 'readExperimentFile', kind: 'plugin', capabilityName: 'research.experiment.read', inputTransform: first, contract: methodContract(oneArg(researchExperimentFileRequestSchema), researchExperimentFileContentSchema) }),
    request({ key: 'researchExperimentPublish', channel: 'roc:research:experiment-publish', domain: 'research', method: 'publishExperiment', kind: 'plugin', capabilityName: 'research.experiment.publish', inputTransform: first, contract: methodContract(oneArg(researchExperimentIdRequestSchema), researchExperimentExecutionSchema) }),
    request({ key: 'researchExperimentEvidence', channel: 'roc:research:experiment-evidence', domain: 'research', method: 'getEvidenceExperimentSource', kind: 'plugin', capabilityName: 'research.experiment.evidenceSource', inputTransform: first, contract: methodContract(oneArg(researchExperimentEvidenceRequestSchema), researchExperimentFileRequestSchema.nullable()) }),
    request({ key: 'researchFigureEnvironment', channel: 'roc:research:figure-environment', domain: 'research', method: 'inspectFigureEnvironment', kind: 'plugin', capabilityName: 'research.figure.environment', inputTransform: first, contract: methodContract(oneArg(researchExperimentEnvironmentRequestSchema), researchExperimentEnvironmentSchema) }),
    request({ key: 'researchFigureStart', channel: 'roc:research:figure-start', domain: 'research', method: 'startFigure', kind: 'plugin', capabilityName: 'research.figure.start', inputTransform: first, contract: methodContract(oneArg(researchFigureStartSchema), researchFigureRunSchema) }),
    request({ key: 'researchFigureGetRun', channel: 'roc:research:figure-get-run', domain: 'research', method: 'getFigureRun', kind: 'plugin', capabilityName: 'research.figure.getRun', inputTransform: first, contract: methodContract(oneArg(researchExperimentIdRequestSchema), researchFigureRunSchema) }),
    request({ key: 'researchFigureListRuns', channel: 'roc:research:figure-list-runs', domain: 'research', method: 'listFigureRuns', kind: 'plugin', capabilityName: 'research.figure.listRuns', inputTransform: first, contract: methodContract(oneArg(researchFigureListRequestSchema), researchFigureRunSchema.array()) }),
    request({ key: 'researchFigureCancel', channel: 'roc:research:figure-cancel', domain: 'research', method: 'cancelFigure', kind: 'plugin', capabilityName: 'research.figure.cancel', inputTransform: first, contract: methodContract(oneArg(researchExperimentIdRequestSchema), researchFigureRunSchema) }),
    request({ key: 'researchFigureRead', channel: 'roc:research:figure-read', domain: 'research', method: 'readFigureFile', kind: 'plugin', capabilityName: 'research.figure.read', inputTransform: first, contract: methodContract(oneArg(researchExperimentFileRequestSchema), researchExperimentFileContentSchema) }),
    request({ key: 'researchFigurePublish', channel: 'roc:research:figure-publish', domain: 'research', method: 'publishFigure', kind: 'plugin', capabilityName: 'research.figure.publish', inputTransform: first, contract: methodContract(oneArg(researchFigurePublishRequestSchema), researchFigurePublicationSchema) }),
    request({ key: 'researchFigureGet', channel: 'roc:research:figure-get', domain: 'research', method: 'getFigure', kind: 'plugin', capabilityName: 'research.figure.get', inputTransform: first, contract: methodContract(oneArg(researchFigureIdRequestSchema), researchFigurePublicationSchema) }),
    request({ key: 'researchFigureList', channel: 'roc:research:figure-list', domain: 'research', method: 'listFigures', kind: 'plugin', capabilityName: 'research.figure.list', inputTransform: first, contract: methodContract(oneArg(researchFigureListRequestSchema), researchFigurePublicationSchema.array()) }),
    request({ key: 'researchExportPrepare', channel: 'roc:research:export-prepare', domain: 'research', method: 'prepareExport', kind: 'plugin', capabilityName: 'research.export.prepare', inputTransform: first, contract: methodContract(oneArg(researchExportPrepareSchema), researchExportExecutionSchema) }),
    request({ key: 'researchExportGet', channel: 'roc:research:export-get', domain: 'research', method: 'getExport', kind: 'plugin', capabilityName: 'research.export.get', inputTransform: first, contract: methodContract(oneArg(researchExportIdRequestSchema), researchExportExecutionSchema) }),
    request({ key: 'researchExportList', channel: 'roc:research:export-list', domain: 'research', method: 'listExports', kind: 'plugin', capabilityName: 'research.export.list', inputTransform: first, contract: methodContract(oneArg(researchExportListRequestSchema), researchExportExecutionSchema.array()) }),
    request({ key: 'researchExportCancel', channel: 'roc:research:export-cancel', domain: 'research', method: 'cancelExport', kind: 'plugin', capabilityName: 'research.export.cancel', inputTransform: first, contract: methodContract(oneArg(researchExportIdRequestSchema), researchExportExecutionSchema) }),
    request({ key: 'researchExportPublish', channel: 'roc:research:export-publish', domain: 'research', method: 'publishExport', kind: 'plugin', capabilityName: 'research.export.publish', inputTransform: first, contract: methodContract(oneArg(researchExportPublishRequestSchema), researchExportExecutionSchema) }),
    request({ key: 'researchExportRead', channel: 'roc:research:export-read', domain: 'research', method: 'readExportFile', kind: 'plugin', capabilityName: 'research.export.read', inputTransform: first, contract: methodContract(oneArg(researchExportReadRequestSchema), researchExportFileContentSchema) }),
    request({ key: 'researchExportWrite', channel: 'roc:research:export-write', domain: 'research', method: 'writeExport', kind: 'plugin', capabilityName: 'research.export.write', inputTransform: first, contract: methodContract(oneArg(researchExportWriteRequestSchema), researchExportDeliverySchema) }),
    request({ key: 'researchProvenanceAdd', channel: 'roc:research:provenance-add', domain: 'research', method: 'addProvenance', kind: 'plugin', capabilityName: 'research.provenance.add', inputTransform: first, contract: methodContract(oneArg(researchProvenanceCreateRequestSchema), researchProvenanceSchema) }),
    request({ key: 'researchProvenanceList', channel: 'roc:research:provenance-list', domain: 'research', method: 'listProvenance', kind: 'plugin', capabilityName: 'research.provenance.list', inputTransform: first, contract: methodContract(oneArg(researchProvenanceListRequestSchema), researchProvenanceSchema.array()) }),
    request({ key: 'researchTemplateImport', channel: 'roc:research:template-import', domain: 'research', method: 'importTemplate', kind: 'plugin', capabilityName: 'research.template.import', inputTransform: first, contract: methodContract(oneArg(researchTemplateImportRequestSchema), researchTemplateSchema) }),
    request({ key: 'researchTemplateCompile', channel: 'roc:research:template-compile', domain: 'research', method: 'compileTemplate', kind: 'plugin', capabilityName: 'research.template.compile', inputTransform: first, contract: methodContract(oneArg(researchTemplateCompileRequestSchema), researchTemplateSchema) }),
    request({ key: 'researchToolchainStatus', channel: 'roc:research:toolchain-status', domain: 'research', method: 'getToolchainStatus', kind: 'plugin', capabilityName: 'research.toolchain.status', inputTransform: none, contract: methodContract(noArgs, researchToolchainStatusSchema) }),
    request({ key: 'researchProseLint', channel: 'roc:research:prose-lint', domain: 'research', method: 'lintManuscript', kind: 'plugin', capabilityName: 'research.prose.lint', inputTransform: first, contract: methodContract(oneArg(researchProseLintRequestSchema), researchProseLintReportSchema) }),
    request({ key: 'researchModelsStatus', channel: 'roc:research:models-status', domain: 'research', method: 'getModelsStatus', kind: 'plugin', capabilityName: 'research.models.status', inputTransform: none, contract: methodContract(noArgs, researchModelsStatusSchema) }),
    request({ key: 'researchModelsDownload', channel: 'roc:research:models-download', domain: 'research', method: 'downloadModels', kind: 'plugin', capabilityName: 'research.models.download', inputTransform: none, contract: methodContract(noArgs, researchModelsStatusSchema) }),
    request({ key: 'researchTemplateGet', channel: 'roc:research:template-get', domain: 'research', method: 'getTemplate', kind: 'plugin', capabilityName: 'research.template.get', inputTransform: first, contract: methodContract(oneArg(researchTemplateCompileRequestSchema), researchTemplateSchema) }),
    request({ key: 'researchTemplateList', channel: 'roc:research:template-list', domain: 'research', method: 'listTemplates', kind: 'plugin', capabilityName: 'research.template.list', inputTransform: first, contract: methodContract(oneArg(researchTemplateListRequestSchema), researchTemplateSchema.array()) }),
    request({ key: 'researchTemplateFiles', channel: 'roc:research:template-files', domain: 'research', method: 'getTemplateFiles', kind: 'plugin', capabilityName: 'research.template.files', inputTransform: first, contract: methodContract(oneArg(researchTemplateCompileRequestSchema), researchTemplateFileSchema.array()) }),
    request({ key: 'researchTemplateReadFile', channel: 'roc:research:template-read-file', domain: 'research', method: 'readTemplateFile', kind: 'plugin', capabilityName: 'research.template.readFile', inputTransform: first, contract: methodContract(oneArg(researchTemplateFileRequestSchema), researchTemplateFileContentSchema) }),
    request({ key: 'researchTemplateSaveFile', channel: 'roc:research:template-save-file', domain: 'research', method: 'saveTemplateFile', kind: 'plugin', capabilityName: 'research.template.saveFile', inputTransform: first, contract: methodContract(oneArg(researchTemplateFileSaveRequestSchema), researchTemplateFileContentSchema) }),
    request({ key: 'researchTemplateSetEntry', channel: 'roc:research:template-set-entry', domain: 'research', method: 'setTemplateEntry', kind: 'plugin', capabilityName: 'research.template.setEntry', inputTransform: first, contract: methodContract(oneArg(researchTemplateEntryRequestSchema), researchTemplateSchema) }),
    request({ key: 'researchTemplateCancel', channel: 'roc:research:template-cancel', domain: 'research', method: 'cancelTemplateCompile', kind: 'plugin', capabilityName: 'research.template.cancel', inputTransform: first, contract: methodContract(oneArg(researchTemplateCompileRequestSchema), researchTemplateSchema) }),
    request({ key: 'researchLibraryList', channel: 'roc:research:library-list', domain: 'research', method: 'listLibrary', kind: 'plugin', capabilityName: 'research.library.list', inputTransform: first, contract: methodContract(oneArg(researchLibraryListRequestSchema), researchLibraryItemSchema.array()) }),
    request({ key: 'researchLibraryGet', channel: 'roc:research:library-get', domain: 'research', method: 'getLibraryItem', kind: 'plugin', capabilityName: 'research.library.get', inputTransform: first, contract: methodContract(oneArg(researchLibraryIdRequestSchema), researchLibraryItemSchema) }),
    request({ key: 'researchLibraryImportRecord', channel: 'roc:research:library-import-record', domain: 'research', method: 'importLibraryRecord', kind: 'plugin', capabilityName: 'research.library.importRecord', inputTransform: first, contract: methodContract(oneArg(researchLibraryRecordImportRequestSchema), researchLibraryImportResultSchema) }),
    request({ key: 'researchLibraryImportDoi', channel: 'roc:research:library-import-doi', domain: 'research', method: 'importLibraryDoi', kind: 'plugin', capabilityName: 'research.library.importDoi', inputTransform: first, contract: methodContract(oneArg(researchLibraryDoiImportRequestSchema), researchLibraryImportResultSchema) }),
    request({ key: 'researchLibraryImportFile', channel: 'roc:research:library-import-file', domain: 'research', method: 'importBibliography', kind: 'plugin', capabilityName: 'research.library.importFile', inputTransform: first, contract: methodContract(oneArg(researchLibraryFileImportRequestSchema), researchLibraryImportResultSchema) }),
    request({ key: 'researchLibraryExport', channel: 'roc:research:library-export', domain: 'research', method: 'exportBibliography', kind: 'plugin', capabilityName: 'research.library.export', inputTransform: first, contract: methodContract(oneArg(researchLibraryExportRequestSchema), researchLibraryExportSchema) }),
    request({ key: 'researchLibraryLink', channel: 'roc:research:library-link', domain: 'research', method: 'linkLibraryItem', kind: 'plugin', capabilityName: 'research.library.linkProject', inputTransform: first, contract: methodContract(oneArg(researchLibraryLinkRequestSchema), researchLibraryItemSchema) }),
    request({ key: 'researchLibraryArchive', channel: 'roc:research:library-archive', domain: 'research', method: 'archiveLibraryItem', kind: 'plugin', capabilityName: 'research.library.archive', inputTransform: first, contract: methodContract(oneArg(researchLibraryArchiveRequestSchema), researchLibraryItemSchema) }),
    request({ key: 'researchLibraryCitationKey', channel: 'roc:research:library-citation-key', domain: 'research', method: 'setLibraryCitationKey', kind: 'plugin', capabilityName: 'research.library.setCitationKey', inputTransform: first, contract: methodContract(oneArg(researchLibraryCitationKeyRequestSchema), researchLibraryItemSchema) }),
    request({ key: 'researchDocumentImport', channel: 'roc:research:document-import', domain: 'research', method: 'importDocument', kind: 'plugin', capabilityName: 'research.document.import', inputTransform: first, contract: methodContract(oneArg(researchDocumentImportRequestSchema), researchDocumentSchema) }),
    request({ key: 'researchDocumentList', channel: 'roc:research:document-list', domain: 'research', method: 'listDocuments', kind: 'plugin', capabilityName: 'research.document.list', inputTransform: first, contract: methodContract(oneArg(researchDocumentListRequestSchema), researchDocumentSchema.array()) }),
    request({ key: 'researchDocumentGet', channel: 'roc:research:document-get', domain: 'research', method: 'getDocument', kind: 'plugin', capabilityName: 'research.document.get', inputTransform: first, contract: methodContract(oneArg(researchDocumentIdRequestSchema), researchDocumentSchema) }),
    request({ key: 'researchDocumentParse', channel: 'roc:research:document-parse', domain: 'research', method: 'parseDocument', kind: 'plugin', capabilityName: 'research.document.parse', inputTransform: first, contract: methodContract(oneArg(researchDocumentIdRequestSchema), researchDocumentSchema) }),
    request({ key: 'researchDocumentCancel', channel: 'roc:research:document-cancel', domain: 'research', method: 'cancelDocumentParse', kind: 'plugin', capabilityName: 'research.document.cancel', inputTransform: first, contract: methodContract(oneArg(researchDocumentParseRequestSchema), researchDocumentSchema) }),
    request({ key: 'researchDocumentRuns', channel: 'roc:research:document-runs', domain: 'research', method: 'listDocumentParses', kind: 'plugin', capabilityName: 'research.document.runs', inputTransform: first, contract: methodContract(oneArg(researchDocumentIdRequestSchema), researchDocumentRunSchema.array()) }),
    request({ key: 'researchDocumentContent', channel: 'roc:research:document-content', domain: 'research', method: 'getDocumentContent', kind: 'plugin', capabilityName: 'research.document.content', inputTransform: first, contract: methodContract(oneArg(researchDocumentParseRequestSchema), researchDocumentParseSchema) }),
    request({ key: 'researchIndexStatus', channel: 'roc:research:index-status', domain: 'research', method: 'getIndexStatus', kind: 'plugin', capabilityName: 'research.index.status', inputTransform: first, contract: methodContract(oneArg(researchIndexProjectRequestSchema), researchIndexStatusSchema) }),
    request({ key: 'researchIndexConfigure', channel: 'roc:research:index-configure', domain: 'research', method: 'saveIndexSettings', kind: 'plugin', capabilityName: 'research.index.configure', inputTransform: first, contract: methodContract(oneArg(researchIndexSettingsSaveSchema), researchIndexStatusSchema) }),
    request({ key: 'researchIndexControl', channel: 'roc:research:index-control', domain: 'research', method: 'controlIndex', kind: 'plugin', capabilityName: 'research.index.control', inputTransform: first, contract: methodContract(oneArg(researchIndexControlRequestSchema), researchIndexStatusSchema) }),
    request({ key: 'researchIndexFiles', channel: 'roc:research:index-files', domain: 'research', method: 'listIndexedFiles', kind: 'plugin', capabilityName: 'research.index.files', inputTransform: first, contract: methodContract(oneArg(researchIndexFilesRequestSchema), researchIndexedFileSchema.array()) }),
    request({ key: 'researchIndexJobs', channel: 'roc:research:index-jobs', domain: 'research', method: 'listIndexJobs', kind: 'plugin', capabilityName: 'research.index.jobs', inputTransform: first, contract: methodContract(oneArg(researchIndexJobsRequestSchema), researchIndexJobSchema.array()) }),
    request({ key: 'researchIndexEvidenceSource', channel: 'roc:research:index-evidence-source', domain: 'research', method: 'getEvidenceIndexSource', kind: 'plugin', capabilityName: 'research.index.evidenceSource', inputTransform: first, contract: methodContract(oneArg(researchIndexEvidenceSourceRequestSchema), researchIndexedSourceSchema.nullable()) }),
    request({ key: 'agentGetStatus', channel: 'roc:agent:get-status', domain: 'agent', method: 'getStatus', kind: 'plugin', capabilityName: 'agent.status.get', inputTransform: none, contract: methodContract(noArgs, agentRuntimeStatusSchema) }),
    request({ key: 'agentGetConfigPreview', channel: 'roc:agent:get-config-preview', domain: 'agent', method: 'getConfigPreview', kind: 'plugin', capabilityName: 'agent.config.preview', inputTransform: none, contract: methodContract(noArgs, deepAgentConfigPreviewSchema) }),
    request({ key: 'agentGetCapabilityPreview', channel: 'roc:agent:get-capability-preview', domain: 'agent', method: 'getCapabilityPreview', kind: 'plugin', capabilityName: 'agent.capability.preview', inputTransform: first, contract: methodContract(oneArg(agentCapabilityPreviewRequestSchema), agentCapabilityPreviewSchema) }),
    request({ key: 'agentPilotStatus', channel: 'roc:agent:pilot-status', domain: 'agent', method: 'getPilotStatus', kind: 'plugin', capabilityName: 'agent.pilot.status', inputTransform: none, contract: methodContract(noArgs, pilotStatusSchema) }),
    request({ key: 'agentPilotEnable', channel: 'roc:agent:pilot-enable', domain: 'agent', method: 'enablePilot', kind: 'plugin', capabilityName: 'agent.pilot.enable', inputTransform: first, contract: methodContract(oneArg(pilotOptInRequestSchema), pilotStatusSchema) }),
    request({ key: 'agentPilotRollback', channel: 'roc:agent:pilot-rollback', domain: 'agent', method: 'rollbackPilot', kind: 'plugin', capabilityName: 'agent.pilot.rollback', inputTransform: none, contract: methodContract(noArgs, pilotStatusSchema) }),
    request({ key: 'chatStartRun', channel: 'roc:chat:start-run', domain: 'chat', method: 'startRun', kind: 'plugin', capabilityName: 'agent.run.start', inputTransform: first, contract: methodContract(oneArg(chatStartRunIpcRequestSchema), chatStartRunResultSchema) }),
    request({ key: 'chatCancelRun', channel: 'roc:chat:cancel-run', domain: 'chat', method: 'cancelRun', kind: 'plugin', capabilityName: 'agent.run.cancel', inputTransform: id('runId'), contract: methodContract(stringArg, chatCancelRunResultSchema) }),
    request({ key: 'chatCorrectRun', channel: 'roc:chat:correct-run', domain: 'chat', method: 'correctRun', kind: 'plugin', capabilityName: 'agent.run.correct', inputTransform: first, contract: methodContract(oneArg(chatCorrectRunRequestSchema), chatCorrectRunResultSchema) }),
    request({ key: 'chatResumeRun', channel: 'roc:chat:resume-run', domain: 'chat', method: 'resumeRun', kind: 'plugin', capabilityName: 'agent.run.resume', inputTransform: first, contract: methodContract(oneArg(chatResumeRunRequestSchema), chatResumeRunResultSchema) }),
    request({ key: 'chatGetRunEvents', channel: 'roc:chat:get-run-events', domain: 'chat', method: 'getRunEvents', kind: 'plugin', capabilityName: 'agent.run.events.list', inputTransform: first, contract: methodContract(oneArg(chatRunEventsReplayRequestSchema), chatRunEventsReplayResultSchema) }),
    request({ key: 'chatGetActiveRun', channel: 'roc:chat:get-active-run', domain: 'chat', method: 'getActiveRun', kind: 'plugin', capabilityName: 'agent.run.active.get', inputTransform: first, contract: methodContract(oneArg(chatActiveRunRequestSchema), activeChatRunSchema.nullable()) }),
    request({ key: 'workspaceGetCurrent', channel: 'roc:workspace:get-current', domain: 'workspace', method: 'getCurrent', kind: 'plugin', capabilityName: 'workspace.getCurrent', inputTransform: none, contract: methodContract(noArgs, workspaceSchema.nullable()) }),
    request({ key: 'workspaceSelect', channel: 'roc:workspace:select', domain: 'workspace', method: 'select', kind: 'plugin', capabilityName: 'workspace.select', inputTransform: first, contract: methodContract(oneArg(workspaceSelectRequestSchema), workspaceSchema) }),
    request({ key: 'workspaceSelectFromDialog', channel: 'roc:workspace:select-from-dialog', domain: 'workspace', method: 'selectFromDialog', kind: 'direct', contract: methodContract(noArgs, workspaceSchema.nullable()) }),
    request({ key: 'filesSelectFromDialog', channel: 'roc:files:select-from-dialog', domain: 'files', method: 'selectFromDialog', kind: 'direct', contract: methodContract(noArgs, fileDialogSelectionSchema.nullable()) }),
    request({ key: 'filesListTree', channel: 'roc:files:list-tree', domain: 'files', method: 'listTree', kind: 'plugin', capabilityName: 'files.listTree', inputTransform: first, contract: methodContract(oneArg(fileTreeRequestSchema), fileTreeResultSchema) }),
    request({ key: 'filesSearch', channel: 'roc:files:search', domain: 'files', method: 'search', kind: 'plugin', capabilityName: 'files.search', inputTransform: first, contract: methodContract(oneArg(fileSearchRequestSchema), fileSearchResultSchema) }),
    request({ key: 'filesSearchByName', channel: 'roc:files:search-by-name', domain: 'files', method: 'searchByName', kind: 'plugin', capabilityName: 'files.searchByName', inputTransform: first, contract: methodContract(oneArg(fileNameSearchRequestSchema), fileNameSearchResultSchema) }),
    request({ key: 'filesPreview', channel: 'roc:files:preview', domain: 'files', method: 'preview', kind: 'plugin', capabilityName: 'files.preview', inputTransform: first, contract: methodContract(oneArg(filePreviewRequestSchema), filePreviewResultSchema) }),
    request({ key: 'filesPreviewPdf', channel: 'roc:files:preview-pdf', domain: 'files', method: 'previewPdf', kind: 'plugin', capabilityName: 'files.previewPdf', inputTransform: first, contract: methodContract(oneArg(filePdfPreviewRequestSchema), filePdfPreviewResultSchema) }),
    request({ key: 'filesWriteText', channel: 'roc:files:write-text', domain: 'files', method: 'writeText', kind: 'plugin', capabilityName: 'files.writeText', inputTransform: first, contract: methodContract(oneArg(fileWriteTextRequestSchema), fileWriteResultSchema) }),
    request({ key: 'gitStatus', channel: 'roc:git:status', domain: 'git', method: 'status', kind: 'plugin', capabilityName: 'git.status', inputTransform: none, contract: methodContract(noArgs, gitStatusResultSchema) }),
    request({ key: 'gitDiffStat', channel: 'roc:git:diff-stat', domain: 'git', method: 'diffStat', kind: 'plugin', capabilityName: 'git.diffStat', inputTransform: none, contract: methodContract(noArgs, gitDiffStatResultSchema) }),
    request({ key: 'gitFileDiff', channel: 'roc:git:file-diff', domain: 'git', method: 'fileDiff', kind: 'plugin', capabilityName: 'git.fileDiff', inputTransform: first, contract: methodContract(oneArg(gitFileOperationRequestSchema), gitFileDiffResultSchema) }),
    request({ key: 'gitStageFile', channel: 'roc:git:stage-file', domain: 'git', method: 'stageFile', kind: 'plugin', capabilityName: 'git.stageFile', inputTransform: first, contract: methodContract(oneArg(gitFileOperationRequestSchema), gitStatusResultSchema) }),
    request({ key: 'gitStageFiles', channel: 'roc:git:stage-files', domain: 'git', method: 'stageFiles', kind: 'plugin', capabilityName: 'git.stageFiles', inputTransform: first, contract: methodContract(oneArg(gitBatchFileOperationRequestSchema), gitStatusResultSchema) }),
    request({ key: 'gitUnstageFile', channel: 'roc:git:unstage-file', domain: 'git', method: 'unstageFile', kind: 'plugin', capabilityName: 'git.unstageFile', inputTransform: first, contract: methodContract(oneArg(gitFileOperationRequestSchema), gitStatusResultSchema) }),
    request({ key: 'gitDiscardFile', channel: 'roc:git:discard-file', domain: 'git', method: 'discardFile', kind: 'plugin', capabilityName: 'git.discardFile', inputTransform: first, contract: methodContract(oneArg(gitFileOperationRequestSchema), gitStatusResultSchema) }),
    request({ key: 'gitCommit', channel: 'roc:git:commit', domain: 'git', method: 'commit', kind: 'plugin', capabilityName: 'git.commit', inputTransform: first, contract: methodContract(oneArg(gitCommitRequestSchema), gitCommitResultSchema) }),
    request({ key: 'gitPush', channel: 'roc:git:push', domain: 'git', method: 'push', kind: 'plugin', capabilityName: 'git.push', inputTransform: none, contract: methodContract(noArgs, gitPushResultSchema) }),
    request({ key: 'gitListBranches', channel: 'roc:git:list-branches', domain: 'git', method: 'listBranches', kind: 'plugin', capabilityName: 'git.listBranches', inputTransform: none, contract: methodContract(noArgs, gitBranchListResultSchema) }),
    request({ key: 'gitCreateBranch', channel: 'roc:git:create-branch', domain: 'git', method: 'createBranch', kind: 'plugin', capabilityName: 'git.createBranch', inputTransform: first, contract: methodContract(oneArg(gitCreateBranchRequestSchema), gitBranchMutationResultSchema) }),
    request({ key: 'gitCheckoutBranch', channel: 'roc:git:checkout-branch', domain: 'git', method: 'checkoutBranch', kind: 'plugin', capabilityName: 'git.checkoutBranch', inputTransform: first, contract: methodContract(oneArg(gitCheckoutBranchRequestSchema), gitBranchMutationResultSchema) }),
    request({ key: 'terminalCreateSession', channel: 'roc:terminal:create-session', domain: 'terminal', method: 'createSession', kind: 'plugin', capabilityName: 'terminal.createSession', inputTransform: first, contract: methodContract(oneArg(terminalSessionCreateRequestSchema), terminalSessionSnapshotSchema) }),
    request({ key: 'terminalWriteInput', channel: 'roc:terminal:write-input', domain: 'terminal', method: 'writeInput', kind: 'plugin', capabilityName: 'terminal.writeInput', inputTransform: first, contract: methodContract(oneArg(terminalSessionInputRequestSchema), deliveredResultSchema) }),
    request({ key: 'terminalResize', channel: 'roc:terminal:resize', domain: 'terminal', method: 'resize', kind: 'plugin', capabilityName: 'terminal.resize', inputTransform: first, contract: methodContract(oneArg(terminalSessionResizeRequestSchema), terminalSessionSnapshotSchema) }),
    request({ key: 'terminalCloseSession', channel: 'roc:terminal:close-session', domain: 'terminal', method: 'closeSession', kind: 'plugin', capabilityName: 'terminal.closeSession', inputTransform: first, contract: methodContract(oneArg(terminalSessionCloseRequestSchema), closedResultSchema) }),
    request({ key: 'rtkStatus', channel: 'roc:rtk:status', domain: 'rtk', method: 'status', kind: 'plugin', capabilityName: 'rtk.status', inputTransform: none, contract: methodContract(noArgs, rtkStatusSchema) }),
    request({ key: 'shellExecute', channel: 'roc:shell:execute', domain: 'shell', method: 'execute', kind: 'plugin', capabilityName: 'shell.execute', inputTransform: first, contract: methodContract(oneArg(shellExecutionIpcRequestSchema), shellExecutionResultSchema) }),
    request({ key: 'shellConfirm', channel: 'roc:shell:confirm', domain: 'shell', method: 'confirm', kind: 'direct', contract: methodContract(oneArg(shellConfirmationRequestSchema), shellConfirmationResultSchema) })
  ],
  events: [
    event({ key: 'appearanceUpdated', channel: 'roc:appearance:updated', domain: 'app', method: 'onAppearanceUpdated', contract: eventContract(systemAppearanceSnapshotSchema) }),
    event({ key: 'navigate', channel: 'roc:navigate', domain: 'app', method: 'onNavigate', contract: eventContract(z.string()) }),
    event({ key: 'windowHidden', channel: 'roc:window:hidden', domain: 'window', method: 'onHidden', contract: eventContract(windowHiddenSnapshotSchema) }),
    event({ key: 'tasksUpdated', channel: 'roc:tasks:updated', domain: 'tasks', method: 'onUpdated', contract: eventContract(taskUpdateEventSchema.nullable()) }),
    event({ key: 'workspaceChanged', channel: 'roc:workspace:changed', domain: 'workspace', method: 'onChanged', contract: eventContract(workspaceChangedEventSchema) }),
    event({ key: 'terminalOutput', channel: 'roc:terminal:output', domain: 'terminal', method: 'onOutput', contract: eventContract(terminalSessionOutputEventSchema) }),
    event({ key: 'terminalExit', channel: 'roc:terminal:exit', domain: 'terminal', method: 'onExit', contract: eventContract(terminalSessionExitEventSchema) }),
    event({ key: 'chatRunEvent', channel: 'roc:chat:run-event', domain: 'chat', method: 'onRunEvent', contract: eventContract(chatRunEventSchema) }),
    event({ key: 'skillsUpdated', channel: 'roc:skills:updated', domain: 'skills', method: 'onUpdated', contract: eventContract(builtinSkillsStatusSchema) })
  ]
} as const;

export type IpcRequestEntry = (typeof ipcRegistry.requests)[number];
export type IpcEventEntry = (typeof ipcRegistry.events)[number];
type RequestEntry = IpcRequestEntry;
type EventEntry = IpcEventEntry;
type IpcDomain = RequestEntry['domain'] | EventEntry['domain'];

export function parseIpcRequestArgs(channel: string, args: unknown[]): unknown[] {
  const entry = ipcRegistry.requests.find((candidate) => candidate.channel === channel);
  if (entry === undefined) {
    throw new Error(`ipc_request_contract_not_found:${channel}`);
  }
  return entry.contract.args.parse(args);
}

export function parseIpcResult(channel: string, result: unknown): IpcResult<unknown> {
  const entry = ipcRegistry.requests.find((candidate) => candidate.channel === channel);
  if (entry === undefined) {
    throw new Error(`ipc_request_contract_not_found:${channel}`);
  }
  return ipcResultSchema(entry.contract.result).parse(result);
}

export function parseIpcEventPayload(channel: string, payload: unknown): unknown {
  const entry = ipcRegistry.events.find((candidate) => candidate.channel === channel);
  if (entry === undefined) {
    throw new Error(`ipc_event_contract_not_found:${channel}`);
  }
  return entry.contract.payload.parse(payload);
}

type RequestMethod<TEntry> = TEntry extends {
  contract: IpcMethodContract<infer TArgsSchema, infer TResultSchema>;
}
  ? (...args: z.output<TArgsSchema>) => Promise<IpcResult<z.output<TResultSchema>>>
  : never;

type EventMethod<TEntry> = TEntry extends { contract: IpcEventContract<infer TPayloadSchema> }
  ? (callback: (payload: z.output<TPayloadSchema>) => void) => () => void
  : never;

type DomainRequests<TDomain extends IpcDomain> = {
  [TEntry in RequestEntry as TEntry['domain'] extends TDomain ? TEntry['method'] : never]: RequestMethod<TEntry>;
};

type DomainEvents<TDomain extends IpcDomain> = {
  [TEntry in EventEntry as TEntry['domain'] extends TDomain ? TEntry['method'] : never]: EventMethod<TEntry>;
};

type Expand<TValue> = { [TKey in keyof TValue]: TValue[TKey] };

export type RocPreloadApi = {
  [TDomain in IpcDomain]: Expand<DomainRequests<TDomain> & DomainEvents<TDomain>>;
};
