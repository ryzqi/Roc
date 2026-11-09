import { Buffer } from 'node:buffer';
import type { Database as DatabaseConnection } from 'better-sqlite3';

import { applyChatRunEvent, createEmptyChatRunState } from '../../../shared/chat-run-state';
import {
  chatRunEventSchema,
  chatRunEventsReplayPageSchema,
  chatRunEventsSnapshotSchema
} from '../../../shared/schemas/chat';
import type {
  ChatRunEvent,
  ChatRunEventsReplayPage,
  ChatRunEventsSnapshot,
  ChatRunStateSnapshot,
  SequencedChatRunEvent
} from '../../../shared/types';
import { parseStoredJsonObject } from '../../infrastructure/stored-json';
import { createExecutionEvent, parseExecutionEvent } from '../../infrastructure/execution-events';

export const agentRunEventLogMaxEvents = 10_000;
export const agentRunEventLogMaxBytes = 16 * 1024 * 1024;
export const agentRunEventLogMaxEventBytes = 1024 * 1024;
export const agentRunEventSnapshotPendingMaxEvents = 128;
export const agentRunEventSnapshotPendingMaxBytes = 2 * 1024 * 1024;
export const agentRunEventSnapshotMaxBytes = 4 * 1024 * 1024;

export type AgentRunEventLogOptions = {
  maxEvents?: number;
  maxBytes?: number;
  maxEventBytes?: number;
  maxPendingEvents?: number;
  maxPendingBytes?: number;
  maxSnapshotBytes?: number;
};

type EventRow = {
  run_id: string;
  sequence: number;
  event_json: string;
  created_at: string;
  event_bytes?: number;
};

type CursorRow = {
  next_sequence: number;
  retained_count: number;
  retained_bytes: number;
  pending_count: number;
  pending_bytes: number;
};

type SnapshotRow = {
  run_id: string;
  through_sequence: number;
  snapshot_json: string;
  snapshot_bytes: number;
  updated_at: string;
};

export class AgentRunEventLog {
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly maxEventBytes: number;
  private readonly maxPendingEvents: number;
  private readonly maxPendingBytes: number;
  private readonly maxSnapshotBytes: number;
  private readonly getCursor;
  private readonly insertCursor;
  private readonly updateCursor;
  private readonly insertEvent;
  private readonly getSnapshot;
  private readonly upsertSnapshot;
  private readonly insertPending;
  private readonly listPending;
  private readonly deletePendingThrough;
  private readonly listOverflowCandidates;
  private readonly deleteEvent;

