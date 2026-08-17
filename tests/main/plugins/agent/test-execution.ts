import type { ChatRunEvent } from '../../../../src/shared/types';
import type { AgentDeepAgentExecution } from '../../../../src/main/plugins/agent/agent-execution';
import type { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';

export function createTestAgentExecution(
  factory: () => AsyncIterable<ChatRunEvent>
): AgentDeepAgentExecution {
  let resolveOutcome: (value: AgentDeepAgentExecution['outcome'] extends Promise<infer T> ? T : never) => void = () => {};
  let rejectOutcome: (reason: unknown) => void = () => {};
  const outcome = new Promise<Awaited<AgentDeepAgentExecution['outcome']>>((resolve, reject) => {
    resolveOutcome = resolve;
    rejectOutcome = reject;
  });
  void outcome.catch(() => undefined);
  const events = (async function* () {
    const interrupts: Array<Extract<ChatRunEvent, { type: 'run_interrupted' }>> = [];
    try {
      for await (const event of factory()) {
        if (event.type === 'run_interrupted') {
          interrupts.push(event);
        }
        yield event;
      }
      resolveOutcome(
        interrupts.length === 0
          ? { status: 'completed' }
          : {
              status: 'interrupted',
              interrupts: interrupts.map(({ interruptId, payload }) => ({ interruptId, payload }))
            }
      );
    } catch (error) {
      rejectOutcome(error);
      throw error;
    }
  })();
  return { events, outcome };
}

export function readPendingInterrupts(repository: AgentSessionRepository, runId: string) {
  const run = repository.getRun(runId);
  return repository.interruptProjection.readPending({ runId, threadId: run.threadId });
}
