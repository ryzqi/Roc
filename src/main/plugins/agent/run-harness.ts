import type { BaseCheckpointSaver, BaseStore } from '@langchain/langgraph';
import type { ClientTool } from '@langchain/core/tools';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { GENERAL_PURPOSE_SUBAGENT } from 'deepagents';
import { z } from 'zod';

import type {
  AppSettings,
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  ChatRunEvent,
  FileDeleteResult,
  RunCapabilityManifestV1,
  RunExecutionSnapshotV2,
  ShellConfirmationRequest,
  ShellConfirmationResult,
  TaskDetail,
  TaskRun,
  UpdateBackgroundTaskRequest,
  Workspace
} from '../../../shared/types';
import type { RocCapabilityRegistry } from '../../kernel/types';
import { buildDeepAgent } from '../../services/deep-agent/agent-builder';
import { createRunSubagents } from '../../services/deep-agent/subagents';
import { PreviewStore } from '../../services/forge-guardrails';
import { defaultSettings } from '../../services/config/defaults';
import type { WebReadExecutionRequest, WebReadRequest, WebReadResult } from '../../services/web-read-service';
import { webReadToolSchema } from '../../services/web-read-request-schema';
import type { RocPaths } from '../../services/paths';
import { createBackgroundTaskTools } from '../../services/deep-agent/background-task-tools';
import { createResolveBackgroundTaskTimeTool } from '../../services/deep-agent/background-task-time-tool';
import { createBackend } from '../../services/deep-agent/backend';
import { createAskUserTool } from '../../services/deep-agent/ask-user-tool';
import { toWorkspaceRelativePath } from '../../services/deep-agent/filesystem-tool-contract';
import { createRocWindowsCommandTool } from '../../services/deep-agent/command-tool';
import { assembleContextHarness } from '../../services/deep-agent/context/context-assembler';
import type { ContextArtifactStore } from '../../services/deep-agent/context/context-artifact-store';
import type {
  ContextMaintenanceEvent,
  PreCompactionFlushRecorder
} from '../../services/deep-agent/context/context-compaction-pipeline';
import {
  createContextTokenCounter,
  deriveContextBudgetProfile
} from '../../services/deep-agent/context/context-token-budget';
import type { ContextBudgetProfile, ContextToolDefinition } from '../../services/deep-agent/context/context-token-budget';
import { loadExplicitSkillContexts } from '../../services/deep-agent/context/explicit-skills';
import { loadReferencedFileContexts } from '../../services/deep-agent/context/referenced-files';
import type { AgentToolEffectStore } from '../../services/deep-agent/tool-effect-store';
import type { AgentExecuteAdapter, StringDynamicStructuredTool } from '../../services/deep-agent/types';
import type { HookRuntime } from '../../services/hooks';
import type { LangChainChatModelHandle } from '../../services/langchain-model-factory';
import { CapacityService } from '../../services/memory/capacity';
import { SecurityScanService } from '../../services/memory/security-scan';
import type { SelfConfigDryRunConfirmRequest, SelfConfigService } from '../../services/self-config';

export type RunHarnessServices = {
  capabilities: RocCapabilityRegistry;
  checkpointer: BaseCheckpointSaver;
  contextArtifactStore: ContextArtifactStore;
  getMemorySettings?: () => AppSettings['memory'];
  hookRuntime?: Pick<HookRuntime, 'runEvent'>;
  paths: RocPaths;
  selfConfigService?: SelfConfigService;
  sessionHistory: PreCompactionFlushRecorder;
  store: BaseStore;
  toolEffectStore: AgentToolEffectStore;
};

export type RunHarnessRequest = {
  abortSignal: AbortSignal;
  /** harness 装配期间产生的事件（hook 事件、上下文维护事件）由调用方的事件通道接走。 */
  emitRuntimeEvent: (event: ChatRunEvent) => void;
  modelHandle: { langChainHandle?: LangChainChatModelHandle; modelId: string };
  run: TaskRun;
  snapshot: RunExecutionSnapshotV2;
};

/** SessionStart hook 可以拦掉整轮运行，所以装配结果是"可跑"与"被拦"两态，而不是一个可能半成品的对象。 */
export type RunHarness =
  | { kind: 'blocked'; reason: string }
  | {
      kind: 'ready';
      agent: ReturnType<typeof buildDeepAgent>;
      /** 指标与事件按来源分流：后台任务与主聊天分开统计。 */
      source: 'chat' | 'background_task';
      workspaceHash: string | null;
    };

