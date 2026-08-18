import { z } from 'zod';

import {
  agentCapabilityPreviewRequestSchema,
  agentCapabilityPreviewSchema,
  agentLangSmithConfigSchema,
  agentLangSmithSetApiKeyRequestSchema,
  agentLangSmithSettingsSchema,
  agentRuntimeStatusSchema,
  deepAgentConfigPreviewSchema
} from './schemas/agent';
import {
  activeChatRunSchema,
  chatActiveRunRequestSchema,
  chatCancelRunResultSchema,
  chatRunEventSchema,
  chatRunEventsReplayRequestSchema,
  chatRunEventsReplayResultSchema,
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
  fileDialogSelectionSchema,
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

export const ipcRegistry = {
  version: 2,
  requests: [
    request({ key: 'appGetStatus', channel: 'roc:app:get-status', domain: 'app', method: 'getStatus', kind: 'plugin', capabilityName: 'app.status.get', inputTransform: none, contract: methodContract(noArgs, appStatusSchema) }),
    request({ key: 'appOpenSettings', channel: 'roc:app:open-settings', domain: 'app', method: 'openSettings', kind: 'direct', contract: methodContract(noArgs, openedResultSchema) }),
    request({ key: 'appOpenMainPage', channel: 'roc:app:open-main-page', domain: 'app', method: 'openMainPage', kind: 'direct', contract: methodContract(stringArg, openedPageResultSchema) }),
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
    request({ key: 'settingsTestProvider', channel: 'roc:settings:test-provider', domain: 'settings', method: 'testProvider', kind: 'direct', contract: methodContract(stringArg, providerTestResultSchema) }),
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
    request({ key: 'agentGetStatus', channel: 'roc:agent:get-status', domain: 'agent', method: 'getStatus', kind: 'plugin', capabilityName: 'agent.status.get', inputTransform: none, contract: methodContract(noArgs, agentRuntimeStatusSchema) }),
    request({ key: 'agentGetConfigPreview', channel: 'roc:agent:get-config-preview', domain: 'agent', method: 'getConfigPreview', kind: 'plugin', capabilityName: 'agent.config.preview', inputTransform: none, contract: methodContract(noArgs, deepAgentConfigPreviewSchema) }),
    request({ key: 'agentGetCapabilityPreview', channel: 'roc:agent:get-capability-preview', domain: 'agent', method: 'getCapabilityPreview', kind: 'plugin', capabilityName: 'agent.capability.preview', inputTransform: first, contract: methodContract(oneArg(agentCapabilityPreviewRequestSchema), agentCapabilityPreviewSchema) }),
    request({ key: 'agentLangSmithSettingsGet', channel: 'roc:agent:langsmith:settings:get', domain: 'agent', method: 'getLangSmithSettings', kind: 'plugin', capabilityName: 'agent.langsmith.settings.get', inputTransform: none, contract: methodContract(noArgs, agentLangSmithSettingsSchema) }),
    request({ key: 'agentLangSmithSettingsSave', channel: 'roc:agent:langsmith:settings:save', domain: 'agent', method: 'saveLangSmithSettings', kind: 'plugin', capabilityName: 'agent.langsmith.settings.save', inputTransform: first, contract: methodContract(oneArg(agentLangSmithConfigSchema), agentLangSmithSettingsSchema) }),
    request({ key: 'agentLangSmithSecretSet', channel: 'roc:agent:langsmith:secret:set', domain: 'agent', method: 'setLangSmithApiKey', kind: 'plugin', capabilityName: 'agent.langsmith.secret.set', inputTransform: first, contract: methodContract(oneArg(agentLangSmithSetApiKeyRequestSchema), agentLangSmithSettingsSchema) }),
    request({ key: 'agentLangSmithSecretClear', channel: 'roc:agent:langsmith:secret:clear', domain: 'agent', method: 'clearLangSmithApiKey', kind: 'plugin', capabilityName: 'agent.langsmith.secret.clear', inputTransform: none, contract: methodContract(noArgs, agentLangSmithSettingsSchema) }),
    request({ key: 'chatStartRun', channel: 'roc:chat:start-run', domain: 'chat', method: 'startRun', kind: 'plugin', capabilityName: 'agent.run.start', inputTransform: first, contract: methodContract(oneArg(chatStartRunIpcRequestSchema), chatStartRunResultSchema) }),
    request({ key: 'chatCancelRun', channel: 'roc:chat:cancel-run', domain: 'chat', method: 'cancelRun', kind: 'plugin', capabilityName: 'agent.run.cancel', inputTransform: id('runId'), contract: methodContract(stringArg, chatCancelRunResultSchema) }),
    request({ key: 'chatResumeRun', channel: 'roc:chat:resume-run', domain: 'chat', method: 'resumeRun', kind: 'plugin', capabilityName: 'agent.run.resume', inputTransform: first, contract: methodContract(oneArg(chatResumeRunRequestSchema), chatResumeRunResultSchema) }),
    request({ key: 'chatGetRunEvents', channel: 'roc:chat:get-run-events', domain: 'chat', method: 'getRunEvents', kind: 'plugin', capabilityName: 'agent.run.events.list', inputTransform: first, contract: methodContract(oneArg(chatRunEventsReplayRequestSchema), chatRunEventsReplayResultSchema) }),
    request({ key: 'chatGetActiveRun', channel: 'roc:chat:get-active-run', domain: 'chat', method: 'getActiveRun', kind: 'plugin', capabilityName: 'agent.run.active.get', inputTransform: first, contract: methodContract(oneArg(chatActiveRunRequestSchema), activeChatRunSchema.nullable()) }),
    request({ key: 'workspaceGetCurrent', channel: 'roc:workspace:get-current', domain: 'workspace', method: 'getCurrent', kind: 'plugin', capabilityName: 'workspace.getCurrent', inputTransform: none, contract: methodContract(noArgs, workspaceSchema.nullable()) }),
    request({ key: 'workspaceSelect', channel: 'roc:workspace:select', domain: 'workspace', method: 'select', kind: 'plugin', capabilityName: 'workspace.select', inputTransform: first, contract: methodContract(oneArg(workspaceSelectRequestSchema), workspaceSchema) }),
    request({ key: 'workspaceSelectFromDialog', channel: 'roc:workspace:select-from-dialog', domain: 'workspace', method: 'selectFromDialog', kind: 'direct', contract: methodContract(noArgs, workspaceSchema.nullable()) }),
    request({ key: 'filesSelectFromDialog', channel: 'roc:files:select-from-dialog', domain: 'files', method: 'selectFromDialog', kind: 'direct', contract: methodContract(noArgs, fileDialogSelectionSchema.nullable()) }),
    request({ key: 'filesListTree', channel: 'roc:files:list-tree', domain: 'files', method: 'listTree', kind: 'plugin', capabilityName: 'files.listTree', inputTransform: first, contract: methodContract(oneArg(fileTreeRequestSchema), fileTreeResultSchema) }),
    request({ key: 'filesSearch', channel: 'roc:files:search', domain: 'files', method: 'search', kind: 'plugin', capabilityName: 'files.search', inputTransform: first, contract: methodContract(oneArg(fileSearchRequestSchema), fileSearchResultSchema) }),
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
    event({ key: 'tasksUpdated', channel: 'roc:tasks:updated', domain: 'tasks', method: 'onUpdated', contract: eventContract(taskUpdateEventSchema.nullable()) }),
    event({ key: 'workspaceChanged', channel: 'roc:workspace:changed', domain: 'workspace', method: 'onChanged', contract: eventContract(workspaceChangedEventSchema) }),
    event({ key: 'terminalOutput', channel: 'roc:terminal:output', domain: 'terminal', method: 'onOutput', contract: eventContract(terminalSessionOutputEventSchema) }),
    event({ key: 'terminalExit', channel: 'roc:terminal:exit', domain: 'terminal', method: 'onExit', contract: eventContract(terminalSessionExitEventSchema) }),
    event({ key: 'chatRunEvent', channel: 'roc:chat:run-event', domain: 'chat', method: 'onRunEvent', contract: eventContract(chatRunEventSchema) })
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
