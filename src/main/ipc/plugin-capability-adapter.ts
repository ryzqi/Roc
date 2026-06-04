import { ipcChannels } from '../../shared/ipc';
import type { IpcResult } from '../../shared/types';
import { wrapIpc } from '../services/errors';
import type { TimedHandle } from './ipc-common';

export type PluginCapabilityDomain =
  | 'agent'
  | 'chat'
  | 'diagnostics'
  | 'lifecycle'
  | 'mcp'
  | 'memory'
  | 'sessions'
  | 'skills'
  | 'tasks';

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
  mapping('agent', 'agent.getStatus', ipcChannels.agentGetStatus, 'agent.status.get', emptyInput),
  mapping('chat', 'chat.startRun', ipcChannels.chatStartRun, 'agent.run.start', firstArg),
  mapping('chat', 'chat.cancelRun', ipcChannels.chatCancelRun, 'agent.run.cancel', idInput('runId')),
  mapping('chat', 'chat.resumeRun', ipcChannels.chatResumeRun, 'agent.run.resume', firstArg),
  mapping('sessions', 'sessions.list', ipcChannels.sessionMessagesList, 'agent.sessions.list', firstArg),
  mapping('sessions', 'sessions.search', ipcChannels.sessionMessagesSearch, 'agent.sessions.search', firstArg),
  mapping('tasks', 'tasks.getSnapshot', ipcChannels.tasksGetSnapshot, 'task.snapshot.get', emptyInput),
  mapping('tasks', 'tasks.createBackgroundTaskPreview', ipcChannels.tasksCreateBackgroundPreview, 'task.background.preview', firstArg),
  mapping('tasks', 'tasks.createBackgroundTask', ipcChannels.tasksCreateBackgroundTask, 'task.background.create', firstArg),
  mapping('tasks', 'tasks.runBackgroundNow', ipcChannels.tasksRunBackgroundNow, 'task.background.runNow', idInput('id')),
  mapping('tasks', 'tasks.pauseBackgroundTask', ipcChannels.tasksPauseBackgroundTask, 'task.background.pause', idInput('id')),
  mapping('tasks', 'tasks.resumeBackgroundTask', ipcChannels.tasksResumeBackgroundTask, 'task.background.resume', idInput('id')),
  mapping('tasks', 'tasks.cancelBackgroundTask', ipcChannels.tasksCancelBackgroundTask, 'task.background.cancel', idInput('id')),
  mapping('tasks', 'tasks.deleteBackgroundTask', ipcChannels.tasksDeleteBackgroundTask, 'task.background.delete', idInput('id')),
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
  mapping('mcp', 'mcp.listServers', ipcChannels.mcpListServers, 'mcp.listServers', emptyInput),
  mapping('mcp', 'mcp.upsertServer', ipcChannels.mcpUpsertServer, 'mcp.upsertServer', firstArg),
  mapping('mcp', 'mcp.setServerEnabled', ipcChannels.mcpSetServerEnabled, 'mcp.setServerEnabled', firstArg),
  mapping('mcp', 'mcp.deleteServer', ipcChannels.mcpDeleteServer, 'mcp.deleteServer', idInput('id')),
  mapping('mcp', 'mcp.testServer', ipcChannels.mcpTestServer, 'mcp.testServer', idInput('id')),
  mapping('skills', 'skills.list', ipcChannels.skillsList, 'skills.list', emptyInput),
  mapping('skills', 'skills.importSkill', ipcChannels.skillsImport, 'skills.import', firstArg),
  mapping('skills', 'skills.setEnabled', ipcChannels.skillsSetEnabled, 'skills.setEnabled', firstArg),
  mapping('skills', 'skills.deleteSkill', ipcChannels.skillsDelete, 'skills.delete', idInput('id')),
  mapping('skills', 'skills.listFiles', ipcChannels.skillsListFiles, 'skills.files.list', firstArg),
  mapping('skills', 'skills.readFile', ipcChannels.skillsReadFile, 'skills.file.read', firstArg)
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
