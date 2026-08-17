import type { ChatRunEvent } from '../../../shared/types';
import type { PendingInterrupt } from './interrupt-projection';

export type AgentDeepAgentExecutionOutcome =
  | {
      status: 'completed';
    }
  | {
      status: 'interrupted';
      interrupts: PendingInterrupt[];
    };

export type AgentDeepAgentExecution = {
  events: AsyncIterable<ChatRunEvent>;
  outcome: Promise<AgentDeepAgentExecutionOutcome>;
};

export function createAgentDeepAgentExecution(input: {
  events: AsyncIterable<ChatRunEvent>;
  outcome: AgentDeepAgentExecutionOutcome | Promise<AgentDeepAgentExecutionOutcome>;
}): AgentDeepAgentExecution {
  const outcome = Promise.resolve(input.outcome);
  void outcome.catch(() => undefined);
  return {
    events: input.events,
    outcome
  };
}
