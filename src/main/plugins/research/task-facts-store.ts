import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {taskFactsSnapshotSchema, taskFactsHistorySchema, type TaskFactsSnapshot} from '../../../shared/schemas/research-task-facts';

export const taskFactsHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type FactRow = {task_id: string; revision: number; snapshot_json: string};
/** Immutable revisions in the task identity database. Caller supplies validated task scope. */
export class ResearchTaskFactsStore {
  constructor(private readonly db: Database) {}
  current(taskId: string): TaskFactsSnapshot | null {
    const row = this.db.prepare('SELECT task_id,revision,snapshot_json FROM research_task_facts WHERE task_id=? ORDER BY revision DESC LIMIT 1')
      .get(taskId) as FactRow | undefined;
    return row === undefined ? null : this.parse(row);
  }
  save(value: Omit<TaskFactsSnapshot, 'snapshotHash'>, expectedRevision: number): TaskFactsSnapshot {
    return this.db.transaction(() => {
      if ((this.current(value.taskId)?.revision ?? 0) !== expectedRevision) throw new Error('research_task_facts_revision_conflict');
      if (value.revision !== expectedRevision + 1) throw new Error('research_task_facts_revision_invalid');
      const body = taskFactsSnapshotSchema.omit({snapshotHash: true}).parse(value);
      const snapshot = taskFactsSnapshotSchema.parse({...body, snapshotHash: taskFactsHash(body)});
      this.db.prepare('INSERT INTO research_task_facts (task_id,revision,snapshot_json) VALUES (?,?,?)')
        .run(value.taskId, value.revision, JSON.stringify(snapshot));
      return snapshot;
    })();
  }
  history(taskId: string, beforeRevision: number | null, limit: number) {
    const rows = this.db.prepare('SELECT task_id,revision,snapshot_json FROM research_task_facts WHERE task_id=? AND (? IS NULL OR revision<?) ORDER BY revision DESC LIMIT ?')
      .all(taskId, beforeRevision, beforeRevision, limit + 1) as FactRow[];
    const snapshots = rows.slice(0, limit).map(row => this.parse(row));
    return taskFactsHistorySchema.parse({snapshots, nextRevision: snapshots.at(-1)?.revision ?? null, hasMore: rows.length > limit});
  }
  private parse(row: FactRow): TaskFactsSnapshot {
    const snapshot = taskFactsSnapshotSchema.parse(JSON.parse(row.snapshot_json));
    if (snapshot.taskId !== row.task_id || snapshot.revision !== row.revision) throw new Error('research_task_facts_identity_corrupt');
    const {snapshotHash, ...body} = snapshot;
    if (taskFactsHash(body) !== snapshotHash) throw new Error('research_task_facts_snapshot_corrupt');
    return snapshot;
  }
}