/**
 * 把一轮运行需要的全部执行面装配起来：工具集、上下文 harness、预算画像、运行时 backend、
 * 子代理、hook 接线，最后交出一个可 `streamEvents` 的 agent。
 *
 * 调用方只需要知道两件事：装配可能被 SessionStart hook 拦掉，以及成功后拿到的 agent 已经接好一切。
 * 工具定序、预算取最保守画像、manifest 授权过滤这些不变量都留在这里面。
 */
export async function buildRunHarness(
  services: RunHarnessServices,
  request: RunHarnessRequest
): Promise<RunHarness> {
  const handle = request.modelHandle.langChainHandle;
  if (handle === undefined) {
    throw new Error('agent_deep_agent_model_handle_missing');
  }
  const mode = request.snapshot.mode;
  const workflowHint = request.snapshot.workflowHint;
  const runtimeWorkspace = createWorkspaceFromSnapshot(request.snapshot);
  requireWorkbenchSourceForBackgroundTaskWorkflow(request.snapshot);
  const source = isBackgroundTaskWorkflow(request.snapshot) ? ('background_task' as const) : ('chat' as const);
  const hookRunContext = {
    runId: request.run.id,
    threadId: request.run.threadId,
    workspacePath: runtimeWorkspace === null ? null : runtimeWorkspace.path,
    cwd: runtimeWorkspace === null ? services.paths.root : runtimeWorkspace.path,
    source,
    modelId: request.modelHandle.modelId,
    workflowHint
  };
  const shellAllowedCommands = request.snapshot.shellAllowedCommands;
  const shellExecutionService = createShellExecutionAdapter({
    capabilities: services.capabilities,
    defaultCwd: runtimeWorkspace === null ? null : runtimeWorkspace.path,
    allowedCommands: shellAllowedCommands,
    abortSignal: request.abortSignal,
    runId: request.run.id,
    threadId: request.run.threadId
  });
  const tools = await createExecutorTools({
    capabilities: services.capabilities,
    capabilityManifest: request.snapshot.capabilityManifest,
    enabledCapabilities: request.snapshot.capabilityManifest.resolvedCapabilities,
    runtimeWorkspacePath: runtimeWorkspace === null ? null : runtimeWorkspace.path,
    selfConfigService: services.selfConfigService,
    shellExecutionService,
    shellAllowedCommands,
    mode
  });
  const explicitSkillContexts = loadExplicitSkillContexts({
    explicitSkillIds: request.snapshot.explicitSkillIds,
    manifestSkills: request.snapshot.capabilityManifest.skills
  });
  const referencedFileContexts = loadReferencedFileContexts({
    userInput: request.run.userInput,
    workspacePath: runtimeWorkspace?.path ?? null
  });
  const runtimeBackend = createRuntimeBackend({
    capabilities: services.capabilities,
    getMemorySettings: services.getMemorySettings,
    handle,
    paths: services.paths,
    selectedSkillIds: [
      ...request.snapshot.capabilityManifest.resolvedCapabilities.skills,
      ...explicitSkillContexts.map((skill) => skill.id)
    ],
    store: services.store,
    workspace: runtimeWorkspace
  });
  const mainManifestToolNames = request.snapshot.capabilityManifest.tools
    .filter((tool) => tool.executionScopes.includes('main'))
    .map((tool) => tool.modelVisibleName);
  const contextHarness = assembleContextHarness({
    artifactStore: services.contextArtifactStore,
    mode,
    enabledCapabilities: request.snapshot.capabilityManifest.resolvedCapabilities,
    workflowHint,
    workspacePath: runtimeWorkspace === null ? null : runtimeWorkspace.path,
    memorySources: runtimeBackend.memorySources,
    baseTools: tools.runTools,
    allowedToolNames: mainManifestToolNames,
    searchSessions: request_ => services.capabilities.invoke('agent.sessions.search', request_),
    searchMemory: request_ => services.capabilities.invoke('memory.entries.search', request_),
    remember: request_ => services.capabilities.invoke('memory.entry.remember', request_),
    runId: request.run.id,
    threadId: request.run.threadId,
    explicitSkillContexts,
    referencedFileContexts
  });
  const contextWindowTokens = request.snapshot.budget.contextBudgetTokens;
  if (contextWindowTokens === null) {
    throw new Error('agent_context_budget_missing');
  }
  const contextTokenCounter = createContextTokenCounter(handle.model);
  const runSubagents = createRunSubagents({ webReadTool: tools.webReadTool });
  const contextBudgetProfile = await deriveConservativeContextBudgetProfile({
    contextWindowTokens,
    counter: contextTokenCounter,
    mainSystemPrompt: contextHarness.systemPrompt,
    subagents: runSubagents,
    tools: contextHarness.tools
  });
  const initialHookContexts = await runSessionStartHook({
    services,
    request,
    hookRunContext
  });
  if (initialHookContexts.kind === 'blocked') {
    return initialHookContexts;
  }
  const agent = buildDeepAgent({
    snapshot: request.snapshot,
    model: handle.model,
    systemPrompt: contextHarness.systemPrompt,
    backend: runtimeBackend.backend,
    store: services.store,
    memorySources: contextHarness.memorySources,
    skillSources: contextHarness.skillSources,
    subagents: runSubagents,
    tools: contextHarness.tools,
    checkpointer: services.checkpointer,
    contextCompaction: {
      artifactStore: services.contextArtifactStore,
      artifactRecoveryEnabled: mainManifestToolNames.includes('read_context_artifact'),
      budgetProfile: contextBudgetProfile,
      emitEvent: (event) => emitContextMaintenanceEvent(request, mode, event),
      sessionHistory: services.sessionHistory,
      tokenCounter: contextTokenCounter
    },
    toolEffectStore: services.toolEffectStore,
    hookMiddleware:
      services.hookRuntime === undefined
        ? undefined
        : {
            hookRuntime: services.hookRuntime,
            runContext: hookRunContext,
            emitHookEvent: request.emitRuntimeEvent,
            initialContexts: initialHookContexts.contexts,
            signal: request.abortSignal
          }
  });
  return {
    kind: 'ready',
    agent,
    source,
    workspaceHash: contextHarness.workspaceIdentity === null ? null : contextHarness.workspaceIdentity.hash
  };
}

