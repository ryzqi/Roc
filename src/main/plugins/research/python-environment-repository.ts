import type { Database } from 'better-sqlite3';
import {
  researchPythonEnvironmentGetSchema, researchPythonEnvironmentListSchema, researchPythonEnvironmentPrepareSchema,
  researchPythonEnvironmentReceiptSchema, researchPythonEnvironmentSnapshotSchema,
  type ResearchPythonEnvironmentGet, type ResearchPythonEnvironmentPrepare, type ResearchPythonEnvironmentReceipt,
  type ResearchPythonEnvironmentSnapshot
} from '../../../shared/schemas/research-python-environments';
import { researchPythonEnvironmentOperationSchema, pythonEnvironmentActivePhases,
  type ResearchPythonEnvironmentOperation, type ResearchPythonEnvironmentStatus } from '../../../shared/schemas/research-python-environments';
import type { ResearchRepository } from './repository';
import { researchContentHash } from './research-files';

type Row = { id: string; project_id: string; request_id: string; snapshot_hash: string; snapshot_json: string; created_at: string };

export class ResearchPythonEnvironmentRepository {
  constructor(private readonly db: Database, private readonly repository: ResearchRepository) {}

  operation(projectId: string, operationId: string): ResearchPythonEnvironmentOperation {
    this.repository.getProject(projectId);
    const row = this.db.prepare('SELECT * FROM research_python_environment_operations WHERE id=?').get(operationId) as
      {id: string; project_id: string; request_id: string; phase: string; snapshot_json: string} | undefined;
    if (row === undefined || row.project_id !== projectId) throw new Error('research_python_operation_not_found');
    const value = researchPythonEnvironmentOperationSchema.parse(JSON.parse(row.snapshot_json));
    if (JSON.stringify(value) !== row.snapshot_json || value.id !== row.id || value.request.projectId !== row.project_id
      || value.request.requestId !== row.request_id || value.phase !== row.phase) throw new Error('research_python_operation_invalid');
    return value;
  }

  findOperation(request: ResearchPythonEnvironmentPrepare): ResearchPythonEnvironmentOperation | null {
    const row = this.db.prepare('SELECT id FROM research_python_environment_operations WHERE project_id=? AND request_id=?')
      .get(request.projectId, request.requestId) as {id: string} | undefined;
    return row === undefined ? null : this.operation(request.projectId, row.id);
  }

  status(input: {projectId: string}): ResearchPythonEnvironmentStatus {
    this.repository.getProject(input.projectId);
    const row = this.db.prepare('SELECT id FROM research_python_environment_operations WHERE project_id=? ORDER BY rowid DESC LIMIT 1')
      .get(input.projectId) as {id: string} | undefined;
    return {operation: row === undefined ? null : this.operation(input.projectId, row.id), environment: this.list(input).at(-1) ?? null};
  }