  constructor(private readonly db: DatabaseConnection, options: AgentRunEventLogOptions = {}) {
    this.maxEvents = options.maxEvents ?? agentRunEventLogMaxEvents;
    this.maxBytes = options.maxBytes ?? agentRunEventLogMaxBytes;
    this.maxEventBytes = options.maxEventBytes ?? agentRunEventLogMaxEventBytes;
    this.maxPendingEvents = options.maxPendingEvents ?? agentRunEventSnapshotPendingMaxEvents;
    this.maxPendingBytes = options.maxPendingBytes ?? agentRunEventSnapshotPendingMaxBytes;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? agentRunEventSnapshotMaxBytes;
    validateLimit(this.maxEvents, 'agent_run_event_max_events_invalid');
    validateLimit(this.maxBytes, 'agent_run_event_max_bytes_invalid');
    validateLimit(this.maxEventBytes, 'agent_run_event_max_event_bytes_invalid');
    validateLimit(this.maxPendingEvents, 'agent_run_event_pending_max_events_invalid');
    validateLimit(this.maxPendingBytes, 'agent_run_event_pending_max_bytes_invalid');
    validateLimit(this.maxSnapshotBytes, 'agent_run_event_snapshot_max_bytes_invalid');
    if (this.maxEventBytes > this.maxBytes) throw new Error('agent_run_event_max_event_bytes_exceeds_max_bytes');

    this.getCursor = db.prepare(
      `SELECT next_sequence, retained_count, retained_bytes, pending_count, pending_bytes
       FROM agent_run_event_cursors WHERE run_id = ?`
    );
    this.insertCursor = db.prepare(
      `INSERT INTO agent_run_event_cursors
       (run_id, next_sequence, retained_count, retained_bytes, pending_count, pending_bytes)
       VALUES (?, ?, 0, 0, 0, 0)`
    );
    this.updateCursor = db.prepare(
      `UPDATE agent_run_event_cursors
       SET next_sequence = ?, retained_count = ?, retained_bytes = ?, pending_count = ?, pending_bytes = ?
       WHERE run_id = ?`
    );
    this.insertEvent = db.prepare(
      `INSERT INTO agent_run_events (run_id, sequence, event_json, created_at, event_bytes)
       VALUES (?, ?, ?, ?, ?)`
    );
    this.getSnapshot = db.prepare(
      `SELECT run_id, through_sequence, snapshot_json, snapshot_bytes, updated_at
       FROM agent_run_event_snapshots WHERE run_id = ?`
    );
    this.upsertSnapshot = db.prepare(
      `INSERT INTO agent_run_event_snapshots (run_id, through_sequence, snapshot_json, snapshot_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         through_sequence = excluded.through_sequence,
         snapshot_json = excluded.snapshot_json,
         snapshot_bytes = excluded.snapshot_bytes,
         updated_at = excluded.updated_at`
    );
    this.insertPending = db.prepare(
      `INSERT INTO agent_run_event_snapshot_pending (run_id, sequence, event_json, event_bytes, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    this.listPending = db.prepare(
      `SELECT run_id, sequence, event_json, created_at, event_bytes
       FROM agent_run_event_snapshot_pending WHERE run_id = ? ORDER BY sequence ASC`
    );
    this.deletePendingThrough = db.prepare(
      'DELETE FROM agent_run_event_snapshot_pending WHERE run_id = ? AND sequence <= ?'
    );
    this.listOverflowCandidates = db.prepare(
      `SELECT run_id, sequence, event_json, created_at, event_bytes
       FROM agent_run_events WHERE run_id = ? ORDER BY sequence ASC LIMIT ?`
    );
    this.deleteEvent = db.prepare('DELETE FROM agent_run_events WHERE run_id = ? AND sequence = ?');
  }

  recordRunEvent(event: ChatRunEvent, createdAt = new Date().toISOString()): SequencedChatRunEvent {
    const validEvent = chatRunEventSchema.parse(event);

    return this.db.transaction(() => {
      let cursor = this.getCursor.get(validEvent.runId) as CursorRow | undefined;
      let sequence: number;
      if (cursor === undefined) {
        sequence = 1;
        this.insertCursor.run(validEvent.runId, 2);
        cursor = { next_sequence: 2, retained_count: 0, retained_bytes: 0, pending_count: 0, pending_bytes: 0 };
      } else {
        sequence = cursor.next_sequence;
      }
      const scope = this.db.prepare(`SELECT t.research_project_id projectId,e.task_id taskId
        FROM agent_runs r JOIN agent_threads t ON t.id=r.thread_id
        LEFT JOIN research_task_executions e ON e.kind='chat' AND e.execution_id=r.id WHERE r.id=?`)
        .get(validEvent.runId) as {projectId: string | null; taskId: string | null} | undefined;
      const eventJson = JSON.stringify(createExecutionEvent({streamId: 'chat:' + validEvent.runId,
        projectId: scope?.projectId ?? null, taskId: scope?.taskId ?? null, runId: validEvent.runId,
        sequence, eventType: validEvent.type, actor: {kind: 'main', id: 'agent-runtime'},
        correlationId: validEvent.runId, causationId: null, payload: validEvent, createdAt}));
      const eventBytes = byteLength(eventJson);
      if (eventBytes > this.maxEventBytes) throw new Error('agent_run_event_payload_too_large');
      this.insertEvent.run(validEvent.runId, sequence, eventJson, createdAt, eventBytes);
      cursor = {
        ...cursor,
        next_sequence: sequence + 1,
        retained_count: cursor.retained_count + 1,
        retained_bytes: cursor.retained_bytes + eventBytes
      };
      this.updateCursorRow(validEvent.runId, cursor);
      this.trimToCapacity(validEvent.runId, cursor);
      this.compactPendingIfNeeded(validEvent.runId);
      return { runId: validEvent.runId, sequence, event: validEvent, createdAt };
    })();
  }

  listRunEvents(input: { runId: string; afterSequence: number; limit?: number }): SequencedChatRunEvent[] {
    const limit = boundedPageLimit(input.limit ?? this.maxEvents, this.maxEvents);
    const rows = this.db.prepare(
      `SELECT run_id, sequence, event_json, created_at
       FROM agent_run_events
       WHERE run_id = ? AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`
    ).all(input.runId, input.afterSequence, limit) as EventRow[];
    return rows.map(rowToSequencedEvent);
  }

  replayRunEvents(input: { runId: string; afterSequence: number; limit?: number }): ChatRunEventsReplayPage {
    const afterSequence = Math.max(0, Math.floor(input.afterSequence));
    const limit = boundedPageLimit(input.limit, 1_000);
    const snapshotRow = this.getSnapshot.get(input.runId) as SnapshotRow | undefined;
    const snapshot = snapshotRow === undefined ? null : parseSnapshotRow(snapshotRow, input.runId);
    const firstAvailableSequence = this.firstAvailableSequence(input.runId);
    const needsSnapshot = snapshot !== null
      ? afterSequence < snapshot.throughSequence
      : firstAvailableSequence !== null && afterSequence + 1 < firstAvailableSequence;

    if (needsSnapshot) {
      const recoverySnapshot = snapshot ?? this.createIncompleteSnapshot(input.runId, (firstAvailableSequence ?? 1) - 1);
      const events = this.listAvailableRows(input.runId, recoverySnapshot.throughSequence, limit).map(rowToSequencedEvent);
      this.assertContiguous(input.runId, events, recoverySnapshot.throughSequence, limit);
      return chatRunEventsReplayPageSchema.parse({
        kind: 'replay_gap',
        runId: input.runId,
        requestedAfterSequence: afterSequence,
        firstAvailableSequence: recoverySnapshot.throughSequence + 1,
        snapshot: recoverySnapshot,
        events
      });
    }

    const events = this.listAvailableRows(input.runId, afterSequence, limit).map(rowToSequencedEvent);
    const baseSequence = Math.max(afterSequence, snapshot?.throughSequence ?? 0);
    this.assertContiguous(input.runId, events, baseSequence, limit);
    return chatRunEventsReplayPageSchema.parse({ kind: 'events', runId: input.runId, events });
  }

  restoreRunEvent(input: { runId: string; sequence: number; eventJson: string; createdAt: string }): void {
    const event = readEnvelopeEvent(input.eventJson, input.runId, input.sequence, input.createdAt);
    if (event.runId !== input.runId) throw new Error('agent_run_event_run_id_mismatch');
    const eventBytes = byteLength(input.eventJson);
    if (eventBytes > this.maxEventBytes) throw new Error('agent_run_event_payload_too_large');

    this.db.transaction(() => {
      let cursor = this.getCursor.get(input.runId) as CursorRow | undefined;
      if (cursor === undefined) {
        this.insertCursor.run(input.runId, input.sequence + 1);
        cursor = { next_sequence: input.sequence + 1, retained_count: 0, retained_bytes: 0, pending_count: 0, pending_bytes: 0 };
      }
      this.insertEvent.run(input.runId, input.sequence, input.eventJson, input.createdAt, eventBytes);
      const nextCursor: CursorRow = {
        ...cursor,
        next_sequence: Math.max(cursor.next_sequence, input.sequence + 1),
        retained_count: cursor.retained_count + 1,
        retained_bytes: cursor.retained_bytes + eventBytes
      };
      this.updateCursorRow(input.runId, nextCursor);
      this.trimToCapacity(input.runId, nextCursor);
      this.compactPendingIfNeeded(input.runId);
    })();
  }

  restoreFrom(source: DatabaseConnection | null): void {
    if (source === null) return;
    const rows = source
      .prepare(
        `SELECT run_id, sequence, event_json, created_at
         FROM agent_run_events ORDER BY run_id ASC, sequence ASC`
      )
      .all() as EventRow[];
    for (const row of rows) {
      this.restoreRunEvent({
        runId: row.run_id,
        sequence: row.sequence,
        eventJson: row.event_json,
        createdAt: row.created_at
      });
    }
  }

  deleteForRunIds(runIds: readonly string[]): number {
    const deleteSnapshot = this.db.prepare('DELETE FROM agent_run_event_snapshots WHERE run_id = ?');
    const deletePending = this.db.prepare('DELETE FROM agent_run_event_snapshot_pending WHERE run_id = ?');
    const deleteEvents = this.db.prepare('DELETE FROM agent_run_events WHERE run_id = ?');
    const deleteCursor = this.db.prepare('DELETE FROM agent_run_event_cursors WHERE run_id = ?');
    return this.db.transaction(() => {
      let deleted = 0;
      for (const runId of runIds) {
        deleteSnapshot.run(runId);
        deleted += deletePending.run(runId).changes;
        deleted += deleteEvents.run(runId).changes;
        deleteCursor.run(runId);
      }
      return deleted;
    })();
  }

  private listAvailableRows(runId: string, afterSequence: number, limit: number): EventRow[] {
    return this.db
      .prepare(
        `SELECT run_id, sequence, event_json, created_at FROM (
           SELECT run_id, sequence, event_json, created_at
           FROM agent_run_event_snapshot_pending WHERE run_id = ? AND sequence > ?
           UNION ALL
           SELECT run_id, sequence, event_json, created_at
           FROM agent_run_events WHERE run_id = ? AND sequence > ?
         ) ORDER BY sequence ASC LIMIT ?`
      )
      .all(runId, afterSequence, runId, afterSequence, limit) as EventRow[];
  }

  private firstAvailableSequence(runId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT MIN(sequence) AS first_sequence FROM (
           SELECT sequence FROM agent_run_event_snapshot_pending WHERE run_id = ?
           UNION ALL
           SELECT sequence FROM agent_run_events WHERE run_id = ?
         )`
      )
      .get(runId, runId) as { first_sequence: number | null };
    return row.first_sequence;
  }

