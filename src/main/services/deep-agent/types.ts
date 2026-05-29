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
  input: string;
  previewStore?: PreviewStore;
  startedAtMs: number;
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
