import type {
  ChatInterruptPayload,
  ChatRunEvent,
  ChatStartRunRequest,
  RocHookSessionEndStatus
} from '../../../shared/types';

export type DeepAgentExecutionResult =
  | {
      status: 'completed';
      assistantMessage: string;
      successfulToolNames: string[];
    }
  | {
      status: 'interrupted';
      interrupts: PendingInterrupt[];
      events: Array<Extract<ChatRunEvent, { type: 'run_interrupted' }>>;
    };

export type PendingInterrupt = {
  interruptId: string;
  payload: ChatInterruptPayload;
};

export type PendingInterruptProjection = {
  runId: string;
  threadId: string;
  interrupts: PendingInterrupt[];
};

export type AgentLifecycleHookEmitter = {
  emitSessionEnd(input: {
    runId: string;
    threadId: string | null;
    request: ChatStartRunRequest;
    signal: AbortSignal;
    status: RocHookSessionEndStatus;
    error: string | null;
  }): Promise<void>;
};

export type AgentRunTracingLifecycle = {
  finishRun(input: {
    runId: string;
    status: 'cancelled' | 'completed' | 'failed' | 'interrupted';
    error: string | null;
  }): Promise<void>;
  shutdown(): Promise<void>;
};
