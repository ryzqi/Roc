import type { ExecuteResponse, SubAgent } from 'deepagents';
import type {
  ChatStartRunRequest,
  ShellExecutionResult,
  TaskRun,
  WorkflowHint
} from '../../../shared/types';
import type { PreviewStore } from '../forge-guardrails';
import type { LangChainChatModelHandle } from '../langchain-model-factory';

export type ActiveRun = {
  abortController: AbortController;
  createdAt: string;
  enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
  modelHandle: LangChainChatModelHandle;
  mode: ChatStartRunRequest['mode'];
  runId: string;
  taskRun: TaskRun | null;
  threadId: string;
  workflowHint: WorkflowHint;
};

export type RunExecutionContext = ActiveRun & {
  agentInput: string;
  input: string;
  previewStore?: PreviewStore;
  startedAtMs: number;
  traceId: string;
};

export type RunFailure = {
  code: string;
  diagnostic?: {
    badKeys?: string[];
    schemaPath?: string;
    toolName?: string;
  };
  message: string;
  retryable: boolean;
  suggestion?: string;
};

export type RuntimeSubagent = SubAgent;

export type AgentExecuteAdapter = {
  executeAgentCommand(input: { command: string; cwd?: string }): Promise<
    ExecuteResponse & {
      command: string;
      cwd: string;
      usedRtk: boolean;
      bypassReason?: ShellExecutionResult['bypassReason'];
    }
  >;
};

/**
 * deepagents 默认装配的内置工具名单一来源（write_todos/task + 文件系统 7 件）。
 * deepagents 未导出对应常量，故在此集中维护；agent-builder 等处一律引用本常量，
 * 不得再各自硬编码。漂移由 deep-agent-official-contracts.test.ts 的守卫用例兜底。
 */
export const DEEP_AGENT_BUILT_IN_TOOLS = [
  'write_todos',
  'task',
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'execute'
] as const;

export const RUN_EVENT_NAME = 'run-event';
