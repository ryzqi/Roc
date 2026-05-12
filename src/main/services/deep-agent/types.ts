import type { DynamicStructuredTool } from '@langchain/core/tools';
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

export type MemoryGetRequest = {
  id: string;
};

export type RuntimeSubagent = {
  name: string;
  description: string;
  systemPrompt: string;
  tools: Array<DynamicStructuredTool<any, any, any, string>>;
};

export const RUN_EVENT_NAME = 'run-event';