  saveOperation(input: ResearchPythonEnvironmentOperation): ResearchPythonEnvironmentOperation {
    const value = researchPythonEnvironmentOperationSchema.parse(input);
    this.repository.getProject(value.request.projectId);
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT project_id FROM research_python_environment_operations WHERE id=?').get(value.id) as {project_id: string} | undefined;
      if (row !== undefined) {
        const previous = this.operation(row.project_id, value.id);
        const identity = ({phase: _phase, errorCode: _error, environmentRef: _ref, updatedAt: _updated, ...rest}: ResearchPythonEnvironmentOperation) => rest;
        if (JSON.stringify(identity(previous)) !== JSON.stringify(identity(value))) throw new Error('research_python_operation_identity_changed');
        if (!pythonEnvironmentActivePhases.has(previous.phase)) {
          if (JSON.stringify(previous) !== JSON.stringify(value)) throw new Error('research_python_operation_terminal');
          return previous;
        }
      }
      this.db.prepare(`INSERT INTO research_python_environment_operations(id,project_id,request_id,phase,snapshot_json)
        VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,snapshot_json=excluded.snapshot_json`)
        .run(value.id, value.request.projectId, value.request.requestId, value.phase, JSON.stringify(value));
      return this.operation(value.request.projectId, value.id);
    })();
  }

  complete(operation: ResearchPythonEnvironmentOperation, snapshot: ResearchPythonEnvironmentSnapshot): ResearchPythonEnvironmentOperation {
    return this.db.transaction(() => {
      const current = this.operation(operation.request.projectId, operation.id);
      if (!pythonEnvironmentActivePhases.has(current.phase) || JSON.stringify(current) !== JSON.stringify(operation))
        throw new Error('research_python_operation_not_current');
      if (JSON.stringify(snapshot.request) !== JSON.stringify(operation.request) || JSON.stringify(snapshot.actor) !== JSON.stringify(operation.actor)
        || snapshot.workspacePath !== operation.workspacePath) throw new Error('research_python_operation_receipt_mismatch');
      const receipt = this.save(snapshot);
      return this.saveOperation({...operation, phase: 'ready', errorCode: null, updatedAt: snapshot.recordedAt,
        environmentRef: {projectId: snapshot.request.projectId, environmentId: snapshot.id, expectedHash: receipt.snapshotHash}});
    })();
  }

  recover(): void {
    const rows = this.db.prepare('SELECT id,project_id FROM research_python_environment_operations')
      .all() as Array<{id: string; project_id: string}>;
    for (const row of rows) {
      const operation = this.operation(row.project_id, row.id);
      if (pythonEnvironmentActivePhases.has(operation.phase)) this.saveOperation({...operation, phase: 'interrupted',
        errorCode: 'research_python_preparation_interrupted', updatedAt: new Date().toISOString()});
    }
  }

  findRequest(input: ResearchPythonEnvironmentPrepare): ResearchPythonEnvironmentReceipt | null {
    const request = researchPythonEnvironmentPrepareSchema.parse(input);
    this.repository.getProject(request.projectId);
    const row = this.db.prepare('SELECT * FROM research_python_environments WHERE project_id=? AND request_id=?')
      .get(request.projectId, request.requestId) as Row | undefined;
    return row === undefined ? null : this.inspect(row);
  }

  get(input: ResearchPythonEnvironmentGet): ResearchPythonEnvironmentReceipt {
    const request = researchPythonEnvironmentGetSchema.parse(input);
    this.repository.getProject(request.projectId);
    const row = this.db.prepare('SELECT * FROM research_python_environments WHERE id=?').get(request.environmentId) as Row | undefined;
    if (row === undefined) throw new Error('research_python_environment_not_found');
    if (row.project_id !== request.projectId) throw new Error('research_python_environment_project_mismatch');
    const value = this.inspect(row);
    if (value.snapshotHash !== request.expectedHash) throw new Error('research_python_environment_hash_mismatch');
    return value;
  }

  list(input: { projectId: string }): ResearchPythonEnvironmentReceipt[] {
    const request = researchPythonEnvironmentListSchema.parse(input);
    this.repository.getProject(request.projectId);
    return (this.db.prepare('SELECT * FROM research_python_environments WHERE project_id=? ORDER BY rowid')
      .all(request.projectId) as Row[]).map(row => this.inspect(row));
  }

  save(input: ResearchPythonEnvironmentSnapshot): ResearchPythonEnvironmentReceipt {
    const snapshot = researchPythonEnvironmentSnapshotSchema.parse(input);
    return this.db.transaction(() => {
      if (this.repository.getProject(snapshot.request.projectId).status === 'archived') throw new Error('research_project_archived');
      const existing = this.findRequest(snapshot.request);
      if (existing !== null) throw new Error('research_python_environment_request_conflict');
      const json = JSON.stringify(snapshot), digest = researchContentHash(json);
      this.db.prepare(`INSERT INTO research_python_environments
        (id,project_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?)`)
        .run(snapshot.id, snapshot.request.projectId, snapshot.request.requestId, json, digest, snapshot.recordedAt);
      return this.get({ projectId: snapshot.request.projectId, environmentId: snapshot.id, expectedHash: digest });
    })();
  }

  private inspect(row: Row): ResearchPythonEnvironmentReceipt {
    const snapshot = researchPythonEnvironmentSnapshotSchema.parse(JSON.parse(row.snapshot_json));
    if (JSON.stringify(snapshot) !== row.snapshot_json || researchContentHash(row.snapshot_json) !== row.snapshot_hash
      || snapshot.id !== row.id || snapshot.request.projectId !== row.project_id || snapshot.request.requestId !== row.request_id
      || snapshot.recordedAt !== row.created_at || snapshot.requestHash !== researchContentHash(JSON.stringify(snapshot.request))) {
      throw new Error('research_python_environment_snapshot_invalid');
    }
    return researchPythonEnvironmentReceiptSchema.parse({ snapshot, snapshotHash: row.snapshot_hash });
  }
}