function emitContextMaintenanceEvent(
  request: RunHarnessRequest,
  mode: RunExecutionSnapshotV2['mode'],
  event: ContextMaintenanceEvent
): void {
  request.emitRuntimeEvent({
    type: 'context_maintenance',
    runId: request.run.id,
    threadId: request.run.threadId,
    event: event.type,
    mode,
    stage: event.stage,
    ...(event.persistedChars === undefined ? {} : { persistedChars: event.persistedChars }),
    ...(event.removedChars === undefined ? {} : { removedChars: event.removedChars }),
    ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
    ...(event.budgetTokens === undefined ? {} : { budgetTokens: event.budgetTokens }),
    ...(event.estimated === undefined ? {} : { estimated: event.estimated })
  });
}

async function runSessionStartHook(input: {
  services: RunHarnessServices;
  request: RunHarnessRequest;
  hookRunContext: {
    cwd: string;
    modelId: string;
    source: 'chat' | 'background_task';
    workflowHint: RunExecutionSnapshotV2['workflowHint'];
    workspacePath: string | null;
  };
}): Promise<{ kind: 'ready'; contexts: string[] } | { kind: 'blocked'; reason: string }> {
  const hookRuntime = input.services.hookRuntime;
  if (hookRuntime === undefined) {
    return { kind: 'ready', contexts: [] };
  }
  const sessionStart = await hookRuntime.runEvent({
    schemaVersion: 1,
    event: 'SessionStart',
    runId: input.request.run.id,
    threadId: input.request.run.threadId,
    workspacePath: input.hookRunContext.workspacePath,
    cwd: input.hookRunContext.cwd,
    triggeredAt: new Date().toISOString(),
    payload: {
      source: input.hookRunContext.source,
      modelId: input.hookRunContext.modelId,
      workflowHint: input.hookRunContext.workflowHint
    }
  }, {
    signal: input.request.abortSignal
  });
  for (const event of sessionStart.events) {
    input.request.emitRuntimeEvent(event);
  }
  if (sessionStart.blocked) {
    return {
      kind: 'blocked',
      reason: sessionStart.blockReason === null ? 'Blocked by SessionStart hook.' : sessionStart.blockReason
    };
  }
  return { kind: 'ready', contexts: [...sessionStart.additionalContexts] };
}

