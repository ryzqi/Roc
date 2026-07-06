import type { Database as DatabaseConnection } from 'better-sqlite3';

import type { ChatRunEvent, SequencedChatRunEvent } from '../../../shared/types';

type EventRow = {
  run_id: string;
  sequence: number;
  event_json: string;
  created_at: string;
};

export class AgentRunEventLog {
  constructor(private readonly db: DatabaseConnection) {}

  recordRunEvent(event: ChatRunEvent): SequencedChatRunEvent {
    const sequence = this.nextSequence(event.runId);
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_run_events (run_id, sequence, event_json, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(event.runId, sequence, JSON.stringify(event), createdAt);
    return {
      runId: event.runId,
      sequence,
      event,
      createdAt
    };
  }

  listRunEvents(input: { runId: string; afterSequence: number }): SequencedChatRunEvent[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, sequence, event_json, created_at
         FROM agent_run_events
         WHERE run_id = ? AND sequence > ?
         ORDER BY sequence ASC`
      )
      .all(input.runId, input.afterSequence) as EventRow[];
    return rows.map(rowToSequencedEvent);
  }

  private nextSequence(runId: string): number {
    const row = this.db
      .prepare('SELECT MAX(sequence) AS max_sequence FROM agent_run_events WHERE run_id = ?')
      .get(runId) as { max_sequence: number | null } | undefined;
    if (row === undefined) {
      return 1;
    }
    if (row.max_sequence === null) {
      return 1;
    }
    return row.max_sequence + 1;
  }
}

function rowToSequencedEvent(row: EventRow): SequencedChatRunEvent {
  return {
    runId: row.run_id,
    sequence: row.sequence,
    event: JSON.parse(row.event_json) as ChatRunEvent,
    createdAt: row.created_at
  };
}
