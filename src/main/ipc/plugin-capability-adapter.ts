import { ipcChannels } from '../../shared/ipc';
import type { IpcResult } from '../../shared/types';
import { wrapIpc } from '../services/errors';
import type { TimedHandle } from './ipc-common';

export type PluginCapabilityDomain =
  | 'agent'
  | 'app'
  | 'chat'
  | 'diagnostics'
  | 'files'
  | 'git'
  | 'lifecycle'
  | 'mcp'
  | 'memory'
  | 'rtk'
  | 'sessions'
  | 'shell'
  | 'skills'
  | 'tasks'
  | 'terminal'
  | 'workspace';

export type PluginCapabilityInvoker = {
  invokeCapability<TInput, TOutput>(name: string, input: TInput): Promise<TOutput>;
};

export type PluginCapabilityMapping = {
  readonly domain: PluginCapabilityDomain;
  readonly preloadMethod: string;
  readonly channel: string;
  readonly capabilityName: string;
  readonly input: (args: readonly unknown[]) => unknown;
};

export type PluginCapabilityAdapter = {
  invoke(preloadMethod: string, args: readonly unknown[]): Promise<IpcResult<unknown>>;
};

export const pluginCapabilityMappings = [
  mapping('app', 'app.getStatus', ipcChannels.appGetStatus, 'app.status.get', emptyInput),
  mapping('agent', 'agent.getStatus', ipcChannels.agentGetStatus, 'agent.status.get', emptyInput),
  mapping('agent', 'agent.getConfigPreview', ipcChannels.agentGetConfigPreview, 'agent.config.preview', emptyInput),
  mapping('agent', 'agent.getCapabilityPreview', ipcChannels.agentGetCapabilityPreview, 'agent.capability.preview', firstArg),
  mapping('chat', 'chat.startRun', ipcChannels.chatStartRun, 'agent.run.start', chatStartRunInput),
  mapping('chat', 'chat.cancelRun', ipcChannels.chatCancelRun, 'agent.run.cancel', idInput('runId')),
  mapping('chat', 'chat.resumeRun', ipcChannels.chatResumeRun, 'agent.run.resume', firstArg),
  mapping('chat', 'chat.getRunEvents', ipcChannels.chatGetRunEvents, 'agent.run.events.list', firstArg),
  mapping('chat', 'chat.getActiveRun', ipcChannels.chatGetActiveRun, 'agent.run.active.get', firstArg),
  mapping('sessions', 'sessions.list', ipcChannels.sessionMessagesList, 'agent.sessions.list', firstArg),
  mapping('sessions', 'sessions.search', ipcChannels.sessionMessagesSearch, 'agent.sessions.search', firstArg),
  mapping('tasks', 'tasks.getSnapshot', ipcChannels.tasksGetSnapshot, 'task.snapshot.get', emptyInput),
  mapping('tasks', 'tasks.getThreadMessages', ipcChannels.tasksGetThreadMessages, 'task.thread.messages.list', firstArg),
  mapping('tasks', 'tasks.listBackgroundTasks', ipcChannels.tasksListBackgroundTasks, 'task.background.list', emptyInput),
  mapping('tasks', 'tasks.deleteThread', ipcChannels.tasksDeleteThread, 'task.thread.delete', firstArg),
  mapping('tasks', 'tasks.createBackgroundTaskPreview', ipcChannels.tasksCreateBackgroundPreview, 'task.background.preview', firstArg),
  mapping('tasks', 'tasks.createBackgroundTask', ipcChannels.tasksCreateBackgroundTask, 'task.background.create', firstArg),
  mapping('tasks', 'tasks.getActiveTasks', ipcChannels.tasksGetActiveTasks, 'task.active.list', emptyInput),
  mapping('tasks', 'tasks.getTaskDetail', ipcChannels.tasksGetTaskDetail, 'task.detail.get', firstArg),
  mapping('tasks', 'tasks.listScheduledRuns', ipcChannels.tasksListScheduledRuns, 'task.scheduledRuns.list', firstArg),
  mapping('tasks', 'tasks.runBackgroundNow', ipcChannels.tasksRunBackgroundNow, 'task.background.runNow', idInput('id')),
  mapping('tasks', 'tasks.pauseBackgroundTask', ipcChannels.tasksPauseBackgroundTask, 'task.background.pause', idInput('id')),
  mapping('tasks', 'tasks.resumeBackgroundTask', ipcChannels.tasksResumeBackgroundTask, 'task.background.resume', idInput('id')),
  mapping('tasks', 'tasks.cancelBackgroundTask', ipcChannels.tasksCancelBackgroundTask, 'task.background.cancel', idInput('id')),
  mapping('tasks', 'tasks.deleteBackgroundTask', ipcChannels.tasksDeleteBackgroundTask, 'task.background.delete', idInput('id')),
  mapping('tasks', 'tasks.updateBackgroundTask', ipcChannels.tasksUpdateBackgroundTask, 'task.background.update', firstArg),
  mapping('tasks', 'tasks.getSchedulerStatus', ipcChannels.tasksGetSchedulerStatus, 'task.scheduler.status', emptyInput),
  mapping('lifecycle', 'lifecycle.getTraySummary', ipcChannels.lifecycleGetTraySummary, 'lifecycle.getTraySummary', emptyInput),
  mapping(
    'lifecycle',
    'lifecycle.pauseBackgroundExecution',
    ipcChannels.lifecyclePauseBackground,
    'lifecycle.pauseBackgroundExecution',
    emptyInput
  ),
  mapping(
    'lifecycle',
    'lifecycle.resumeBackgroundExecution',
    ipcChannels.lifecycleResumeBackground,
    'lifecycle.resumeBackgroundExecution',
    emptyInput
  ),
  mapping('diagnostics', 'diagnostics.samplePerformance', ipcChannels.diagnosticsSamplePerformance, 'diagnostics.samplePerformance', firstArg),
  mapping('diagnostics', 'diagnostics.createDiagnosticPackage', ipcChannels.diagnosticsCreatePackage, 'diagnostics.createPackage', firstArg),
  mapping('diagnostics', 'diagnostics.runChecks', ipcChannels.diagnosticsRunChecks, 'diagnostics.runChecks', emptyInput),
  mapping(
    'diagnostics',
    'diagnostics.getMetricsSnapshot',
    ipcChannels.diagnosticsGetMetricsSnapshot,
    'diagnostics.getMetricsSnapshot',
    optionalFirstArg
  ),
  mapping('diagnostics', 'diagnostics.runHealthCheck', ipcChannels.diagnosticsRunHealthCheck, 'diagnostics.runHealthCheck', emptyInput),
  mapping('memory', 'memory.status', ipcChannels.memoryStatus, 'memory.status.get', emptyInput),
  mapping('memory', 'memory.readFile', ipcChannels.memoryReadFile, 'memory.file.read', firstArg),
  mapping('memory', 'memory.writeFile', ipcChannels.memoryWriteFile, 'memory.file.write', firstArg),
  mapping('memory', 'memory.snapshotPreview', ipcChannels.memorySnapshotPreview, 'memory.snapshot.preview', emptyInput),
  mapping('workspace', 'workspace.getCurrent', ipcChannels.workspaceGetCurrent, 'workspace.getCurrent', emptyInput),
  mapping('workspace', 'workspace.select', ipcChannels.workspaceSelect, 'workspace.select', firstArg),
  mapping('files', 'files.listTree', ipcChannels.filesListTree, 'files.listTree', firstArg),
  mapping('files', 'files.search', ipcChannels.filesSearch, 'files.search', firstArg),
  mapping('files', 'files.preview', ipcChannels.filesPreview, 'files.preview', firstArg),
  mapping('files', 'files.previewPdf', ipcChannels.filesPreviewPdf, 'files.previewPdf', firstArg),
  mapping('files', 'files.writeText', ipcChannels.filesWriteText, 'files.writeText', firstArg),
  mapping('git', 'git.status', ipcChannels.gitStatus, 'git.status', emptyInput),
  mapping('git', 'git.diffStat', ipcChannels.gitDiffStat, 'git.diffStat', emptyInput),
  mapping('git', 'git.fileDiff', ipcChannels.gitFileDiff, 'git.fileDiff', firstArg),
  mapping('git', 'git.stageFile', ipcChannels.gitStageFile, 'git.stageFile', firstArg),
  mapping('git', 'git.stageFiles', ipcChannels.gitStageFiles, 'git.stageFiles', firstArg),
  mapping('git', 'git.unstageFile', ipcChannels.gitUnstageFile, 'git.unstageFile', firstArg),
  mapping('git', 'git.discardFile', ipcChannels.gitDiscardFile, 'git.discardFile', firstArg),
  mapping('git', 'git.commit', ipcChannels.gitCommit, 'git.commit', firstArg),
  mapping('git', 'git.push', ipcChannels.gitPush, 'git.push', emptyInput),
  mapping('git', 'git.listBranches', ipcChannels.gitListBranches, 'git.listBranches', emptyInput),
  mapping('git', 'git.createBranch', ipcChannels.gitCreateBranch, 'git.createBranch', firstArg),
  mapping('git', 'git.checkoutBranch', ipcChannels.gitCheckoutBranch, 'git.checkoutBranch', firstArg),
  mapping('terminal', 'terminal.createSession', ipcChannels.terminalCreateSession, 'terminal.createSession', firstArg),
  mapping('terminal', 'terminal.writeInput', ipcChannels.terminalWriteInput, 'terminal.writeInput', firstArg),
  mapping('terminal', 'terminal.resize', ipcChannels.terminalResize, 'terminal.resize', firstArg),
  mapping('terminal', 'terminal.closeSession', ipcChannels.terminalCloseSession, 'terminal.closeSession', firstArg),
  mapping('mcp', 'mcp.listServers', ipcChannels.mcpListServers, 'mcp.listServers', emptyInput),
  mapping('mcp', 'mcp.ensureExaPreset', ipcChannels.mcpEnsureExaPreset, 'mcp.ensureExaPreset', emptyInput),
  mapping('mcp', 'mcp.upsertServer', ipcChannels.mcpUpsertServer, 'mcp.upsertServer', firstArg),
  mapping('mcp', 'mcp.setServerEnabled', ipcChannels.mcpSetServerEnabled, 'mcp.setServerEnabled', firstArg),
  mapping('mcp', 'mcp.deleteServer', ipcChannels.mcpDeleteServer, 'mcp.deleteServer', idInput('id')),
  mapping('mcp', 'mcp.testServer', ipcChannels.mcpTestServer, 'mcp.testServer', idInput('id')),
  mapping('mcp', 'mcp.getConfig', ipcChannels.mcpGetConfig, 'mcp.getConfig', emptyInput),
  mapping('mcp', 'mcp.setApprovalMode', ipcChannels.mcpSetApprovalMode, 'mcp.setApprovalMode', firstArg),
  mapping('skills', 'skills.list', ipcChannels.skillsList, 'skills.list', emptyInput),
  mapping('skills', 'skills.importSkill', ipcChannels.skillsImport, 'skills.import', firstArg),
  mapping('skills', 'skills.setEnabled', ipcChannels.skillsSetEnabled, 'skills.setEnabled', firstArg),
  mapping('skills', 'skills.deleteSkill', ipcChannels.skillsDelete, 'skills.delete', idInput('id')),
  mapping('skills', 'skills.listFiles', ipcChannels.skillsListFiles, 'skills.files.list', firstArg),
  mapping('skills', 'skills.readFile', ipcChannels.skillsReadFile, 'skills.file.read', firstArg),
  mapping('rtk', 'rtk.status', ipcChannels.rtkStatus, 'rtk.status', emptyInput),
  mapping('shell', 'shell.execute', ipcChannels.shellExecute, 'shell.execute', shellExecuteInput)
] as const satisfies readonly PluginCapabilityMapping[];