/**
 * 主 agent 与每个子代理各有自己的系统提示，因此各有自己的输入预算；取最小的那份，
 * 保证任何一条执行路径都不会超出。
 */
async function deriveConservativeContextBudgetProfile(input: {
  contextWindowTokens: number;
  counter: ReturnType<typeof createContextTokenCounter>;
  mainSystemPrompt: string;
  subagents: ReturnType<typeof createRunSubagents>;
  tools: readonly ClientTool[];
}): Promise<ContextBudgetProfile> {
  const contextTools = input.tools.map((tool): ContextToolDefinition => {
    if (typeof tool.description !== 'string') {
      throw new Error(`agent_tool_description_missing:${tool.name}`);
    }
    return {
      name: tool.name,
      description: tool.description,
      schema: Reflect.get(tool, 'schema')
    };
  });
  const profiles = await Promise.all([
    deriveContextBudgetProfile({
      contextWindowTokens: input.contextWindowTokens,
      counter: input.counter,
      systemPrompt: input.mainSystemPrompt,
      tools: contextTools
    }),
    deriveContextBudgetProfile({
      contextWindowTokens: input.contextWindowTokens,
      counter: input.counter,
      systemPrompt: GENERAL_PURPOSE_SUBAGENT.systemPrompt,
      tools: contextTools
    }),
    ...input.subagents.map((subagent) => {
      if (!('systemPrompt' in subagent) || typeof subagent.systemPrompt !== 'string') {
        throw new Error(`agent_subagent_system_prompt_missing:${subagent.name}`);
      }
      return deriveContextBudgetProfile({
        contextWindowTokens: input.contextWindowTokens,
        counter: input.counter,
        systemPrompt: subagent.systemPrompt,
        tools: contextTools
      });
    })
  ]);
  const first = profiles[0];
  if (first === undefined) {
    throw new Error('agent_context_budget_profile_missing');
  }
  return profiles.slice(1).reduce(
    (selected, candidate) => candidate.modelInputTokens < selected.modelInputTokens ? candidate : selected,
    first
  );
}

function createWorkspaceFromSnapshot(snapshot: RunExecutionSnapshotV2): Workspace | null {
  if (snapshot.workspace === null) {
    return null;
  }
  return {
    id: 'snapshot-workspace',
    path: snapshot.workspace.path,
    displayName: snapshot.workspace.path,
    lastOpenedAt: new Date().toISOString(),
    trustState: 'trusted'
  };
}

/**
 * 工具顺序决定它们在模型工具清单里的先后。这里按语义分组显式声明：
 * 网络与提问在前，后台任务其次，文件与自省居中，shell 与 MCP 在后。
 * 缺席的组直接空数组，不影响其余组的相对次序。
 */
async function createExecutorTools(input: {
  capabilities: RocCapabilityRegistry;
  capabilityManifest: RunCapabilityManifestV1;
  enabledCapabilities: TaskRun['enabledCapabilities'];
  runtimeWorkspacePath: string | null;
  selfConfigService?: SelfConfigService;
  shellExecutionService: AgentExecuteAdapter;
  shellAllowedCommands?: readonly string[];
  mode: RunExecutionSnapshotV2['mode'];
}): Promise<{ runTools: ClientTool[]; webReadTool: StringDynamicStructuredTool }> {
  const webReadTool = createWebReadTool(input.capabilities);
  const askUserTool = createAskUserTool();
  const mcpTools = await loadSelectedMcpTools(input.capabilities, input.capabilityManifest);
  if (input.mode === 'plan') {
    return { runTools: [webReadTool, askUserTool, ...mcpTools], webReadTool };
  }
  const manifestToolNames = new Set(input.capabilityManifest.tools.map((tool) => tool.modelVisibleName));
  const shellTools = manifestToolNames.has('run_shell_command')
    && (input.shellAllowedCommands === undefined || input.shellAllowedCommands.length > 0)
    ? [createRocWindowsCommandTool(input.shellExecutionService)]
    : [];
  const selfConfigTools = manifestToolNames.has('roc_self_config')
    ? [createSelfConfigTool({
        capabilities: input.capabilities,
        selfConfigService: requireSelfConfigService(input.selfConfigService),
        runtimeWorkspacePath: input.runtimeWorkspacePath
      })]
    : [];
  return {
    runTools: [
      webReadTool,
      askUserTool,
      ...createManifestAuthorizedBackgroundTaskTools(input),
      createDeleteFileTool(input.capabilities),
      ...selfConfigTools,
      ...shellTools,
      ...mcpTools
    ],
    webReadTool
  };
}

