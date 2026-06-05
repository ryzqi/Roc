import { describe, expect, it } from 'vitest';

import {
  createPluginCapabilityAdapter,
  pluginCapabilityMappings,
  type PluginCapabilityInvoker,
  registerPluginCapabilityIpc
} from '../../src/main/ipc/plugin-capability-adapter';
import type { IpcMainHandler } from '../../src/main/ipc/ipc-common';
import { ipcChannels } from '../../src/shared/ipc';

describe('plugin capability IPC adapter', () => {
  it('owns required preload-to-capability name mismatches and input adapters', async () => {
    const calls: Array<{ capabilityName: string; input: unknown }> = [];
    const invoker: PluginCapabilityInvoker = {
      invokeCapability: async <TInput, TOutput>(capabilityName: string, input: TInput): Promise<TOutput> => {
        calls.push({ capabilityName, input });
        return { capabilityName, input } as TOutput;
      }
    };
    const adapter = createPluginCapabilityAdapter(invoker);

    for (const mapping of requiredMappings()) {
      const result = await adapter.invoke(mapping.preloadMethod, mapping.args);

      expect(result).toEqual({
        ok: true,
        data: {
          capabilityName: mapping.capabilityName,
          input: mapping.expectedInput
        }
      });
    }

    expect(calls).toHaveLength(requiredMappings().length);
  });

  it('covers current plugin-backed IPC domains through the mapping table', () => {
    expect(new Set(pluginCapabilityMappings.map((mapping) => mapping.domain))).toEqual(
      new Set([
        'agent',
        'app',
        'chat',
        'diagnostics',
        'files',
        'git',
        'lifecycle',
        'mcp',
        'memory',
        'rtk',
        'sessions',
        'skills',
        'tasks',
        'terminal',
        'workspace'
      ])
    );
  });

  it('returns the current IpcResult error shape when capability invocation fails', async () => {
    const adapter = createPluginCapabilityAdapter({
      invokeCapability: async () => {
        throw new Error('capability_not_found');
      }
    });

    await expect(adapter.invoke('chat.startRun', [chatRequest()])).resolves.toMatchObject({
      ok: false,
      error: {
        category: 'internal',
        code: 'internal_error',
        retryable: false
      }
    });
  });

  it('registers explicit generated channels without wildcard handlers', async () => {
    const handlers = new Map<string, IpcMainHandler>();
    registerPluginCapabilityIpc((channel, handler) => {
      handlers.set(channel, handler);
    }, {
      invokeCapability: async <TInput, TOutput>(capabilityName: string, input: TInput): Promise<TOutput> =>
        ({ capabilityName, input }) as TOutput
    });

    expect(handlers.has('*')).toBe(false);
    expect(handlers.has(ipcChannels.chatCancelRun)).toBe(true);

    await expect(handlers.get(ipcChannels.chatCancelRun)?.({}, 'run_1')).resolves.toEqual({
      ok: true,
      data: {
        capabilityName: 'agent.run.cancel',
        input: { runId: 'run_1' }
      }
    });
  });
});