  private createIncompleteSnapshot(runId: string, throughSequence: number): ChatRunEventsSnapshot {
    const state = {
      ...createEmptyChatRunState(),
      runId,
      status: 'recovering' as const,
      historyComplete: false
    };
    return chatRunEventsSnapshotSchema.parse({
      version: 1,
      runId,
      throughSequence,
      historyComplete: false,
      state
    });
  }

  private assertContiguous(runId: string, events: readonly SequencedChatRunEvent[], afterSequence: number, limit: number): void {
    let expectedSequence = afterSequence + 1;
    for (const event of events) {
      if (event.sequence !== expectedSequence) throw new Error('agent_run_event_sequence_gap_without_snapshot');
      expectedSequence += 1;
    }
    const cursor = this.getCursor.get(runId) as CursorRow | undefined;
    if (events.length < limit && cursor !== undefined && expectedSequence < cursor.next_sequence) {
      throw new Error('agent_run_event_sequence_gap_without_snapshot');
    }
  }

  private trimToCapacity(runId: string, initialCursor: CursorRow): void {
    let cursor = initialCursor;
    while (cursor.retained_count > this.maxEvents || cursor.retained_bytes > this.maxBytes) {
      const rows = this.listOverflowCandidates.all(runId, Math.min(128, cursor.retained_count)) as EventRow[];
      if (rows.length === 0) throw new Error('agent_run_event_retention_inconsistent');
      for (const row of rows) {
        const bytes = row.event_bytes ?? byteLength(row.event_json);
        this.insertPending.run(row.run_id, row.sequence, row.event_json, bytes, row.created_at);
        this.deleteEvent.run(runId, row.sequence);
        cursor = {
          ...cursor,
          retained_count: cursor.retained_count - 1,
          retained_bytes: cursor.retained_bytes - bytes,
          pending_count: cursor.pending_count + 1,
          pending_bytes: cursor.pending_bytes + bytes
        };
        if (cursor.retained_count <= this.maxEvents && cursor.retained_bytes <= this.maxBytes) break;
      }
    }
    this.updateCursorRow(runId, cursor);
  }