function requireSelfConfigService(selfConfigService: SelfConfigService | undefined): SelfConfigService {
  if (selfConfigService === undefined) {
    throw new Error('run_capability_self_config_service_missing');
  }
  return selfConfigService;
}

function createManifestAuthorizedBackgroundTaskTools(input: {
  capabilities: RocCapabilityRegistry;
  capabilityManifest: RunCapabilityManifestV1;
  enabledCapabilities: TaskRun['enabledCapabilities'];
  runtimeWorkspacePath: string | null;
}): ClientTool[] {
  const previewStore = new PreviewStore();
  const taskAdapter = {
    createBackgroundTaskPreview: async (request: BackgroundTaskPreviewRequest) =>
      await input.capabilities.invoke<BackgroundTaskPreviewRequest, BackgroundTaskPreview>('task.background.preview', request),
    createBackgroundTask: async (request: BackgroundTaskPreviewRequest) =>
      await input.capabilities.invoke<BackgroundTaskPreviewRequest, BackgroundTask>('task.background.create', request),
    readBackgroundTask: async (taskId: string) =>
      await input.capabilities.invoke<{ taskId: string }, TaskDetail>('task.detail.get', { taskId }),
    updateBackgroundTask: async (request: UpdateBackgroundTaskRequest) =>
      await input.capabilities.invoke<UpdateBackgroundTaskRequest, BackgroundTask>('task.background.update', request),
    cancelBackgroundTask: async (taskId: string) =>
      await input.capabilities.invoke<{ id: string }, BackgroundTask>('task.background.cancel', { id: taskId })
  };
  const schedulerAdapter = {
    refreshTask: () => {},
    registerTask: () => {},
    unregisterTask: () => {}
  };
  const toolDependencies = {
    enabledCapabilities: input.enabledCapabilities,
    previewStore,
    runtimeWorkspacePath: input.runtimeWorkspacePath,
    taskAdapter,
    schedulerAdapter
  };
  const candidates: ClientTool[] = [
    createResolveBackgroundTaskTimeTool(),
    ...createBackgroundTaskTools({ ...toolDependencies, toolMode: 'all' }),
    ...createBackgroundTaskTools({ ...toolDependencies, toolMode: 'change' })
  ];
  const manifestToolNames = new Set(input.capabilityManifest.tools.map((tool) => tool.modelVisibleName));
  const seenToolNames = new Set<string>();
  return candidates.filter((tool) => {
    if (!manifestToolNames.has(tool.name)) {
      return false;
    }
    if (seenToolNames.has(tool.name)) {
      return false;
    }
    seenToolNames.add(tool.name);
    return true;
  });
}

async function loadSelectedMcpTools(
  capabilities: RocCapabilityRegistry,
  capabilityManifest: RunCapabilityManifestV1
): Promise<ClientTool[]> {
  const selectedTools = capabilityManifest.tools.filter((tool) => tool.provenance.kind === 'mcp');
  if (selectedTools.length === 0) {
    return [];
  }
  const tools = await capabilities.invoke<{}, unknown[]>('mcp.tools.get', {});
  return tools.flatMap((tool): ClientTool[] => {
    if (!isClientTool(tool)) {
      return [];
    }
    const modelVisibleName = resolveManifestMcpToolName(tool.name, selectedTools);
    if (modelVisibleName === null) {
      return [];
    }
    tool.name = modelVisibleName;
    return [tool];
  });
}

function isBackgroundTaskWorkflow(snapshot: RunExecutionSnapshotV2): boolean {
  return snapshot.workflowHint === 'propose_background_task' || snapshot.workflowHint === 'background_task_change';
}

function requireWorkbenchSourceForBackgroundTaskWorkflow(snapshot: RunExecutionSnapshotV2): void {
  if (!isBackgroundTaskWorkflow(snapshot)) {
    return;
  }
  if (snapshot.runOrigin !== 'workbench_creation') {
    throw new Error('background_task_workbench_source_required');
  }
}

