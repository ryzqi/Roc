import type { ChatRunEvent, ChatStartRunRequest, RocHookSessionEndStatus } from '../../../shared/types';
import type { RunOutcome } from './agent-execution';

export type DeepAgentExecutionResult =
  | Extract<RunOutcome, { status: 'completed' }>
  | (Extract<RunOutcome, { status: 'interrupted' }> & {
      events: Array<Extract<ChatRunEvent, { type: 'run_interrupted' }>>;
    });

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