  private compactPendingIfNeeded(runId: string): void {
    const cursor = this.getCursor.get(runId) as CursorRow | undefined;
    if (cursor === undefined) throw new Error('agent_run_event_cursor_missing');
    if (cursor.pending_count <= this.maxPendingEvents && cursor.pending_bytes <= this.maxPendingBytes) return;

    const rows = this.listPending.all(runId) as EventRow[];
    if (rows.length === 0) throw new Error('agent_run_event_pending_inconsistent');
    const storedSnapshotRow = this.getSnapshot.get(runId) as SnapshotRow | undefined;
    let snapshot = storedSnapshotRow === undefined
      ? null
      : parseSnapshotRow(storedSnapshotRow, runId);
    let state: ChatRunStateSnapshot = snapshot?.state ?? createEmptyChatRunState();
    let throughSequence = snapshot?.throughSequence ?? 0;
    if (snapshot === null) state = { ...state, runId };

    for (const row of rows) {
      if (row.sequence <= throughSequence) throw new Error('agent_run_event_pending_behind_snapshot');
      if (row.sequence !== throughSequence + 1) {
        state = { ...createEmptyChatRunState(), runId, status: 'recovering', historyComplete: false };
        throughSequence = row.sequence - 1;
      }
      const event = readEnvelopeEvent(row.event_json, row.run_id, row.sequence, row.created_at);
      if (event.runId !== runId) throw new Error('agent_run_event_run_id_mismatch');
      state = applyChatRunEvent(state, event);
      throughSequence = row.sequence;
    }

    const bounded = createBoundedSnapshot(runId, throughSequence, state, this.maxSnapshotBytes);
    const updatedAt = new Date().toISOString();
    this.upsertSnapshot.run(runId, throughSequence, bounded.json, bounded.bytes, updatedAt);
    const deleted = this.deletePendingThrough.run(runId, throughSequence).changes as number;
    const deletedBytes = rows.reduce((total, row) => total + (row.event_bytes ?? byteLength(row.event_json)), 0);
    this.updateCursorRow(runId, {
      ...cursor,
      pending_count: Math.max(0, cursor.pending_count - deleted),
      pending_bytes: Math.max(0, cursor.pending_bytes - deletedBytes)
    });
  }