function isClientTool(value: unknown): value is ClientTool {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'name') === 'string';
}

function resolveManifestMcpToolName(
  runtimeName: string,
  selectedTools: RunCapabilityManifestV1['tools']
): string | null {
  for (const tool of selectedTools) {
    if (tool.provenance.kind !== 'mcp') {
      continue;
    }
    if (tool.provenance.serverId === 'exa-hosted' && isExaHostedWebSearchName(runtimeName)) {
      return tool.modelVisibleName === 'web_search' ? tool.modelVisibleName : null;
    }
    if (runtimeName === `${tool.provenance.serverId}__${tool.modelVisibleName}`) {
      return tool.modelVisibleName;
    }
  }
  return null;
}

function isExaHostedWebSearchName(name: string): boolean {
  return (
    name === 'web_search' ||
    name === 'web_search_exa' ||
    name === 'web_search_advanced_exa' ||
    name === 'exa-hosted__web_search_exa' ||
    name === 'exa-hosted__web_search_advanced_exa'
  );
}

function createWebReadTool(capabilities: RocCapabilityRegistry): StringDynamicStructuredTool {
  const schema = webReadToolSchema;
  return new DynamicStructuredTool<typeof schema, WebReadRequest, WebReadRequest, string>({
    name: 'web_read',
    description: '读取公开网页正文，返回来源、Jina 代理、抓取时间、内容哈希、不可信标记与正文。',
    schema,
    func: async (request, _runManager, config) => {
      const result = await capabilities.invoke<WebReadExecutionRequest, WebReadResult>('web.read', {
        ...request,
        signal: config?.signal
      });
      return JSON.stringify(result, null, 2);
    }
  });
}

const selfConfigToolSchema = z.object({
  action: z.enum(['describe', 'read', 'validate', 'dry_run']),
  config: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  handlerId: z.string().trim().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional()
});

type SelfConfigToolRequest = z.infer<typeof selfConfigToolSchema>;

function createSelfConfigTool(input: {
  capabilities: RocCapabilityRegistry;
  selfConfigService: SelfConfigService;
  runtimeWorkspacePath: string | null;
}): StringDynamicStructuredTool {
  const schema = selfConfigToolSchema;
  return new DynamicStructuredTool<typeof schema, SelfConfigToolRequest, SelfConfigToolRequest, string>({
    name: 'roc_self_config',
    description:
      '只读自省 Roc 自身配置：describe 返回 ~/.roc 路径表、hooks.json JSON Schema、事件与 action 矩阵、hook 运行契约；read 返回当前 hooks.json 快照（含 trustState）与脱敏后的 settings；validate 校验一份 hooks 配置并给出格式修正提示（不落盘）；dry_run 试跑 hooks.json 里已存在的某条 handler（需 handlerId，会先弹宿主确认）并返回 stdout / stderr / 退出码。配置落盘与信任必须由用户在设置页完成。',
    schema,
    func: async (request) => {
      const result = await executeSelfConfigAction({ ...input, request });
      return JSON.stringify(result, null, 2);
    }
  });
}

async function executeSelfConfigAction(input: {
  capabilities: RocCapabilityRegistry;
  selfConfigService: SelfConfigService;
  runtimeWorkspacePath: string | null;
  request: SelfConfigToolRequest;
}): Promise<unknown> {
  if (input.request.action === 'describe') {
    return input.selfConfigService.describe();
  }
  if (input.request.action === 'read') {
    return await input.selfConfigService.read();
  }
  if (input.request.action === 'validate') {
    if (input.request.config === undefined) {
      throw new Error('roc_self_config_validate_config_required');
    }
    return input.selfConfigService.validate(input.request.config);
  }
  const handlerId = input.request.handlerId;
  if (handlerId === undefined) {
    throw new Error('roc_self_config_dry_run_handler_id_required');
  }
  return await input.selfConfigService.dryRun({
    handlerId,
    payload: input.request.payload,
    ...(input.runtimeWorkspacePath === null ? {} : { cwd: input.runtimeWorkspacePath }),
    confirm: async (confirmRequest) => await confirmSelfConfigDryRun(input.capabilities, confirmRequest)
  });
}

