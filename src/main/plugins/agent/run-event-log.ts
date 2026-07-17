import type { Database as DatabaseConnection } from 'better-sqlite3';

import type { ChatRunEvent, SequencedChatRunEvent } from '../../../shared/types';

export const agentRunEventLogMaxEvents = 10_000;

type EventRow = {
  run_id: string;
  sequence: number;
  event_json: string;
  created_at: string;
};

export class AgentRunEventLog {
  constructor(private readonly db: DatabaseConnection) {}

  recordRunEvent(event: ChatRunEvent): SequencedChatRunEvent {
    const createdAt = new Date().toISOString();
    return this.db.transaction(() => {
      const sequence = this.nextSequence(event.runId);
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
    })();
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
      .prepare('SELECT next_sequence FROM agent_run_event_cursors WHERE run_id = ?')
      .get(runId) as { next_sequence: number } | undefined;
    if (row === undefined) {
      this.db
        .prepare(
          `INSERT INTO agent_run_event_cursors (run_id, next_sequence)
           VALUES (?, ?)`
        )
        .run(runId, 2);
      return 1;
    }
    if (row.next_sequence >= agentRunEventLogMaxEvents) {
      throw new Error('agent_run_event_log_capacity_exceeded');
    }
    this.db.prepare('UPDATE agent_run_event_cursors SET next_sequence = ? WHERE run_id = ?').run(row.next_sequence + 1, runId);
    return row.next_sequence;
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
