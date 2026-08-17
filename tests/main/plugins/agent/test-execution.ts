import type { ChatRunEvent } from '../../../../src/shared/types';
import type { AgentDeepAgentExecution, RunOutcome } from '../../../../src/main/plugins/agent/agent-execution';
import type { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';

export function createTestAgentExecution(
  factory: () => AsyncIterable<ChatRunEvent>,
  outcome: RunOutcome | Promise<RunOutcome>
): AgentDeepAgentExecution {
  const settledOutcome = Promise.resolve(outcome);
  void settledOutcome.catch(() => undefined);
  return { events: factory(), outcome: settledOutcome };
}

export function completedTestOutcome(input: {
  finalMessage: string;
  successfulToolNames?: string[];
  usage?: RunOutcome['usage'];
}): Extract<RunOutcome, { status: 'completed' }> {
  return {
    status: 'completed',
    finalMessage: input.finalMessage,
    summarySource: {
      successfulToolNames: input.successfulToolNames === undefined ? [] : [...input.successfulToolNames]
    },
    usage: input.usage === undefined ? emptyTestUsage() : input.usage
  };
}

export function interruptedTestOutcome(input: {
  interrupts: Extract<RunOutcome, { status: 'interrupted' }>['interrupts'];
  usage?: RunOutcome['usage'];
}): Extract<RunOutcome, { status: 'interrupted' }> {
  return {
    status: 'interrupted',
    interrupts: [...input.interrupts],
    usage: input.usage === undefined ? emptyTestUsage() : input.usage
  };
}

export function failedTestOutcome(message: string): Promise<RunOutcome> {
  return Promise.reject(new Error(message));
}

function emptyTestUsage(): RunOutcome['usage'] {
  return {
    callCount: 0,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null
  };
}

export function readPendingInterrupts(repository: AgentSessionRepository, runId: string) {
  const run = repository.getRun(runId);
  return repository.interruptProjection.readPending({ runId, threadId: run.threadId });
}
