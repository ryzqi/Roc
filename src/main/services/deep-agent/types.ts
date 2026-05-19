import type { SubAgent } from 'deepagents';
import type {
  ChatStartRunRequest,
  TaskRun
} from '../../../shared/types';
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
};

export type RunExecutionContext = ActiveRun & {
  input: string;
  startedAtMs: number;
};

export type RunFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

export type RuntimeSubagent = SubAgent;

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
