import type { ClientTool } from '@langchain/core/tools';
import { z } from 'zod';

import type { CapabilityDescriptor, RocCapabilityRegistry } from '../../../../src/main/kernel/types';
import type {
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  FileDeleteResult,
  RecoveryPoint,
  ShellExecutionResult,
  SkillFilePreviewResult,
  SkillSnapshot,
  TaskDetail,
  Workspace
} from '../../../../src/shared/types';

const workspacePath = process.cwd();

export function createCapabilities(
  calls: Array<{ name: string; input: unknown }>,
  options: {
    capabilityPreview?: boolean;
    mcpTools?: ClientTool[];
    workspace?: Workspace | null;
    skills?: SkillSnapshot[];
    skillFiles?: Record<string, string>;
  } = {}
): RocCapabilityRegistry {
  const capabilityPreviewDescriptor: CapabilityDescriptor = {
    name: 'agent.capability.preview',
    version: '1.0.0',
    inputSchema: z.unknown(),
    outputSchema: z.unknown()
  };
  return {
    declare: () => {},
    register: () => {},
    list: () => (options.capabilityPreview === true ? [capabilityPreviewDescriptor] : []),
    invoke: async <TInput, TOutput>(name: string, input: TInput): Promise<TOutput> => {
      calls.push({ name, input });
      if (name === 'agent.capability.preview') {
        return { interruptOn: {} } as TOutput;
      }
      if (name === 'workspace.getCurrent') {
        if ('workspace' in options) {
          return options.workspace as TOutput;
        }
        return {
          id: 'workspace-1',
          path: workspacePath,
          displayName: 'Roc',
          lastOpenedAt: '2026-06-04T00:00:00.000Z',
          trustState: 'trusted'
        } satisfies Workspace as TOutput;
      }
      if (name === 'mcp.tools.get') {
        return (options.mcpTools === undefined ? [] : options.mcpTools) as TOutput;
      }
      if (name === 'skills.list') {
        return (options.skills === undefined ? [] : options.skills) as TOutput;
      }
      if (name === 'skills.file.read') {
        const request = input as { id: string; relativePath: string };
        const content = (options.skillFiles === undefined ? {} : options.skillFiles)[request.id];
        if (content === undefined) {
          throw new Error(`skill_file_missing:${request.id}`);
        }
        return {
          id: request.id,
          relativePath: request.relativePath,
          kind: 'text',
          content,
          truncated: false,
          sizeBytes: Buffer.byteLength(content, 'utf8')
        } satisfies SkillFilePreviewResult as TOutput;
      }
      if (name === 'task.background.preview') {
        return createPreview(input as BackgroundTaskPreviewRequest) as TOutput;
      }
      if (name === 'task.background.create') {
        return createTask(createPreview(input as BackgroundTaskPreviewRequest), 'running') as TOutput;
      }
      if (name === 'task.detail.get') {
        return createTaskDetail() as TOutput;
      }
      if (name === 'task.background.update') {
        return createTask(createPreview((input as { patch: Partial<BackgroundTaskPreviewRequest> }).patch), 'running') as TOutput;
      }
      if (name === 'task.background.cancel') {
        return createTask(createPreview({ goal: '已取消任务' }), 'cancelled') as TOutput;
      }
      if (name === 'shell.execute') {
        const request = input as { command: string; cwd?: string };
        return {
          command: request.command,
          normalizedCommand: request.command,
          cwd: request.cwd === undefined ? workspacePath : request.cwd,
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          durationMs: 1,
          usedRtk: false
        } satisfies ShellExecutionResult as TOutput;
      }
      if (name === 'web.read') {
        return {
          content: 'Reader output body',
          source: (input as { url: string }).url,
          proxy: 'https://r.jina.ai/',
          fetchedAt: '2026-06-04T00:00:00.000Z',
          contentHash: 'a'.repeat(64),
          untrusted: true
        } as TOutput;
      }
      if (name === 'files.delete') {
        const request = input as { relativePath: string };
        return {
          relativePath: request.relativePath,
          recoveryPoint: createRecoveryPoint(request.relativePath)
        } satisfies FileDeleteResult as TOutput;
      }
      throw new Error(`unexpected_capability:${name}`);
    }
  } satisfies RocCapabilityRegistry;
}

export function createMcpTool(name: string): ClientTool {
  return {
    name,
    description: 'MCP search tool'
  } as ClientTool;
}

function createPreview(input: Partial<BackgroundTaskPreviewRequest>): BackgroundTaskPreview {
  const trigger = input.trigger ?? { type: 'manual', description: '手动' };
  return {
    goal: input.goal ?? '每天检查测试',
    trigger,
    workspacePath: input.workspacePath ?? workspacePath,
    allowedActions: input.allowedActions ?? [],
    forbiddenActions: input.forbiddenActions ?? [],
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations',
    enabledCapabilities: input.enabledCapabilities === undefined ? null : input.enabledCapabilities,
    scheduled: trigger.type !== 'manual',
    nextRunAt: trigger.type === 'cron' || trigger.type === 'once' ? trigger.nextRunAt : null,
    cronExpression: trigger.type === 'cron' ? trigger.cronExpression : null,
    riskLevel: 'low',
    requiresConfirmation: false
  };
}

function createTask(preview: BackgroundTaskPreview, status: BackgroundTask['status']): BackgroundTask {
  return {
    id: 'background-1',
    threadId: 'thread-background-1',
    runId: 'run-background-1',
    goal: preview.goal,
    status,
    scheduled: preview.scheduled,
    triggerType: preview.trigger.type,
    triggerDescription: preview.trigger.description,
    nextRunAt: preview.nextRunAt,
    cronExpression: preview.cronExpression,
    workspacePath: preview.workspacePath,
    allowedActions: preview.allowedActions,
    forbiddenActions: preview.forbiddenActions,
    failurePolicy: preview.failurePolicy,
    notificationPolicy: preview.notificationPolicy,
    riskLevel: preview.riskLevel,
    requiresConfirmation: preview.requiresConfirmation,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 0,
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
    enabledCapabilities: preview.enabledCapabilities
  };
}

function createTaskDetail(): TaskDetail {
  return {
    threadId: 'thread-background-1',
    taskId: 'background-1',
    thread: {
      id: 'thread-background-1',
      kind: 'background',
      title: '每天检查测试',
      goal: '每天检查测试',
      status: 'running',
      createdAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:00:00.000Z'
    },
    backgroundTask: createTask(createPreview({}), 'running'),
    lastRunId: null,
    runHistory: [],
    recentEvents: [],
    schedulerRegistered: true
  };
}

function createRecoveryPoint(relativePath: string): RecoveryPoint {
  return {
    id: 'recovery-1',
    relativePath,
    snapshotPath: 'F:\\Code\\Roc\\.roc-test\\recovery-1',
    contentSha256: 'sha256-test',
    source: 'agent',
    createdAt: '2026-06-04T00:00:00.000Z',
    restored: false
  };
}
