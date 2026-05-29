import type { ClientTool } from '@langchain/core/tools';
import type { BaseCheckpointSaver, BaseStore } from '@langchain/langgraph';
import type { AppSettings } from '../../../shared/types';
import type { AgentService } from '../agent-service';
import type { FileService } from '../file-service';
import { CapacityService } from '../memory/capacity';
import type { ConsolidatorService } from '../memory/consolidator';
import { SecurityScanService } from '../memory/security-scan';
import type { SessionArchiveService } from '../memory/session-archive';
import type { MemoryService } from '../memory-service';
import type { McpService } from '../mcp-service';
import type { RocPaths } from '../paths';
import type { TaskSchedulerService } from '../task-scheduler-service';
import type { TaskService } from '../task-service';
import type { WebReadService } from '../web-read-service';
import type { WorkspaceService } from '../workspace-service';
import { PreviewStore } from '../forge-guardrails';
import { createBackgroundTaskTools } from './background-task-tools';
import { createUsageAccumulator, type ProviderUsageAccumulator } from './stream-consumers';
import { buildDeepAgent } from './agent-builder';
import { createBackend, type RocCompositeBackend } from './backend';
import * as prompt from './prompt';
import * as tools from './tools';
import type { AgentExecuteAdapter, RunExecutionContext, RuntimeSubagent } from './types';

export type DeepAgentSession = {
  agent: ReturnType<typeof buildDeepAgent>;
  assistantChunks: string[];
  closers: Array<() => Promise<void>>;
  configurable: {
    run_id: string;
    thread_id: string;
  };
  reasoningChunks: string[];
  runtimeBackend: RocCompositeBackend;
  previewStore: PreviewStore;
  runTools: ClientTool[];
  subagents: RuntimeSubagent[];
  usageAccumulator: ProviderUsageAccumulator;
};

export async function createDeepAgentSession(input: {
  agentService: Pick<AgentService, 'getCapabilityPreview'>;
  context: RunExecutionContext;
  fileService: FileService;
  getCheckpointer: () => BaseCheckpointSaver;
  getMemorySettings: () => AppSettings['memory'];
  consolidatorService: ConsolidatorService;
  memoryService: MemoryService;
  sessionArchiveService: SessionArchiveService;
  mcpService: McpService;
  paths: RocPaths;
  shellExecutionService: AgentExecuteAdapter;
  store: BaseStore;
  taskSchedulerService: TaskSchedulerService;
  taskService: TaskService;
  webReadService: WebReadService;
  workspaceService: WorkspaceService;
}): Promise<DeepAgentSession> {
  const closers: Array<() => Promise<void>> = [];
  const assistantChunks: string[] = [];
  const reasoningChunks: string[] = [];
  const usageAccumulator = createUsageAccumulator();
  const previewStore = new PreviewStore();
  input.context.previewStore = previewStore;
  closers.push(async () => {
    previewStore.clear();
  });
  const interruptOn =
    input.context.taskRun === null
      ? undefined
      : input.agentService.getCapabilityPreview(input.context.enabledCapabilities).interruptOn;
  const runTools = await createRunTools({
    closers,
    enabledCapabilities: input.context.enabledCapabilities,
    fileService: input.fileService,
    mcpService: input.mcpService,
    sessionArchiveService: input.sessionArchiveService,
    taskSchedulerService: input.taskSchedulerService,
    taskService: input.taskService,
    previewStore,
    webReadService: input.webReadService
  });
  const memorySettings = input.getMemorySettings();
  const runtimeBackend = createBackend({
    workspaceService: input.workspaceService,
    paths: input.paths,
    shellExecutionService: input.shellExecutionService,
    securityScan: new SecurityScanService(memorySettings.securityScan),
    capacity: new CapacityService(memorySettings.charLimits),
    consolidatorService: input.consolidatorService,
    activeModelHandle: input.context.modelHandle,
    selectedSkillIds: input.context.enabledCapabilities.skills
  });
  const workspace = input.workspaceService.getCurrentWorkspace();
  const frozenSnapshot = input.memoryService.buildSnapshotForCurrentWorkspace();
  const skillSources = input.context.enabledCapabilities.skills.length === 0 ? [] : ['/skills/'];
  const subagents = tools.createRunSubagents({
    webReadTool: runTools.webReadTool
  });
  const agent = buildDeepAgent({
    model: input.context.modelHandle.model,
    systemPrompt: prompt.buildSystemPrompt({
      enabledCapabilities: input.context.enabledCapabilities,
      workspacePath: workspace?.path ?? null,
      frozenSnapshot
    }),
    backend: runtimeBackend.backend,
    store: input.store,
    memorySources: [],
    skillSources,
    subagents,
    tools: runTools.tools,
    filesystemPermissions: undefined,
    interruptOn,
    checkpointer: input.context.taskRun === null ? undefined : input.getCheckpointer()
  });

  return {
    agent,
    assistantChunks,
    closers,
    configurable: {
      thread_id: input.context.threadId,
      run_id: input.context.runId
    },
    reasoningChunks,
    runtimeBackend: runtimeBackend.backend,
    previewStore,
    runTools: runTools.tools,
    subagents,
    usageAccumulator
  };
}

async function createRunTools(input: {
  closers: Array<() => Promise<void>>;
  enabledCapabilities: RunExecutionContext['enabledCapabilities'];
  fileService: FileService;
  mcpService: McpService;
  sessionArchiveService: SessionArchiveService;
  taskSchedulerService: TaskSchedulerService;
  taskService: TaskService;
  previewStore: PreviewStore;
  webReadService: WebReadService;
}): Promise<{
  tools: ClientTool[];
  webReadTool: ReturnType<typeof tools.createWebReadTool>;
}> {
  const webReadTool = tools.createWebReadTool(input.webReadService);
  const deleteFileTool = tools.createDeleteFileTool(input.fileService);
  const readBackgroundTaskTool = tools.createReadBackgroundTaskTool(input.taskService);
  const confirmWithUserTool = tools.createConfirmWithUserTool();
  const backgroundTaskTools = createBackgroundTaskTools({
    taskService: input.taskService,
    schedulerService: input.taskSchedulerService,
    enabledCapabilities: input.enabledCapabilities,
    previewStore: input.previewStore
  });
  const sessionSearchTool = tools.createSessionSearchTool(input.sessionArchiveService);
  const runTools: ClientTool[] = [
    webReadTool,
    deleteFileTool,
    readBackgroundTaskTool,
    confirmWithUserTool,
    ...backgroundTaskTools,
    sessionSearchTool
  ];
  const webSearchTool = await tools.createWebSearchTool({
    mcpService: input.mcpService,
    enabledCapabilities: input.enabledCapabilities,
    closers: input.closers
  });
  if (webSearchTool !== null) {
    runTools.push(webSearchTool);
  }
  return {
    tools: runTools,
    webReadTool
  };
}
