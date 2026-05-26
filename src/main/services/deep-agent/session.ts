import type { ClientTool } from '@langchain/core/tools';
import type { BaseCheckpointSaver, BaseStore } from '@langchain/langgraph';
import type { AgentService } from '../agent-service';
import type { FileService } from '../file-service';
import type { McpService } from '../mcp-service';
import type { RocPaths } from '../paths';
import type { TaskSchedulerService } from '../task-scheduler-service';
import type { TaskService } from '../task-service';
import type { WebReadService } from '../web-read-service';
import type { WorkspaceService } from '../workspace-service';
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
  runTools: ClientTool[];
  subagents: RuntimeSubagent[];
  usageAccumulator: ProviderUsageAccumulator;
};

export async function createDeepAgentSession(input: {
  agentService: Pick<AgentService, 'getCapabilityPreview'>;
  context: RunExecutionContext;
  fileService: FileService;
  getCheckpointer: () => BaseCheckpointSaver;
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
  const interruptOn =
    input.context.taskRun === null
      ? undefined
      : input.agentService.getCapabilityPreview(input.context.enabledCapabilities).interruptOn;
  const runTools = await createRunTools({
    closers,
    enabledCapabilities: input.context.enabledCapabilities,
    fileService: input.fileService,
    mcpService: input.mcpService,
    taskSchedulerService: input.taskSchedulerService,
    taskService: input.taskService,
    webReadService: input.webReadService
  });
  const runtimeBackend = createBackend({
    workspaceService: input.workspaceService,
    paths: input.paths,
    shellExecutionService: input.shellExecutionService,
    store: input.store,
    selectedSkillIds: input.context.enabledCapabilities.skills
  });
  const workspace = input.workspaceService.getCurrentWorkspace();
  const skillSources = input.context.enabledCapabilities.skills.length === 0 ? [] : ['/skills/'];
  const subagents = tools.createRunSubagents({
    webReadTool: runTools.webReadTool
  });
  const agent = buildDeepAgent({
    model: input.context.modelHandle.model,
    systemPrompt: prompt.buildSystemPrompt({
      enabledCapabilities: input.context.enabledCapabilities,
      workspacePath: workspace?.path ?? null
    }),
    backend: runtimeBackend.backend,
    store: input.store,
    memorySources: ['/agents/AGENTS.md'],
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
  taskSchedulerService: TaskSchedulerService;
  taskService: TaskService;
  webReadService: WebReadService;
}): Promise<{
  tools: ClientTool[];
  webReadTool: ReturnType<typeof tools.createWebReadTool>;
}> {
  const webReadTool = tools.createWebReadTool(input.webReadService);
  const deleteFileTool = tools.createDeleteFileTool(input.fileService);
  const backgroundTaskTools = createBackgroundTaskTools({
    taskService: input.taskService,
    schedulerService: input.taskSchedulerService,
    enabledCapabilities: input.enabledCapabilities
  });
  const runTools: ClientTool[] = [webReadTool, deleteFileTool, ...backgroundTaskTools];
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