function requiredMappings(): Array<{
  preloadMethod: string;
  capabilityName: string;
  args: unknown[];
  expectedInput: unknown;
}> {
  const request = { requestId: 'request_1' };
  return [
    { preloadMethod: 'chat.startRun', capabilityName: 'agent.run.start', args: [request], expectedInput: request },
    { preloadMethod: 'chat.cancelRun', capabilityName: 'agent.run.cancel', args: ['run_1'], expectedInput: { runId: 'run_1' } },
    { preloadMethod: 'chat.resumeRun', capabilityName: 'agent.run.resume', args: [request], expectedInput: request },
    { preloadMethod: 'agent.getCapabilityPreview', capabilityName: 'agent.capability.preview', args: [request], expectedInput: request },
    { preloadMethod: 'sessions.list', capabilityName: 'agent.sessions.list', args: [request], expectedInput: request },
    { preloadMethod: 'sessions.search', capabilityName: 'agent.sessions.search', args: [request], expectedInput: request },
    { preloadMethod: 'tasks.getThreadMessages', capabilityName: 'task.thread.messages.list', args: [request], expectedInput: request },
    { preloadMethod: 'tasks.listBackgroundTasks', capabilityName: 'task.background.list', args: [], expectedInput: {} },
    { preloadMethod: 'tasks.deleteThread', capabilityName: 'task.thread.delete', args: [request], expectedInput: request },
    { preloadMethod: 'tasks.runBackgroundNow', capabilityName: 'task.background.runNow', args: ['task_1'], expectedInput: { id: 'task_1' } },
    { preloadMethod: 'tasks.pauseBackgroundTask', capabilityName: 'task.background.pause', args: ['task_1'], expectedInput: { id: 'task_1' } },
    { preloadMethod: 'tasks.resumeBackgroundTask', capabilityName: 'task.background.resume', args: ['task_1'], expectedInput: { id: 'task_1' } },
    { preloadMethod: 'tasks.cancelBackgroundTask', capabilityName: 'task.background.cancel', args: ['task_1'], expectedInput: { id: 'task_1' } },
    { preloadMethod: 'tasks.deleteBackgroundTask', capabilityName: 'task.background.delete', args: ['task_1'], expectedInput: { id: 'task_1' } },
    { preloadMethod: 'tasks.getActiveTasks', capabilityName: 'task.active.list', args: [], expectedInput: {} },
    { preloadMethod: 'tasks.getTaskDetail', capabilityName: 'task.detail.get', args: [request], expectedInput: request },
    { preloadMethod: 'tasks.listScheduledRuns', capabilityName: 'task.scheduledRuns.list', args: [request], expectedInput: request },
    { preloadMethod: 'tasks.updateBackgroundTask', capabilityName: 'task.background.update', args: [request], expectedInput: request },
    { preloadMethod: 'tasks.openInChat', capabilityName: 'task.background.openInChat', args: [request], expectedInput: request },
    { preloadMethod: 'tasks.getSchedulerStatus', capabilityName: 'task.scheduler.status', args: [], expectedInput: {} },
    { preloadMethod: 'git.status', capabilityName: 'git.status', args: [], expectedInput: {} },
    { preloadMethod: 'git.diffStat', capabilityName: 'git.diffStat', args: [], expectedInput: {} },
    { preloadMethod: 'git.fileDiff', capabilityName: 'git.fileDiff', args: [request], expectedInput: request },
    { preloadMethod: 'git.stageFile', capabilityName: 'git.stageFile', args: [request], expectedInput: request },
    { preloadMethod: 'git.stageFiles', capabilityName: 'git.stageFiles', args: [request], expectedInput: request },
    { preloadMethod: 'git.unstageFile', capabilityName: 'git.unstageFile', args: [request], expectedInput: request },
    { preloadMethod: 'git.discardFile', capabilityName: 'git.discardFile', args: [request], expectedInput: request },
    { preloadMethod: 'git.commit', capabilityName: 'git.commit', args: [request], expectedInput: request },
    { preloadMethod: 'git.push', capabilityName: 'git.push', args: [], expectedInput: {} },
    { preloadMethod: 'git.listBranches', capabilityName: 'git.listBranches', args: [], expectedInput: {} },
    { preloadMethod: 'git.createBranch', capabilityName: 'git.createBranch', args: [request], expectedInput: request },
    { preloadMethod: 'git.checkoutBranch', capabilityName: 'git.checkoutBranch', args: [request], expectedInput: request },
    { preloadMethod: 'terminal.createSession', capabilityName: 'terminal.createSession', args: [request], expectedInput: request },
    { preloadMethod: 'terminal.writeInput', capabilityName: 'terminal.writeInput', args: [request], expectedInput: request },
    { preloadMethod: 'terminal.resize', capabilityName: 'terminal.resize', args: [request], expectedInput: request },
    { preloadMethod: 'terminal.closeSession', capabilityName: 'terminal.closeSession', args: [request], expectedInput: request },
    { preloadMethod: 'memory.status', capabilityName: 'memory.status.get', args: [], expectedInput: {} },
    { preloadMethod: 'memory.readFile', capabilityName: 'memory.file.read', args: [request], expectedInput: request },
    { preloadMethod: 'memory.writeFile', capabilityName: 'memory.file.write', args: [request], expectedInput: request },
    { preloadMethod: 'memory.snapshotPreview', capabilityName: 'memory.snapshot.preview', args: [], expectedInput: {} },
    { preloadMethod: 'mcp.deleteServer', capabilityName: 'mcp.deleteServer', args: ['mcp_1'], expectedInput: { id: 'mcp_1' } },
    { preloadMethod: 'mcp.testServer', capabilityName: 'mcp.testServer', args: ['mcp_1'], expectedInput: { id: 'mcp_1' } },
    { preloadMethod: 'skills.importSkill', capabilityName: 'skills.import', args: [request], expectedInput: request },
    { preloadMethod: 'skills.deleteSkill', capabilityName: 'skills.delete', args: ['skill_1'], expectedInput: { id: 'skill_1' } },
    { preloadMethod: 'skills.listFiles', capabilityName: 'skills.files.list', args: [request], expectedInput: request },
    { preloadMethod: 'skills.readFile', capabilityName: 'skills.file.read', args: [request], expectedInput: request },
    {
      preloadMethod: 'diagnostics.createDiagnosticPackage',
      capabilityName: 'diagnostics.createPackage',
      args: [request],
      expectedInput: request
    }
  ];
}

function chatRequest(): unknown {
  return {
    enabledCapabilities: {
      mcpServers: [],
      skills: []
    },
    input: 'hello',
    mode: 'chat'
  };
}
