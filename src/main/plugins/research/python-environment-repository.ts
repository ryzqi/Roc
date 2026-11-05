import type { Database } from 'better-sqlite3';
import {
  researchPythonEnvironmentGetSchema, researchPythonEnvironmentListSchema, researchPythonEnvironmentSelectSchema,
  researchPythonEnvironmentSelectionSchema, researchPythonEnvironmentSnapshotSchema,
  type ResearchPythonEnvironmentGet, type ResearchPythonEnvironmentSelect, type ResearchPythonEnvironmentSelection,
  type ResearchPythonEnvironmentSnapshot
} from '../../../shared/schemas/research-python-environments';
import type { ResearchRepository } from './repository';
import { researchContentHash } from './research-files';

type Row = { id: string; project_id: string; request_id: string; snapshot_hash: string; snapshot_json: string; created_at: string };

export class ResearchPythonEnvironmentRepository {
  constructor(private readonly db: Database, private readonly repository: ResearchRepository) {}

  findRequest(input: ResearchPythonEnvironmentSelect): ResearchPythonEnvironmentSelection | null {
    const request = researchPythonEnvironmentSelectSchema.parse(input);
    this.repository.getProject(request.projectId);
    const row = this.db.prepare('SELECT * FROM research_python_environment_selections WHERE project_id=? AND request_id=?')
      .get(request.projectId, request.requestId) as Row | undefined;
    return row === undefined ? null : this.inspect(row);
  }

  get(input: ResearchPythonEnvironmentGet): ResearchPythonEnvironmentSelection {
    const request = researchPythonEnvironmentGetSchema.parse(input);
    this.repository.getProject(request.projectId);
    const row = this.db.prepare('SELECT * FROM research_python_environment_selections WHERE id=?').get(request.selectionId) as Row | undefined;
    if (row === undefined) throw new Error('research_python_selection_not_found');
    if (row.project_id !== request.projectId) throw new Error('research_python_selection_project_mismatch');
    const value = this.inspect(row);
    if (value.snapshotHash !== request.expectedHash) throw new Error('research_python_selection_hash_mismatch');
    return value;
  }

  list(input: { projectId: string }): ResearchPythonEnvironmentSelection[] {
    const request = researchPythonEnvironmentListSchema.parse(input);
    this.repository.getProject(request.projectId);
    return (this.db.prepare('SELECT * FROM research_python_environment_selections WHERE project_id=? ORDER BY rowid')
      .all(request.projectId) as Row[]).map(row => this.inspect(row));
  }

  save(input: ResearchPythonEnvironmentSnapshot): ResearchPythonEnvironmentSelection {
    const snapshot = researchPythonEnvironmentSnapshotSchema.parse(input);
    return this.db.transaction(() => {
      if (this.repository.getProject(snapshot.request.projectId).status === 'archived') throw new Error('research_project_archived');
      const existing = this.findRequest(snapshot.request);
      if (existing !== null) throw new Error('research_python_selection_request_conflict');
      const json = JSON.stringify(snapshot), digest = researchContentHash(json);
      this.db.prepare(`INSERT INTO research_python_environment_selections
        (id,project_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?)`)
        .run(snapshot.id, snapshot.request.projectId, snapshot.request.requestId, json, digest, snapshot.recordedAt);
      return this.get({ projectId: snapshot.request.projectId, selectionId: snapshot.id, expectedHash: digest });
    })();
  }

  private inspect(row: Row): ResearchPythonEnvironmentSelection {
    const snapshot = researchPythonEnvironmentSnapshotSchema.parse(JSON.parse(row.snapshot_json));
    if (JSON.stringify(snapshot) !== row.snapshot_json || researchContentHash(row.snapshot_json) !== row.snapshot_hash
      || snapshot.id !== row.id || snapshot.request.projectId !== row.project_id || snapshot.request.requestId !== row.request_id
      || snapshot.recordedAt !== row.created_at || snapshot.requestHash !== researchContentHash(JSON.stringify(snapshot.request))) {
      throw new Error('research_python_selection_snapshot_invalid');
    }
    return researchPythonEnvironmentSelectionSchema.parse({ snapshot, snapshotHash: row.snapshot_hash });
  }
}