export function createPluginCapabilityAdapter(invoker: PluginCapabilityInvoker): PluginCapabilityAdapter {
  const mappingsByMethod = new Map(pluginCapabilityMappings.map((item) => [item.preloadMethod, item]));
  return {
    async invoke(preloadMethod, args) {
      const target = mappingsByMethod.get(preloadMethod);
      if (target === undefined) {
        return await wrapIpc(() => {
          throw new Error(`plugin_capability_mapping_missing:${preloadMethod}`);
        });
      }
      return await wrapIpc(async () => await invoker.invokeCapability(target.capabilityName, target.input(args)));
    }
  };
}

export function registerPluginCapabilityIpc(timedHandle: TimedHandle, invoker: PluginCapabilityInvoker): void {
  const adapter = createPluginCapabilityAdapter(invoker);
  for (const target of pluginCapabilityMappings) {
    timedHandle(target.channel, (_event: unknown, ...args: unknown[]) => adapter.invoke(target.preloadMethod, args));
  }
}

function mapping(
  domain: PluginCapabilityDomain,
  preloadMethod: string,
  channel: string,
  capabilityName: string,
  input: PluginCapabilityMapping['input']
): PluginCapabilityMapping {
  return {
    domain,
    preloadMethod,
    channel,
    capabilityName,
    input
  };
}

function emptyInput(args: readonly unknown[]): {} {
  if (args.length !== 0) {
    throw new Error('ipc_capability_expected_no_args');
  }
  return {};
}

function firstArg(args: readonly unknown[]): unknown {
  const value = args[0];
  if (value === undefined) {
    throw new Error('ipc_capability_missing_arg');
  }
  return value;
}

function chatStartRunInput(args: readonly unknown[]): unknown {
  const value = firstArg(args);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const { shellAllowedCommands: _shellAllowedCommands, ...request } = value as Record<string, unknown>;
  return request;
}

function shellExecuteInput(args: readonly unknown[]): unknown {
  const value = firstArg(args);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const { signal: _signal, allowedCommands: _allowedCommands, ...request } = value as Record<string, unknown>;
  return request;
}

function optionalFirstArg(args: readonly unknown[]): unknown {
  if (args.length === 0) {
    return {};
  }
  return firstArg(args);
}

function idInput(key: 'id' | 'runId'): (args: readonly unknown[]) => Record<typeof key, string> {
  return (args) => {
    const value = firstArg(args);
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('ipc_capability_id_arg_invalid');
    }
    return { [key]: value } as Record<typeof key, string>;
  };
}