async function confirmSelfConfigDryRun(
  capabilities: RocCapabilityRegistry,
  request: SelfConfigDryRunConfirmRequest
): Promise<boolean> {
  const result = await capabilities.invoke<ShellConfirmationRequest, ShellConfirmationResult>('shell.confirm', {
    title: 'Roc hook 试跑确认',
    message: [
      `即将在宿主机试跑 hook handler ${request.handlerId}（${request.event}）：`,
      request.command,
      `cwd: ${request.cwd}`,
      `超时: ${request.timeoutSeconds}s`,
      `handler 状态: ${request.enabled ? '已启用' : '已禁用'} / 信任 ${request.trustState}`,
      ...(request.enabled && request.trustState === 'trusted'
        ? []
        : ['注意：该 handler 在真实运行中会被跳过，试跑只是手动执行这条命令。'])
    ].join('\n'),
    confirmLabel: '试跑',
    cancelLabel: '取消'
  });
  return result.confirmed;
}

function createDeleteFileTool(capabilities: RocCapabilityRegistry): StringDynamicStructuredTool {
  const schema = z.object({
    file_path: z.string().trim().min(1)
  });
  return new DynamicStructuredTool<typeof schema, { file_path: string }, { file_path: string }, string>({
    name: 'delete_file',
    description: '删除 /workspace/... 下的文件或空目录，会先写入恢复点；仅当确实需要删除目标时使用。',
    schema,
    func: async (request) => {
      const relativePath = toWorkspaceRelativePath(request.file_path);
      if (!relativePath.ok) {
        throw new Error(relativePath.error);
      }
      return JSON.stringify(
        await capabilities.invoke<{ relativePath: string }, FileDeleteResult>('files.delete', {
          relativePath: relativePath.relativePath
        }),
        null,
        2
      );
    }
  });
}

function createRuntimeBackend(input: {
  capabilities: RocCapabilityRegistry;
  getMemorySettings?: () => AppSettings['memory'];
  handle: LangChainChatModelHandle;
  paths: RocPaths;
  selectedSkillIds: readonly string[];
  store: BaseStore;
  workspace: Workspace | null;
}): ReturnType<typeof createBackend> {
  const workspaceService = {
    getCurrentWorkspace: () =>
      input.workspace === null
        ? null
        : {
            path: input.workspace.path,
            label: input.workspace.displayName
          }
  };
  const memorySettings = input.getMemorySettings === undefined ? defaultSettings.memory : input.getMemorySettings();
  return createBackend({
    workspaceService: workspaceService as Parameters<typeof createBackend>[0]['workspaceService'],
    paths: input.paths,
    store: input.store,
    securityScan: new SecurityScanService(memorySettings.securityScan),
    capacity: new CapacityService(memorySettings.charLimits),
    selectedSkillIds: input.selectedSkillIds
  });
}

function createShellExecutionAdapter(input: {
  capabilities: RocCapabilityRegistry;
  defaultCwd: string | null;
  allowedCommands?: readonly string[];
  abortSignal: AbortSignal;
  runId: string;
  threadId: string;
}): AgentExecuteAdapter {
  return {
    executeAgentCommand: async ({ command, cwd }) => {
      const requestCwd = cwd === undefined ? input.defaultCwd : cwd;
      if (requestCwd === null) {
        throw new Error('agent_workspace_required_for_shell');
      }
      const result = await input.capabilities.invoke<
        import('../../../shared/types').ShellExecutionRequest,
        import('../../../shared/types').ShellExecutionResult
      >('shell.execute', {
        command,
        cwd: requestCwd,
        source: 'agent',
        signal: input.abortSignal,
        runId: input.runId,
        threadId: input.threadId,
        allowedCommands: input.allowedCommands === undefined ? undefined : [...input.allowedCommands]
      });
      return {
        command: result.command,
        cwd: result.cwd,
        exitCode: result.exitCode,
        output: formatShellOutput(result),
        truncated: result.truncated === true,
        usedRtk: result.usedRtk,
        bypassReason: result.bypassReason
      };
    }
  };
}

function formatShellOutput(result: import('../../../shared/types').ShellExecutionResult): string {
  const output = [result.stdout, result.stderr].filter((value) => value.length > 0).join('\n');
  if (output.length === 0) {
    return `<no output>\n\nExit code: ${result.exitCode}`;
  }
  return result.exitCode === 0 ? output : `${output.trimEnd()}\n\nExit code: ${result.exitCode}`;
}