  private updateCursorRow(runId: string, cursor: CursorRow): void {
    this.updateCursor.run(
      cursor.next_sequence,
      cursor.retained_count,
      cursor.retained_bytes,
      cursor.pending_count,
      cursor.pending_bytes,
      runId
    );
  }
}

function parseSnapshotRow(row: SnapshotRow, runId: string): ChatRunEventsSnapshot {
  const stored = parseStoredJsonObject(row.snapshot_json, 'agent_run_event_snapshot_corrupt');
  const snapshot = chatRunEventsSnapshotSchema.parse(stored);
  if (row.run_id !== runId || snapshot.runId !== runId || snapshot.throughSequence !== row.through_sequence ||
      byteLength(row.snapshot_json) !== row.snapshot_bytes) {
    throw new Error('agent_run_event_snapshot_corrupt');
  }
  return snapshot;
}

function createBoundedSnapshot(
  runId: string,
  throughSequence: number,
  state: ChatRunStateSnapshot,
  maxBytes: number
): { json: string; bytes: number } {
  let candidate: ChatRunStateSnapshot = { ...state };
  let snapshot = makeSnapshot(runId, throughSequence, candidate);
  let json = JSON.stringify(snapshot);
  let bytes = byteLength(json);
  if (bytes <= maxBytes) return { json, bytes };

  candidate = {
    ...candidate,
    historyComplete: false,
    assistantMessage: candidate.assistantMessage.slice(-64 * 1024),
    summary: candidate.summary?.slice(-16 * 1024) ?? null,
    errorMessage: candidate.errorMessage?.slice(-16 * 1024) ?? null,
    activityBlocks: candidate.activityBlocks.slice(-128),
    pendingInterrupts: candidate.pendingInterrupts.slice(-64),
    todos: candidate.todos.slice(-64),
    subagents: candidate.subagents.slice(-16)
  };
  snapshot = makeSnapshot(runId, throughSequence, candidate);
  json = JSON.stringify(snapshot);
  bytes = byteLength(json);
  while (bytes > maxBytes && candidate.activityBlocks.length > 0) {
    candidate = { ...candidate, activityBlocks: candidate.activityBlocks.slice(1) };
    snapshot = makeSnapshot(runId, throughSequence, candidate);
    json = JSON.stringify(snapshot);
    bytes = byteLength(json);
  }
  if (bytes > maxBytes) {
    candidate = { ...candidate, activityBlocks: [], pendingInterrupts: [], todos: [], subagents: [] };
    snapshot = makeSnapshot(runId, throughSequence, candidate);
    json = JSON.stringify(snapshot);
    bytes = byteLength(json);
  }
  if (bytes > maxBytes) throw new Error('agent_run_event_snapshot_too_large');
  return { json, bytes };
}

function makeSnapshot(runId: string, throughSequence: number, state: ChatRunStateSnapshot): ChatRunEventsSnapshot {
  const snapshot = {
    version: 1 as const,
    runId,
    throughSequence,
    historyComplete: state.historyComplete,
    state
  };
  return chatRunEventsSnapshotSchema.parse(snapshot);
}

function rowToSequencedEvent(row: EventRow): SequencedChatRunEvent {
  const event = readEnvelopeEvent(row.event_json, row.run_id, row.sequence, row.created_at);
  if (event.runId !== row.run_id) throw new Error('agent_run_event_run_id_mismatch');
  return {
    runId: row.run_id,
    sequence: row.sequence,
    event,
    createdAt: row.created_at
  };
}

function readEnvelopeEvent(raw: string, runId: string, sequence: number, createdAt: string): ChatRunEvent {
  const envelope = parseExecutionEvent(raw);
  const payload = envelope.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('agent_run_event_envelope_mismatch');
  const event = chatRunEventSchema.parse(payload);
  if (envelope.streamId !== 'chat:' + runId || envelope.sequence !== sequence || envelope.createdAt !== createdAt ||
      envelope.correlationId !== runId || envelope.eventType !== event.type) throw new Error('agent_run_event_envelope_mismatch');
  return event;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function validateLimit(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
}

function boundedPageLimit(value: number | undefined, maximum: number): number {
  const requested = value ?? 500;
  if (!Number.isSafeInteger(requested) || requested <= 0) throw new Error('agent_run_event_page_limit_invalid');
  return Math.min(requested, maximum);
}
