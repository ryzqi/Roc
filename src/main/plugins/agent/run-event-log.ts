import type { Database as DatabaseConnection } from 'better-sqlite3';

import { chatRunEventSchema } from '../../../shared/schemas/chat';
import type { ChatRunEvent, SequencedChatRunEvent } from '../../../shared/types';
import { parseStoredJson } from '../../infrastructure/stored-json';

export const agentRunEventLogMaxEvents = 10_000;

type EventRow = {
  run_id: string;
  sequence: number;
  event_json: string;
  created_at: string;
};

export class AgentRunEventLog {
  private readonly insert;
  private readonly cursor;
  private readonly insertCursor;
  private readonly updateCursor;
  private readonly count;
  private readonly trim;
  private lastWrite: { runId: string; nextSequence: number; count: number } | undefined;

  constructor(private readonly db: DatabaseConnection) {
    this.insert = db.prepare('INSERT INTO agent_run_events (run_id, sequence, event_json, created_at) VALUES (?, ?, ?, ?)');
    this.cursor = db.prepare('SELECT next_sequence FROM agent_run_event_cursors WHERE run_id = ?');
    this.insertCursor = db.prepare('INSERT INTO agent_run_event_cursors (run_id, next_sequence) VALUES (?, ?)');
    this.updateCursor = db.prepare('UPDATE agent_run_event_cursors SET next_sequence = ? WHERE run_id = ?');
    this.count = db.prepare('SELECT COUNT(*) AS count FROM agent_run_events WHERE run_id = ?');
    this.trim = db.prepare(`DELETE FROM agent_run_events WHERE run_id = ? AND sequence IN (
      SELECT sequence FROM agent_run_events WHERE run_id = ? ORDER BY sequence ASC LIMIT ?
    )`);
  }

  recordRunEvent(event: ChatRunEvent, createdAt = new Date().toISOString()): SequencedChatRunEvent {
    let committed: typeof this.lastWrite;
    const result = this.db.transaction(() => {
      const sequence = this.nextSequence(event.runId);
      // A rollback or another writer changes the durable cursor and invalidates this hint.
      const count = this.lastWrite?.runId === event.runId && this.lastWrite.nextSequence === sequence
        ? this.lastWrite.count
        : (this.count.get(event.runId) as { count: number }).count;
      this.insert.run(event.runId, sequence, JSON.stringify(event), createdAt);
      const overflow = Math.max(0, count + 1 - agentRunEventLogMaxEvents);
      if (overflow > 0) this.trim.run(event.runId, event.runId, overflow);
      committed = { runId: event.runId, nextSequence: sequence + 1, count: count + 1 - overflow };
      return {
        runId: event.runId,
        sequence,
        event,
        createdAt
      };
    })();
    this.lastWrite = committed;
    return result;
  }

  listRunEvents(input: { runId: string; afterSequence: number; limit?: number }): SequencedChatRunEvent[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, sequence, event_json, created_at
         FROM agent_run_events
         WHERE run_id = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`
      )
      .all(input.runId, input.afterSequence, input.limit ?? agentRunEventLogMaxEvents) as EventRow[];
    return rows.map(rowToSequencedEvent);
  }

  restoreRunEvent(input: { runId: string; sequence: number; eventJson: string; createdAt: string }): void {
    this.lastWrite = undefined;
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
    this.lastWrite = undefined;
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
    const row = this.cursor.get(runId) as { next_sequence: number } | undefined;
    if (row === undefined) {
      this.insertCursor.run(runId, 2);
      return 1;
    }
    this.updateCursor.run(row.next_sequence + 1, runId);
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
    event: parseStoredJson(row.event_json, chatRunEventSchema, 'agent_run_event_corrupt'),
    createdAt: row.created_at
  };
}
