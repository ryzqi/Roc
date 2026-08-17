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

  recordRunEvent(event: ChatRunEvent, createdAt = new Date().toISOString()): SequencedChatRunEvent {
    return this.db.transaction(() => {
      const sequence = this.nextSequence(event.runId);
      this.db
        .prepare(
          `INSERT INTO agent_run_events (run_id, sequence, event_json, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(event.runId, sequence, JSON.stringify(event), createdAt);
      this.trimToCapacity(event.runId);
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

  restoreRunEvent(input: { runId: string; sequence: number; eventJson: string; createdAt: string }): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agent_run_events (run_id, sequence, event_json, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(input.runId, input.sequence, input.eventJson, input.createdAt);
      this.db
        .prepare(
          `INSERT INTO agent_run_event_cursors (run_id, next_sequence)
           VALUES (?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             next_sequence = MAX(agent_run_event_cursors.next_sequence, excluded.next_sequence)`
        )
        .run(input.runId, input.sequence + 1);
      this.trimToCapacity(input.runId);
    })();
  }

  restoreFrom(source: DatabaseConnection | null): void {
    if (source === null) {
      return;
    }
    let rows: EventRow[];
    try {
      rows = source
        .prepare(
          `SELECT run_id, sequence, event_json, created_at
           FROM agent_run_events
           ORDER BY run_id ASC, sequence ASC`
        )
        .all() as EventRow[];
    } catch {
      return;
    }
    for (const row of rows) {
      try {
        this.restoreRunEvent({
          runId: row.run_id,
          sequence: row.sequence,
          eventJson: row.event_json,
          createdAt: row.created_at
        });
      } catch {
        continue;
      }
    }
  }

  deleteForRunIds(runIds: readonly string[]): number {
    const deleteEvents = this.db.prepare('DELETE FROM agent_run_events WHERE run_id = ?');
    const deleteCursor = this.db.prepare('DELETE FROM agent_run_event_cursors WHERE run_id = ?');
    return this.db.transaction(() => {
      let deleted = 0;
      for (const runId of runIds) {
        deleteCursor.run(runId);
        deleted += deleteEvents.run(runId).changes;
      }
      return deleted;
    })();
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
    this.db.prepare('UPDATE agent_run_event_cursors SET next_sequence = ? WHERE run_id = ?').run(row.next_sequence + 1, runId);
    return row.next_sequence;
  }

  private trimToCapacity(runId: string): void {
    const cutoff = this.db
      .prepare(
        `SELECT sequence
         FROM agent_run_events
         WHERE run_id = ?
         ORDER BY sequence DESC
         LIMIT 1 OFFSET ?`
      )
      .get(runId, agentRunEventLogMaxEvents) as { sequence: number } | undefined;
    if (cutoff === undefined) {
      return;
    }
    this.db
      .prepare('DELETE FROM agent_run_events WHERE run_id = ? AND sequence <= ?')
      .run(runId, cutoff.sequence);
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
