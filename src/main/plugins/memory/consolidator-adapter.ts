import type { MemoryRepository } from './memory-repository';

type AgentRunCompletedPayload = {
  runId: string;
  threadId: string | null;
  summary: string;
  assistantMessage: string;
};

type AgentSessionArchivedPayload = {
  threadId: string;
  reason: string;
};

export class MemoryConsolidatorAdapter {
  constructor(private readonly repository: MemoryRepository) {}

  handleAgentRunCompleted(payload: AgentRunCompletedPayload): void {
    this.repository.recordMemoryEvent({
      type: 'agent.run.completed',
      threadId: payload.threadId,
      runId: payload.runId,
      summary: payload.summary,
      payload
    });
  }

  handleAgentSessionArchived(payload: AgentSessionArchivedPayload): void {
    this.repository.recordMemoryEvent({
      type: 'agent.session.archived',
      threadId: payload.threadId,
      summary: payload.reason,
      payload
    });
  }
}

export function isAgentRunCompletedPayload(value: unknown): value is AgentRunCompletedPayload {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.runId === 'string' &&
    (typeof record.threadId === 'string' || record.threadId === null) &&
    typeof record.summary === 'string' &&
    typeof record.assistantMessage === 'string'
  );
}

export function isAgentSessionArchivedPayload(value: unknown): value is AgentSessionArchivedPayload {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.threadId === 'string' && typeof record.reason === 'string';
}
