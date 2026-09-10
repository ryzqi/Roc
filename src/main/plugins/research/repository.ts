import { createHash, randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import {
  researchProjectSchema,
  researchStageStateSchema,
  researchWorkflowSnapshotSchema
} from '../../../shared/schemas/research';
import type {
  ResearchArtifact,
  ResearchEmbeddingConfigSaveRequest,
  ResearchExperimentRun,
  ResearchExperimentRunRecordRequest,
  ResearchFigure,
  ResearchFigureRecordRequest,
  ResearchKnowledgeDocumentUpsertRequest,
  ResearchKnowledgeSearchHit,
  ResearchKnowledgeSearchRequest,
  ResearchKnowledgeSearchResult,
  ResearchLiterature,
  ResearchLiteratureSearchRequest,
  ResearchProvenance,
  ResearchProvenanceCreateRequest,
  ResearchProvenanceListRequest,
  ResearchTemplate,
  ResearchTemplateCompileRequest,
  ResearchProject,
  ResearchProjectCreateRequest,
  ResearchProjectUpdateRequest,
  ResearchStageState,
  ResearchWorkflowSnapshot,
  ResearchWorkflowTransitionRequest
} from '../../../shared/types';

export const researchStages = [
  'discovery',
  'retrieval',
  'reading',
  'ideation',
  'planning',
  'experiment',
  'figure',
  'writing',
  'review',
  'revision',
  'export'
] as const;

type Clock = () => string;

const stageGateRequired = new Set<(typeof researchStages)[number]>([
  'retrieval',
  'reading',
  'ideation',
  'planning',
  'experiment',
  'figure',
  'writing',
  'review',
  'revision',
  'export'
]);

export class ResearchRepository {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly now: Clock = () => new Date().toISOString()
  ) {}

  listProjects(): ResearchProject[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, description, workspace_path, status, current_stage, created_at, updated_at
         FROM research_projects
         ORDER BY updated_at DESC`
      )
      .all() as ResearchProjectRow[];
    return rows.map((row) => toProject(row));
  }

  getProject(id: string): ResearchProject {
    const row = this.db
      .prepare(
        `SELECT id, title, description, workspace_path, status, current_stage, created_at, updated_at
         FROM research_projects WHERE id = ?`
      )
      .get(id) as ResearchProjectRow | undefined;
    if (row === undefined) {
      throw new Error(`research_project_not_found:${id}`);
    }
    return toProject(row);
  }

  createProject(request: ResearchProjectCreateRequest): ResearchProject {
    const id = `research_${randomUUID()}`;
    const timestamp = this.now();
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO research_projects
           (id, title, description, workspace_path, status, current_stage, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', 'discovery', ?, ?)`
        )
        .run(id, request.title, request.description, request.workspacePath, timestamp, timestamp);
      const insertStage = this.db.prepare(
        `INSERT INTO research_stage_states
         (project_id, stage, status, active_run_id, artifact_ids_json, entered_at, completed_at, gate_required, gate_approved, last_error)
         VALUES (?, ?, ?, NULL, '[]', ?, NULL, ?, 0, NULL)`
      );
      researchStages.forEach((stage, index) => {
        insertStage.run(
          id,
          stage,
          index === 0 ? 'ready' : 'locked',
          index === 0 ? timestamp : null,
          stageGateRequired.has(stage) ? 1 : 0
        );
      });
      this.appendEvent(id, 'discovery', 'project_created', '研究项目已创建。', { title: request.title }, timestamp);
    });
    insert();
    return this.getProject(id);
  }

  updateProject(request: ResearchProjectUpdateRequest): ResearchProject {
    this.getProject(request.id);
    const current = this.getProject(request.id);
    const timestamp = this.now();
    this.db
      .prepare(
        `UPDATE research_projects SET
         title = ?, description = ?, workspace_path = ?, status = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        request.title ?? current.title,
        request.description ?? current.description,
        request.workspacePath === undefined ? current.workspacePath : request.workspacePath,
        request.status ?? current.status,
        timestamp,
        request.id
      );
    return this.getProject(request.id);
  }

  upsertLiterature(record: ResearchLiterature): ResearchLiterature {
    this.db
      .prepare(
        `INSERT INTO research_literature_records
         (id, source, external_id, doi, title, authors_json, abstract, published_year, citation_count, url, open_access_url, imported_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, external_id) DO UPDATE SET
           doi = excluded.doi,
           title = excluded.title,
           authors_json = excluded.authors_json,
           abstract = excluded.abstract,
           published_year = excluded.published_year,
           citation_count = excluded.citation_count,
           url = excluded.url,
           open_access_url = excluded.open_access_url,
           updated_at = excluded.updated_at`
      )
      .run(
        record.id,
        record.source,
        record.externalId,
        record.doi,
        record.title,
        JSON.stringify(record.authors),
        record.abstract,
        record.publishedYear,
        record.citationCount,
        record.url,
        record.openAccessUrl,
        record.importedAt,
        record.updatedAt
      );
    return record;
  }

  recordExperimentRun(request: ResearchExperimentRunRecordRequest): ResearchExperimentRun {
    this.db
      .prepare(
        `INSERT INTO research_experiment_runs
         (id, project_id, label, command, parameters_json, environment_json, status, outputs_json, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           command = excluded.command,
           parameters_json = excluded.parameters_json,
           environment_json = excluded.environment_json,
           status = excluded.status,
           outputs_json = excluded.outputs_json,
           ended_at = excluded.ended_at`
      )
      .run(request.id, request.projectId, request.label, request.command, JSON.stringify(request.parameters), JSON.stringify(request.environment), request.status, JSON.stringify(request.outputs), request.startedAt, request.endedAt);
    return request;
  }

  recordFigure(request: ResearchFigureRecordRequest): ResearchFigure {
    const timestamp = this.now();
    this.db
      .prepare(
        `INSERT INTO research_figures
         (id, project_id, title, code_path, data_paths_json, output_paths_json, status, run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           code_path = excluded.code_path,
           data_paths_json = excluded.data_paths_json,
           output_paths_json = excluded.output_paths_json,
           status = excluded.status,
           run_id = excluded.run_id,
           updated_at = excluded.updated_at`
      )
      .run(request.id, request.projectId, request.title, request.codePath, JSON.stringify(request.dataPaths), JSON.stringify(request.outputPaths), request.status, request.runId, timestamp, timestamp);
    return { ...request, createdAt: timestamp, updatedAt: timestamp };
  }

  createArtifact(input: {
    projectId: string;
    stage: ResearchArtifact['stage'];
    kind: ResearchArtifact['kind'];
    title: string;
    path: string | null;
  }): ResearchArtifact {
    this.getProject(input.projectId);
    const timestamp = this.now();
    const id = 'artifact_' + randomUUID();
    this.db.prepare(
      `INSERT INTO research_artifacts
       (id, project_id, stage, kind, title, path, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
    ).run(id, input.projectId, input.stage, input.kind, input.title, input.path, timestamp, timestamp);
    this.attachArtifactToStage(input.projectId, input.stage, id);
    return this.getArtifact(id);
  }

  getArtifact(id: string): ResearchArtifact {
    const row = this.db.prepare(
      `SELECT id, project_id, stage, kind, title, path, status, created_at, updated_at
       FROM research_artifacts WHERE id = ?`
    ).get(id) as ArtifactRow | undefined;
    if (row === undefined) {
      throw new Error(`research_artifact_not_found:${id}`);
    }
    return toArtifact(row);
  }

  listArtifacts(projectId: string, stage?: ResearchStageState['stage']): ResearchArtifact[] {
    const rows = (stage === undefined
      ? this.db.prepare(
          `SELECT id, project_id, stage, kind, title, path, status, created_at, updated_at
           FROM research_artifacts WHERE project_id = ? ORDER BY updated_at DESC`
        ).all(projectId)
      : this.db.prepare(
          `SELECT id, project_id, stage, kind, title, path, status, created_at, updated_at
           FROM research_artifacts WHERE project_id = ? AND stage = ? ORDER BY updated_at DESC`
        ).all(projectId, stage)) as ArtifactRow[];
    return rows.map(toArtifact);
  }

  updateArtifact(input: {
    id: string;
    title?: string;
    path?: string | null;
    status?: ResearchArtifact['status'];
  }): ResearchArtifact {
    const current = this.getArtifact(input.id);
    this.db.prepare(
      `UPDATE research_artifacts SET title = ?, path = ?, status = ?, updated_at = ? WHERE id = ?`
    ).run(
      input.title ?? current.title,
      input.path === undefined ? current.path : input.path,
      input.status ?? current.status,
      this.now(),
      input.id
    );
    return this.getArtifact(input.id);
  }

  private attachArtifactToStage(projectId: string, stage: ResearchStageState['stage'], artifactId: string): void {
    const state = this.readStage(projectId, stage);
    this.db.prepare(
      'UPDATE research_stage_states SET artifact_ids_json = ? WHERE project_id = ? AND stage = ?'
    ).run(JSON.stringify([...state.artifactIds, artifactId]), projectId, stage);
  }

  createTemplate(input: { id: string; projectId: string; rootPath: string; entryPath: string }): ResearchTemplate {
    const timestamp = this.now();
    this.db
      .prepare(
        `INSERT INTO research_templates
         (id, project_id, root_path, entry_path, status, pdf_path, errors_json, last_compiled_at, updated_at)
         VALUES (?, ?, ?, ?, 'imported', NULL, '[]', NULL, ?)`
      )
      .run(input.id, input.projectId, input.rootPath, input.entryPath, timestamp);
    return this.getTemplate({ projectId: input.projectId, templateId: input.id });
  }

  getTemplate(input: ResearchTemplateCompileRequest): ResearchTemplate {
    const row = this.db
      .prepare(
        `SELECT id, project_id, root_path, entry_path, status, pdf_path, errors_json, last_compiled_at, updated_at
         FROM research_templates WHERE id = ? AND project_id = ?`
      )
      .get(input.templateId, input.projectId) as TemplateRow | undefined;
    if (row === undefined) throw new Error(`research_template_not_found:${input.templateId}`);
    return toTemplate(row);
  }

  updateTemplateCompile(input: {
    projectId: string;
    templateId: string;
    status: ResearchTemplate['status'];
    pdfPath: string | null;
    errors: readonly string[];
    lastCompiledAt: string | null;
  }): ResearchTemplate {
    this.getTemplate({ projectId: input.projectId, templateId: input.templateId });
    this.db
      .prepare(
        `UPDATE research_templates SET status = ?, pdf_path = ?, errors_json = ?, last_compiled_at = ?, updated_at = ?
         WHERE id = ? AND project_id = ?`
      )
      .run(input.status, input.pdfPath, JSON.stringify(input.errors), input.lastCompiledAt, this.now(), input.templateId, input.projectId);
    return this.getTemplate({ projectId: input.projectId, templateId: input.templateId });
  }

  addProvenance(request: ResearchProvenanceCreateRequest): ResearchProvenance {
    const record: ResearchProvenance = { ...request, id: randomUUID(), createdAt: this.now() };
    this.db
      .prepare(
        `INSERT INTO research_provenance
         (id, project_id, artifact_id, subject_type, subject_id, source_type, source_id, locator, excerpt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(record.id, record.projectId, record.artifactId, record.subjectType, record.subjectId, record.sourceType, record.sourceId, record.locator, record.excerpt, record.createdAt);
    return record;
  }

  listProvenance(request: ResearchProvenanceListRequest): ResearchProvenance[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, artifact_id, subject_type, subject_id, source_type, source_id, locator, excerpt, created_at
         FROM research_provenance WHERE project_id = ? ${request.subjectId === undefined ? '' : 'AND subject_id = ?'}
         ORDER BY created_at DESC`
      )
      .all(...(request.subjectId === undefined ? [request.projectId] : [request.projectId, request.subjectId])) as ProvenanceRow[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      artifactId: row.artifact_id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      locator: row.locator,
      excerpt: row.excerpt,
      createdAt: row.created_at
    }));
  }

  listLiterature(request: ResearchLiteratureSearchRequest): ResearchLiterature[] {
    const placeholders = request.sources.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT id, source, external_id, doi, title, authors_json, abstract, published_year,
                citation_count, url, open_access_url, imported_at, updated_at
         FROM research_literature_records
         WHERE source IN (${placeholders})
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(...request.sources, request.limit) as LiteratureRow[];
    return rows.map(toLiterature);
  }

  saveEmbeddingConfig(request: ResearchEmbeddingConfigSaveRequest, apiKeySecretKey: string): void {
    const timestamp = this.now();
    this.db
      .prepare(
        `INSERT INTO research_embedding_configs
         (id, name, base_url, model, dimensions, api_key_secret_key, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           base_url = excluded.base_url,
           model = excluded.model,
           dimensions = excluded.dimensions,
           api_key_secret_key = excluded.api_key_secret_key,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`
      )
      .run(
        request.id,
        request.name,
        request.baseUrl.replace(/\/+$/, ''),
        request.model,
        request.dimensions,
        apiKeySecretKey,
        request.enabled ? 1 : 0,
        timestamp,
        timestamp
      );
  }

  listEmbeddingConfigRows(): EmbeddingConfigRow[] {
    return this.db
      .prepare(
        `SELECT id, name, base_url, model, dimensions, api_key_secret_key, enabled, updated_at
         FROM research_embedding_configs ORDER BY updated_at DESC`
      )
      .all() as EmbeddingConfigRow[];
  }

  upsertKnowledgeDocument(request: ResearchKnowledgeDocumentUpsertRequest): void {
    const timestamp = this.now();
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO research_knowledge_documents
           (id, project_id, source_type, source_id, title, content, metadata_json, content_hash, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             project_id = excluded.project_id,
             source_type = excluded.source_type,
             source_id = excluded.source_id,
             title = excluded.title,
             content = excluded.content,
             content_hash = excluded.content_hash,
             indexed_at = excluded.indexed_at`
        )
        .run(request.id, request.projectId, request.sourceType, request.sourceId, request.title, request.content, hashText(request.content), timestamp);
      this.db.prepare('DELETE FROM research_knowledge_chunks WHERE document_id = ?').run(request.id);
      const insertChunk = this.db.prepare(
        `INSERT INTO research_knowledge_chunks
         (id, document_id, project_id, chunk_index, content, locator, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      request.chunks.forEach((chunk, index) => {
        insertChunk.run(`${request.id}:chunk:${index}`, request.id, request.projectId, index, chunk.content, chunk.locator, hashText(chunk.content), timestamp);
      });
    });
    write();
  }

  storeChunkEmbeddings(input: { model: string; dimensions: number; chunkIds: readonly string[]; vectors: readonly Buffer[] }): void {
    if (input.chunkIds.length !== input.vectors.length) {
      throw new Error('research_embedding_chunk_count_mismatch');
    }
    const write = this.db.transaction(() => {
      const statement = this.db.prepare(
        `INSERT INTO research_knowledge_embeddings (chunk_id, model, dimensions, vector_blob, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chunk_id, model) DO UPDATE SET
           dimensions = excluded.dimensions,
           vector_blob = excluded.vector_blob,
           created_at = excluded.created_at`
      );
      input.chunkIds.forEach((chunkId, index) => statement.run(chunkId, input.model, input.dimensions, input.vectors[index], this.now()));
    });
    write();
  }

  searchKnowledge(input: {
    request: ResearchKnowledgeSearchRequest;
    vector: { model: string; dimensions: number; blob: Buffer } | null;
  }): ResearchKnowledgeSearchResult {
    const keywordHits = this.keywordSearch(input.request.query, input.request.projectId, input.request.limit);
    const vectorHits = input.vector === null ? [] : this.vectorSearch(input.request.projectId, input.request.limit, input.vector);
    const merged = new Map<string, ResearchKnowledgeSearchHit>();
    keywordHits.forEach((hit, index) => {
      merged.set(hit.chunkId, { ...hit, keywordRank: index + 1, vectorRank: null, rrfScore: 1 / (60 + index + 1) });
    });
    vectorHits.forEach((hit, index) => {
      const existing = merged.get(hit.chunkId);
      const vectorScore = 1 / (60 + index + 1);
      if (existing === undefined) {
        merged.set(hit.chunkId, { ...hit, keywordRank: null, vectorRank: index + 1, rrfScore: vectorScore });
      } else {
        existing.vectorRank = index + 1;
        existing.rrfScore += vectorScore;
      }
    });
    const hits = Array.from(merged.values())
      .sort((left, right) => right.rrfScore - left.rrfScore)
      .slice(0, input.request.limit);
    return {
      query: input.request.query,
      hits,
      keywordCount: keywordHits.length,
      vectorCount: vectorHits.length,
      embeddingModel: input.vector?.model ?? null,
      generatedAt: this.now()
    };
  }

  private keywordSearch(query: string, projectId: string | null, limit: number): ResearchKnowledgeSearchHit[] {
    const match = query
      .split(/\s+/u)
      .map((term) => term.replace(/"/gu, ''))
      .filter((term) => term.length > 0)
      .map((term) => `"${term}"`)
      .join(' OR ');
    if (match.length === 0) return [];
    const projectClause = projectId === null ? '' : 'AND d.project_id = ?';
    const args = projectId === null ? [match, limit] : [match, projectId, limit];
    const rows = this.db
      .prepare(
        `SELECT c.id AS chunk_id, c.document_id, d.title, c.content, c.locator,
                d.source_type, d.source_id
         FROM research_knowledge_documents_fts f
         JOIN research_knowledge_documents d ON d.rowid = f.rowid
         JOIN research_knowledge_chunks c ON c.document_id = d.id
         WHERE research_knowledge_documents_fts MATCH ? ${projectClause}
         ORDER BY bm25(research_knowledge_documents_fts) ASC LIMIT ?`
      )
      .all(...args) as KnowledgeHitRow[];
    return rows.map((row) => toKnowledgeHit(row));
  }

  private vectorSearch(
    projectId: string | null,
    limit: number,
    vector: { model: string; dimensions: number; blob: Buffer }
  ): ResearchKnowledgeSearchHit[] {
    const projectClause = projectId === null ? '' : 'AND c.project_id = ?';
    const args = projectId === null
      ? [vector.model, vector.dimensions, vector.blob, limit]
      : [vector.model, vector.dimensions, projectId, vector.blob, limit];
    const rows = this.db
      .prepare(
        `SELECT e.chunk_id, c.document_id, d.title, c.content, c.locator,
                d.source_type, d.source_id
         FROM research_knowledge_embeddings e
         JOIN research_knowledge_chunks c ON c.id = e.chunk_id
         JOIN research_knowledge_documents d ON d.id = c.document_id
         WHERE e.model = ? AND e.dimensions = ? ${projectClause}
         ORDER BY vec_distance_cosine(e.vector_blob, ?) ASC LIMIT ?`
      )
      .all(...args) as KnowledgeHitRow[];
    return rows.map((row) => toKnowledgeHit(row));
  }

  getWorkflow(projectId: string): ResearchWorkflowSnapshot {
    const project = this.getProject(projectId);
    const rows = this.db
      .prepare(
        `SELECT stage, status, active_run_id, artifact_ids_json, entered_at, completed_at,
                gate_required, gate_approved, last_error
         FROM research_stage_states WHERE project_id = ? ORDER BY rowid ASC`
      )
      .all(projectId) as ResearchStageStateRow[];
    const stages = rows.map((row) => toStageState(row));
    const event = this.db
      .prepare(
        `SELECT type, stage, message, created_at
         FROM research_workflow_events WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(projectId) as ResearchEventRow | undefined;
    return researchWorkflowSnapshotSchema.parse({
      projectId,
      currentStage: project.currentStage,
      projectStatus: project.status,
      stages,
      lastEvent:
        event === undefined
          ? null
          : { type: event.type, stage: event.stage, message: event.message, createdAt: event.created_at }
    });
  }

  transitionWorkflow(request: ResearchWorkflowTransitionRequest): ResearchWorkflowSnapshot {
    const project = this.getProject(request.projectId);
    if (project.currentStage !== request.expectedStage) {
      throw new Error(`research_workflow_stage_conflict:${project.currentStage}`);
    }
    const current = this.readStage(request.projectId, project.currentStage);
    const timestamp = this.now();
    const transition = this.db.transaction(() => {
      switch (request.action) {
        case 'start':
          this.requireStatus(current, ['ready'], 'research_stage_not_ready');
          this.updateStage(request.projectId, current.stage, { status: 'running', enteredAt: current.enteredAt ?? timestamp });
          this.updateProjectStatus(request.projectId, 'active', timestamp);
          this.appendEvent(request.projectId, current.stage, 'stage_started', '阶段已开始。', request, timestamp);
          break;
        case 'resume':
          this.requireStatus(current, ['paused'], 'research_stage_not_paused');
          this.updateStage(request.projectId, current.stage, { status: 'running' });
          this.updateProjectStatus(request.projectId, 'active', timestamp);
          this.appendEvent(request.projectId, current.stage, 'stage_resumed', '阶段已恢复。', request, timestamp);
          break;
        case 'pause':
          this.requireStatus(current, ['running'], 'research_stage_not_running');
          this.updateStage(request.projectId, current.stage, { status: 'paused' });
          this.updateProjectStatus(request.projectId, 'paused', timestamp);
          this.appendEvent(request.projectId, current.stage, 'stage_paused', request.note ?? '阶段已暂停。', request, timestamp);
          break;
        case 'complete':
          this.requireStatus(current, ['running'], 'research_stage_not_running');
          if (current.gateRequired) {
            if (current.artifactIds.length === 0) {
              throw new Error('research_stage_artifact_required');
            }
            this.updateStage(request.projectId, current.stage, { status: 'waiting_approval' });
            this.appendEvent(request.projectId, current.stage, 'approval_requested', '阶段产物等待用户审核。', request, timestamp);
          } else {
            this.completeStage(request.projectId, current.stage, timestamp);
          }
          break;
        case 'approve':
          this.requireStatus(current, ['waiting_approval'], 'research_stage_not_waiting_approval');
          current.artifactIds.forEach((artifactId) => {
            this.updateArtifact({ id: artifactId, status: 'approved' });
          });
          this.updateStage(request.projectId, current.stage, { gateApproved: true });
          this.completeStage(request.projectId, current.stage, timestamp);
          break;
        case 'reject':
          this.requireStatus(current, ['waiting_approval'], 'research_stage_not_waiting_approval');
          this.updateStage(request.projectId, current.stage, { status: 'running', gateApproved: false, lastError: request.note ?? '用户要求修改。' });
          this.appendEvent(request.projectId, current.stage, 'approval_rejected', request.note ?? '用户要求修改。', request, timestamp);
          break;
      }
    });
    transition();
    return this.getWorkflow(request.projectId);
  }

  private completeStage(projectId: string, stage: ResearchStageState['stage'], timestamp: string): void {
    const index = researchStages.indexOf(stage);
    const nextStage = researchStages[index + 1];
    this.updateStage(projectId, stage, { status: 'completed', completedAt: timestamp });
    if (nextStage === undefined) {
      this.updateProjectStatus(projectId, 'completed', timestamp);
      this.appendEvent(projectId, stage, 'workflow_completed', '科研流程已完成。', {}, timestamp);
      return;
    }
    this.updateStage(projectId, nextStage, { status: 'ready', enteredAt: timestamp });
    this.db.prepare('UPDATE research_projects SET current_stage = ?, updated_at = ? WHERE id = ?').run(nextStage, timestamp, projectId);
    this.appendEvent(projectId, stage, 'stage_completed', `阶段已完成，下一阶段为 ${nextStage}。`, { nextStage }, timestamp);
  }

  private readStage(projectId: string, stage: ResearchStageState['stage']): ResearchStageState {
    const row = this.db
      .prepare(
        `SELECT stage, status, active_run_id, artifact_ids_json, entered_at, completed_at,
                gate_required, gate_approved, last_error
         FROM research_stage_states WHERE project_id = ? AND stage = ?`
      )
      .get(projectId, stage) as ResearchStageStateRow | undefined;
    if (row === undefined) {
      throw new Error(`research_stage_not_found:${stage}`);
    }
    return toStageState(row);
  }

  private updateStage(
    projectId: string,
    stage: ResearchStageState['stage'],
    update: Partial<Pick<ResearchStageState, 'status' | 'activeRunId' | 'enteredAt' | 'completedAt' | 'gateApproved' | 'lastError'>>
  ): void {
    const current = this.readStage(projectId, stage);
    this.db
      .prepare(
        `UPDATE research_stage_states SET status = ?, active_run_id = ?, entered_at = ?, completed_at = ?,
         gate_approved = ?, last_error = ? WHERE project_id = ? AND stage = ?`
      )
      .run(
        update.status ?? current.status,
        update.activeRunId === undefined ? current.activeRunId : update.activeRunId,
        update.enteredAt === undefined ? current.enteredAt : update.enteredAt,
        update.completedAt === undefined ? current.completedAt : update.completedAt,
        update.gateApproved === undefined ? (current.gateApproved ? 1 : 0) : update.gateApproved ? 1 : 0,
        update.lastError === undefined ? current.lastError : update.lastError,
        projectId,
        stage
      );
  }

  private updateProjectStatus(projectId: string, status: ResearchProject['status'], timestamp: string): void {
    this.db.prepare('UPDATE research_projects SET status = ?, updated_at = ? WHERE id = ?').run(status, timestamp, projectId);
  }

  private appendEvent(projectId: string, stage: string, type: string, message: string, payload: unknown, createdAt: string): void {
    this.db
      .prepare(
        `INSERT INTO research_workflow_events
         (id, project_id, stage, type, message, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), projectId, stage, type, message, JSON.stringify(payload), createdAt);
  }

  private requireStatus(current: ResearchStageState, allowed: ResearchStageState['status'][], code: string): void {
    if (!allowed.includes(current.status)) {
      throw new Error(`${code}:${current.stage}:${current.status}`);
    }
  }
}

type ResearchProjectRow = {
  id: string;
  title: string;
  description: string;
  workspace_path: string | null;
  status: ResearchProject['status'];
  current_stage: ResearchProject['currentStage'];
  created_at: string;
  updated_at: string;
};

type ResearchStageStateRow = {
  stage: ResearchStageState['stage'];
  status: ResearchStageState['status'];
  active_run_id: string | null;
  artifact_ids_json: string;
  entered_at: string | null;
  completed_at: string | null;
  gate_required: number;
  gate_approved: number;
  last_error: string | null;
};

type ResearchEventRow = {
  type: string;
  stage: ResearchStageState['stage'];
  message: string;
  created_at: string;
};

export type EmbeddingConfigRow = {
  id: string;
  name: string;
  base_url: string;
  model: string;
  dimensions: number;
  api_key_secret_key: string;
  enabled: number;
  updated_at: string;
};

type LiteratureRow = {
  id: string;
  source: ResearchLiterature['source'];
  external_id: string;
  doi: string | null;
  title: string;
  authors_json: string;
  abstract: string | null;
  published_year: number | null;
  citation_count: number | null;
  url: string | null;
  open_access_url: string | null;
  imported_at: string;
  updated_at: string;
};

type KnowledgeHitRow = {
  chunk_id: string;
  document_id: string;
  title: string;
  content: string;
  locator: string | null;
  source_type: string;
  source_id: string;
};

type ProvenanceRow = {
  id: string;
  project_id: string;
  artifact_id: string | null;
  subject_type: ResearchProvenance['subjectType'];
  subject_id: string;
  source_type: ResearchProvenance['sourceType'];
  source_id: string;
  locator: string | null;
  excerpt: string | null;
  created_at: string;
};

type TemplateRow = {
  id: string;
  project_id: string;
  root_path: string;
  entry_path: string;
  status: ResearchTemplate['status'];
  pdf_path: string | null;
  errors_json: string;
  last_compiled_at: string | null;
  updated_at: string;
};

type ArtifactRow = {
  id: string;
  project_id: string;
  stage: ResearchArtifact['stage'];
  kind: ResearchArtifact['kind'];
  title: string;
  path: string | null;
  status: ResearchArtifact['status'];
  created_at: string;
  updated_at: string;
};

function toProject(row: ResearchProjectRow): ResearchProject {
  return researchProjectSchema.parse({
    id: row.id,
    title: row.title,
    description: row.description,
    workspacePath: row.workspace_path,
    status: row.status,
    currentStage: row.current_stage,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function toStageState(row: ResearchStageStateRow): ResearchStageState {
  let artifactIds: unknown;
  try {
    artifactIds = JSON.parse(row.artifact_ids_json);
  } catch {
    throw new Error('research_stage_artifacts_invalid');
  }
  return researchStageStateSchema.parse({
    stage: row.stage,
    status: row.status,
    activeRunId: row.active_run_id,
    artifactIds,
    enteredAt: row.entered_at,
    completedAt: row.completed_at,
    gateRequired: row.gate_required === 1,
    gateApproved: row.gate_approved === 1,
    lastError: row.last_error
  });
}

function toLiterature(row: LiteratureRow): ResearchLiterature {
  let authors: unknown;
  try {
    authors = JSON.parse(row.authors_json);
  } catch {
    throw new Error('research_literature_authors_invalid');
  }
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    doi: row.doi,
    title: row.title,
    authors: Array.isArray(authors) ? authors.filter((author): author is string => typeof author === 'string') : [],
    abstract: row.abstract,
    publishedYear: row.published_year,
    citationCount: row.citation_count,
    url: row.url,
    openAccessUrl: row.open_access_url,
    importedAt: row.imported_at,
    updatedAt: row.updated_at
  };
}

function toTemplate(row: TemplateRow): ResearchTemplate {
  let errors: unknown;
  try {
    errors = JSON.parse(row.errors_json);
  } catch {
    throw new Error('research_template_errors_invalid');
  }
  return {
    id: row.id,
    projectId: row.project_id,
    rootPath: row.root_path,
    entryPath: row.entry_path,
    status: row.status,
    pdfPath: row.pdf_path,
    errors: Array.isArray(errors) ? errors.filter((error): error is string => typeof error === 'string') : [],
    lastCompiledAt: row.last_compiled_at,
    updatedAt: row.updated_at
  };
}

function toArtifact(row: ArtifactRow): ResearchArtifact {
  return {
    id: row.id,
    projectId: row.project_id,
    stage: row.stage,
    kind: row.kind,
    title: row.title,
    path: row.path,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toKnowledgeHit(row: KnowledgeHitRow): ResearchKnowledgeSearchHit {
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    title: row.title,
    content: row.content,
    locator: row.locator,
    sourceType: row.source_type,
    sourceId: row.source_id,
    keywordRank: null,
    vectorRank: null,
    rrfScore: 0
  };
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
