import type { ChatRunEvent } from '../../../shared/types';
import type { PendingInterrupt } from './interrupt-projection';
import type { AgentModelUsageTelemetry } from './run-telemetry';

export type RunOutcome =
  | {
      status: 'completed';
      finalMessage: string;
      summarySource: {
        successfulToolNames: string[];
      };
      usage: AgentModelUsageTelemetry;
    }
  | {
      status: 'interrupted';
      interrupts: PendingInterrupt[];
      usage: AgentModelUsageTelemetry;
    };

export type AgentDeepAgentExecution = {
  events: AsyncIterable<ChatRunEvent>;
  outcome: Promise<RunOutcome>;
};

export function createAgentDeepAgentExecution(input: {
  events: AsyncIterable<ChatRunEvent>;
  outcome: RunOutcome | Promise<RunOutcome>;
}): AgentDeepAgentExecution {
  const outcome = Promise.resolve(input.outcome);
  void outcome.catch(() => undefined);
  return {
    events: input.events,
    outcome
  };
}
