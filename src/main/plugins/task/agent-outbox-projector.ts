import type { AgentTaskHistoryContract } from '../agent/agent-task-history-contract';
import type { TaskRepository } from './task-repository';

const projectorName = 'task_background_status';
const projectionBatchSize = 100;

export type AgentOutboxProjectionResult = {
  appliedCount: number;
  lastSequence: number;
};

export class AgentOutboxProjector {
  constructor(
    private readonly source: Pick<AgentTaskHistoryContract, 'listOutboxEventsAfter'>,
    private readonly target: Pick<TaskRepository, 'getAgentOutboxCursor' | 'projectAgentOutboxEvents'>,
    private readonly onError: (error: unknown) => void
  ) {}

  project(): AgentOutboxProjectionResult {
    let lastSequence = this.target.getAgentOutboxCursor(projectorName);
    let appliedCount = 0;
    while (true) {
      const events = this.source.listOutboxEventsAfter({
        afterSequence: lastSequence,
        limit: projectionBatchSize
      });
      if (events.length === 0) {
        return { appliedCount, lastSequence };
      }
      const result = this.target.projectAgentOutboxEvents({ events, projectorName });
      lastSequence = result.lastSequence;
      appliedCount += result.appliedCount;
      if (events.length < projectionBatchSize) {
        return { appliedCount, lastSequence };
      }
    }
  }

  projectBestEffort(): void {
    try {
      this.project();
    } catch (error) {
      this.onError(error);
    }
  }
}
