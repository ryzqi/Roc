import type { ChatInterruptPayload, ChatStartRunRequest, RocHookSessionEndStatus } from '../../../shared/types';

export type DeepAgentExecutionResult =
  | {
      status: 'completed';
      assistantMessage: string;
      successfulToolNames: string[];
    }
  | {
      status: 'interrupted';
    };

export type PendingInterrupt = {
  interruptId: string;
  payload: ChatInterruptPayload;
};

export type AgentLifecycleHookEmitter = {
  emitSessionEnd(input: {
    runId: string;
    threadId: string | null;
    request: ChatStartRunRequest;
    status: RocHookSessionEndStatus;
    error: string | null;
  }): Promise<void>;
};
