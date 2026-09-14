import { createHash, randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import {
  researchProjectSchema,
  researchKnowledgeDocumentSchema,
  researchTemplateSchema,
  researchStageStateSchema,
  researchWorkflowEventSchema,
  researchWorkflowSnapshotSchema
} from '../../../shared/schemas/research';
import type {
  ResearchArtifact,
  ResearchArtifactCreateRequest,
  ResearchArtifactUpdateRequest,
  ResearchWorkflowEvent,
  ResearchWorkflowEventsRequest,
  ResearchEmbeddingConfigSaveRequest,
  ResearchExperimentRun,
  ResearchExperimentRunRecordRequest,
  ResearchFigure,
  ResearchFigureRecordRequest,
  ResearchKnowledgeDocumentUpsertRequest,
  ResearchKnowledgeDocument,
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
import { getResearchStageRoleProfile } from './role-profiles';
import { ResearchEvidenceRepository } from './evidence-repository';
import { ResearchRunRepository } from './run-repository';
import { ResearchReviewRepository } from './review-repository';
import { ResearchLibraryRepository } from './library-repository';
import { ResearchDocumentRepository } from './document-repository';
import { ResearchIndexRepository } from './index-repository';
import { ResearchExperimentRepository } from './experiment-repository';
import { ResearchFigureRepository } from './figure-repository';
import { ResearchExportRepository } from './export-repository';
import { normalizeEmbeddingBlob } from './embedding-vectors';

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
  readonly evidence: ResearchEvidenceRepository;
  readonly runs: ResearchRunRepository;
  readonly reviews: ResearchReviewRepository;
  readonly library: ResearchLibraryRepository;
  readonly documents: ResearchDocumentRepository;
  readonly indexing: ResearchIndexRepository;
  readonly experiments: ResearchExperimentRepository;
  readonly figures: ResearchFigureRepository;
  readonly exports: ResearchExportRepository;

  constructor(
    private readonly db: DatabaseConnection,
    private readonly now: Clock = () => new Date().toISOString()
  ) {
    this.evidence = new ResearchEvidenceRepository(db, {
      get: (id) => this.getArtifact(id),
      requireEditable: (id) => this.requireEditableArtifact(id)
    }, now);
    this.runs = new ResearchRunRepository(db, this, now);
    this.reviews = new ResearchReviewRepository(db, this, now);
    this.library = new ResearchLibraryRepository(db, this, now);
    this.documents = new ResearchDocumentRepository(db, this, now);
    this.indexing = new ResearchIndexRepository(db, this, now);
    this.experiments = new ResearchExperimentRepository(db, this, now);
    this.figures = new ResearchFigureRepository(db, this, now);
    this.exports = new ResearchExportRepository(db, this, now);
  }

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
      this.runs.initializeProject(id);
      this.indexing.initializeProject(id);
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
    this.getProject(request.projectId);
    if (this.experiments.managed(request.id)) throw new Error('research_experiment_execution_immutable');
    const previous = this.db.prepare('SELECT project_id FROM research_experiment_runs WHERE id = ?').get(request.id) as { project_id: string } | undefined;
    if (previous !== undefined && previous.project_id !== request.projectId) throw new Error('research_experiment_project_mismatch');
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
    this.getProject(request.projectId);
    if (this.figures.managed(request.id)) throw new Error('research_figure_publication_immutable');
    const previous = this.db.prepare('SELECT project_id,created_at FROM research_figures WHERE id = ?').get(request.id) as { project_id: string; created_at: string } | undefined;
    if (previous !== undefined && previous.project_id !== request.projectId) throw new Error('research_figure_project_mismatch');
    if (request.runId !== null) {
      const run = this.db.prepare('SELECT project_id FROM research_experiment_runs WHERE id = ?').get(request.runId) as { project_id: string } | undefined;
      if (run === undefined || run.project_id !== request.projectId) throw new Error('research_figure_run_invalid');
    }
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
    return { ...request, createdAt: previous?.created_at ?? timestamp, updatedAt: timestamp };
  }

  createArtifact(input: ResearchArtifactCreateRequest): ResearchArtifact {
    return this.db.transaction(() => {
      this.requireEditableStage(input.projectId, input.stage);
      if (input.kind !== getResearchStageRoleProfile(input.stage).outputKind) {
        throw new Error('research_artifact_kind_mismatch');
      }
      const timestamp = this.now();
      const id = `artifact_${randomUUID()}`;
      this.db.prepare(
        `INSERT INTO research_artifacts
         (id, project_id, stage, kind, title, path, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
      ).run(id, input.projectId, input.stage, input.kind, input.title, input.path, timestamp, timestamp);
      this.attachArtifactToStage(input.projectId, input.stage, id);
      this.appendEvent(input.projectId, input.stage, 'artifact_created', input.title, { artifactId: id }, timestamp);
      return this.getArtifact(id);
    })();
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
    this.getProject(projectId);
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

  updateArtifact(input: ResearchArtifactUpdateRequest): ResearchArtifact {
    const current = this.requireEditableArtifact(input.id);
    if (this.experiments.hasArtifact(input.id)) throw new Error('research_experiment_publication_immutable');
    if (this.figures.hasArtifact(input.id)) throw new Error('research_figure_publication_immutable');
    if (this.exports.hasArtifact(input.id)) throw new Error('research_export_publication_immutable');
    const timestamp = this.now();
    return this.db.transaction(() => {
      this.db.prepare(
        `UPDATE research_artifacts SET title = ?, path = ?, updated_at = ? WHERE id = ?`
      ).run(
        input.title ?? current.title,
        input.path === undefined ? current.path : input.path,
        timestamp,
        input.id
      );
      this.appendEvent(current.projectId, current.stage, 'artifact_updated', input.title ?? current.title, { artifactId: input.id }, timestamp);
      return this.getArtifact(input.id);
    })();
  }

  supersedeArtifact(previousId: string, replacementId: string): void {
    this.db.transaction(() => {
      const previous = this.requireEditableArtifact(previousId);
      const replacement = this.requireEditableArtifact(replacementId);
      const stage = this.readStage(previous.projectId, previous.stage);
      if (previous.id === replacement.id || previous.projectId !== replacement.projectId || previous.stage !== replacement.stage
        || !stage.artifactIds.includes(previousId) || !stage.artifactIds.includes(replacementId)) throw new Error('research_artifact_replacement_invalid');
      this.db.prepare("UPDATE research_artifacts SET status = 'superseded', updated_at = ? WHERE id = ?").run(this.now(), previousId);
      this.db.prepare('UPDATE research_stage_states SET artifact_ids_json = ? WHERE project_id = ? AND stage = ?')
        .run(JSON.stringify(stage.artifactIds.filter((id) => id !== previousId)), previous.projectId, previous.stage);
    })();
  }

  private requireEditableStage(projectId: string, stage: ResearchStageState['stage']): ResearchStageState {
    const project = this.getProject(projectId);
    if (project.status === 'archived') throw new Error('research_project_archived');
    if (project.currentStage !== stage) throw new Error('research_artifact_stage_inactive');
    const state = this.readStage(projectId, stage);
    this.requireStatus(state, ['ready', 'running', 'paused', 'blocked', 'failed'], 'research_stage_not_editable');
    return state;
  }

  private requireEditableArtifact(id: string): ResearchArtifact {
    const artifact = this.getArtifact(id);
    if (artifact.status !== 'draft') throw new Error('research_artifact_immutable');
    this.requireEditableStage(artifact.projectId, artifact.stage);
    return artifact;
  }

  private attachArtifactToStage(projectId: string, stage: ResearchStageState['stage'], artifactId: string): void {
    const state = this.readStage(projectId, stage);
    this.db.prepare(
      'UPDATE research_stage_states SET artifact_ids_json = ? WHERE project_id = ? AND stage = ?'
    ).run(JSON.stringify([...state.artifactIds, artifactId]), projectId, stage);
  }

  createTemplate(input: { id: string; projectId: string; rootPath: string; entryPath: string; sourceDigest: string }): ResearchTemplate {
    this.getProject(input.projectId);
    return this.db.transaction(() => {
      const timestamp = this.now();
      this.db.prepare(
        `INSERT INTO research_templates
         (id, project_id, root_path, entry_path, status, pdf_path, errors_json, last_compiled_at, updated_at, source_digest)
         VALUES (?, ?, ?, ?, 'imported', NULL, '[]', NULL, ?, ?)`
      ).run(input.id, input.projectId, input.rootPath, input.entryPath, timestamp, input.sourceDigest);
      const template = this.getTemplate({ projectId: input.projectId, templateId: input.id });
      this.recordTemplateEvent(template, 'template_imported', '已导入 LaTeX 模板。');
      return template;
    })();
  }

  getTemplate(input: ResearchTemplateCompileRequest): ResearchTemplate {
    const row = this.db
      .prepare(
        'SELECT * FROM research_templates WHERE id = ? AND project_id = ?'
      )
      .get(input.templateId, input.projectId) as TemplateRow | undefined;
    if (row === undefined) throw new Error(`research_template_not_found:${input.templateId}`);
    return toTemplate(row);
  }

  listTemplates(projectId: string): ResearchTemplate[] {
    this.getProject(projectId);
    return (this.db.prepare('SELECT * FROM research_templates WHERE project_id = ? ORDER BY updated_at DESC, id')
      .all(projectId) as TemplateRow[]).map(toTemplate);
  }

  saveTemplate(input: ResearchTemplate, expectedRevision: number): ResearchTemplate {
    const next = researchTemplateSchema.parse(input);
    return this.db.transaction(() => {
      const current = this.getTemplate({ projectId: next.projectId, templateId: next.id });
      if (next.rootPath !== current.rootPath) throw new Error('research_template_root_immutable');
      if (next.revision !== current.revision && next.revision !== current.revision + 1) throw new Error('research_template_version_invalid');
      const result = this.db.prepare(`UPDATE research_templates SET entry_path = ?, status = ?, pdf_path = ?, errors_json = ?,
        diagnostics_json = ?, revision = ?, compiled_revision = ?, source_digest = ?, compiled_digest = ?, pdf_hash = ?,
        active_compile_id = ?, last_compiled_at = ?, updated_at = ? WHERE id = ? AND project_id = ? AND revision = ?`)
        .run(next.entryPath, next.status, next.pdfPath, JSON.stringify(next.errors), JSON.stringify(next.diagnostics),
          next.revision, next.compiledRevision, next.sourceDigest, next.compiledDigest, next.pdfHash, next.activeCompileId,
          next.lastCompiledAt, this.now(), next.id, next.projectId, expectedRevision);
      if (result.changes !== 1) throw new Error('research_template_version_conflict');
      const saved = this.getTemplate({ projectId: next.projectId, templateId: next.id });
      if (next.status !== 'imported' && (current.status !== next.status || current.activeCompileId !== next.activeCompileId)) {
        const messages = { compiling: 'LaTeX 编译已开始。', ready: 'PDF 预览已更新。', failed: 'LaTeX 编译失败或已取消。' };
        this.recordTemplateEvent(saved, `template_compile_${next.status}`, messages[next.status]);
      }
      return saved;
    })();
  }

  recoverTemplateCompiles(): void {
    this.db.prepare(`UPDATE research_templates SET status = 'failed', active_compile_id = NULL,
      errors_json = '["research_compile_interrupted"]',
      diagnostics_json = '[{"severity":"error","message":"上次编译已中断，请重新编译。","file":null,"line":null}]',
      updated_at = ? WHERE status = 'compiling'`).run(this.now());
  }

  private recordTemplateEvent(template: ResearchTemplate, type: string, message: string): void {
    const project = this.getProject(template.projectId);
    this.appendEvent(project.id, project.currentStage, type, message, { templateId: template.id, revision: template.revision }, this.now());
  }

  addProvenance(request: ResearchProvenanceCreateRequest): ResearchProvenance {
    this.getProject(request.projectId);
    if (request.artifactId !== null && this.getArtifact(request.artifactId).projectId !== request.projectId) {
      throw new Error('research_provenance_project_mismatch');
    }
    if (request.subjectType === 'artifact') {
      if (this.getArtifact(request.subjectId).projectId !== request.projectId) {
        throw new Error('research_provenance_project_mismatch');
      }
      if (request.artifactId !== request.subjectId) {
        throw new Error('research_provenance_artifact_mismatch');
      }
    } else if (request.subjectType === 'claim' || request.subjectType === 'paragraph' || request.subjectType === 'figure_claim') {
      const claim = this.evidence.getClaim(request.subjectId);
      if (claim.projectId !== request.projectId) throw new Error('research_provenance_project_mismatch');
      const claimSubjectType = request.subjectType === 'figure_claim' ? 'figure' : request.subjectType;
      if (claim.artifactId !== request.artifactId || claim.subjectType !== claimSubjectType) {
        throw new Error('research_provenance_subject_mismatch');
      }
    } else if (request.subjectType === 'figure') {
      const figure = this.db.prepare('SELECT project_id FROM research_figures WHERE id = ?')
        .get(request.subjectId) as { project_id: string } | undefined;
      if (figure === undefined) throw new Error('research_figure_not_found');
      if (figure.project_id !== request.projectId) throw new Error('research_provenance_project_mismatch');
    } else {
      const experiment = this.db.prepare('SELECT project_id FROM research_experiment_runs WHERE id = ?')
        .get(request.subjectId) as { project_id: string } | undefined;
      if (experiment === undefined) throw new Error('research_experiment_not_found');
      if (experiment.project_id !== request.projectId) throw new Error('research_provenance_project_mismatch');
    }
    if (request.artifactId !== null) this.requireEditableArtifact(request.artifactId);
    if (request.sourceType === 'model_run') this.runs.get(request.sourceId, request.projectId);
    if (request.sourceType === 'experiment') {
      const source = this.db.prepare('SELECT project_id,status FROM research_experiment_runs WHERE id = ?').get(request.sourceId) as { project_id: string; status: string } | undefined;
      if (source === undefined || source.project_id !== request.projectId || source.status !== 'completed') throw new Error('research_provenance_source_invalid');
    }
    if (request.sourceType === 'workflow_event') {
      const event = this.db.prepare('SELECT project_id FROM research_workflow_events WHERE id = ?')
        .get(request.sourceId) as { project_id: string } | undefined;
      if (event === undefined || event.project_id !== request.projectId) throw new Error('research_provenance_source_invalid');
    }
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
           revision = CASE WHEN base_url <> excluded.base_url OR model <> excluded.model OR dimensions <> excluded.dimensions
             OR api_key_secret_key <> excluded.api_key_secret_key OR enabled <> excluded.enabled THEN revision + 1 ELSE revision END,
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
        `SELECT id, name, base_url, model, dimensions, api_key_secret_key, enabled, updated_at, revision
         FROM research_embedding_configs ORDER BY updated_at DESC`
      )
      .all() as EmbeddingConfigRow[];
  }

  upsertKnowledgeDocument(request: ResearchKnowledgeDocumentUpsertRequest, sourceMetadata: Record<string, unknown> = {}): ResearchKnowledgeDocument {
    if (request.projectId !== null) this.getProject(request.projectId);
    const existing = this.db.prepare('SELECT project_id FROM research_knowledge_documents WHERE id = ?').get(request.id) as { project_id: string | null } | undefined;
    if (existing !== undefined && existing.project_id !== request.projectId) throw new Error('research_knowledge_project_mismatch');
    const timestamp = this.now();
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO research_knowledge_documents
           (id, project_id, source_type, source_id, title, content, metadata_json, content_hash, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             project_id = excluded.project_id,
             source_type = excluded.source_type,
             source_id = excluded.source_id,
             title = excluded.title,
             content = excluded.content,
             metadata_json = excluded.metadata_json,
             content_hash = excluded.content_hash,
             indexed_at = excluded.indexed_at`
        )
        .run(request.id, request.projectId, request.sourceType, request.sourceId, request.title, request.content, JSON.stringify(sourceMetadata), hashText(request.content), timestamp);
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
    return { id: request.id, projectId: request.projectId, sourceType: request.sourceType, sourceId: request.sourceId,
      title: request.title, content: request.content, indexedAt: timestamp };
  }

  requireEmbeddingConfig(id: string, revision: number): EmbeddingConfigRow {
    const row = this.listEmbeddingConfigRows().find((entry) => entry.id === id);
    if (row === undefined) throw new Error('research_embedding_config_not_found');
    if (row.revision !== revision) throw new Error('research_embedding_config_changed');
    if (row.enabled !== 1) throw new Error('research_embedding_config_disabled');
    return row;
  }

  knowledgeChunks(documentId: string): Array<{ id: string; content: string; contentHash: string }> {
    return this.db.prepare('SELECT id,content,content_hash AS contentHash FROM research_knowledge_chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(documentId) as Array<{ id: string; content: string; contentHash: string }>;
  }

  knowledgeDocument(id: string): ResearchKnowledgeDocument {
    const row = this.db.prepare(`SELECT id,project_id AS projectId,source_type AS sourceType,source_id AS sourceId,title,content,indexed_at AS indexedAt
      FROM research_knowledge_documents WHERE id = ?`).get(id);
    if (row === undefined) throw new Error('research_knowledge_document_not_found');
    return researchKnowledgeDocumentSchema.parse(row);
  }

  storeChunkEmbeddings(input: { configId: string; configRevision: number; chunks: readonly { id: string; contentHash: string }[]; vectors: readonly Buffer[] }): void {
    if (input.chunks.length !== input.vectors.length || new Set(input.chunks.map((chunk) => chunk.id)).size !== input.chunks.length) {
      throw new Error('research_embedding_chunk_count_mismatch');
    }
    const write = this.db.transaction(() => {
      const config = this.requireEmbeddingConfig(input.configId, input.configRevision);
      const vectors: Buffer[] = [];
      for (const [index, chunk] of input.chunks.entries()) {
        const current = this.db.prepare('SELECT content_hash FROM research_knowledge_chunks WHERE id = ?').get(chunk.id) as { content_hash: string } | undefined;
        if (current === undefined || current.content_hash !== chunk.contentHash) throw new Error('research_embedding_source_changed');
        vectors.push(normalizeEmbeddingBlob(input.vectors[index], config.dimensions));
      }
      const statement = this.db.prepare(
        `INSERT INTO research_knowledge_embeddings (chunk_id, space_key, dimensions, vector_blob, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chunk_id, space_key) DO UPDATE SET
           dimensions = excluded.dimensions,
           vector_blob = excluded.vector_blob,
           created_at = excluded.created_at`
      );
      input.chunks.forEach((chunk, index) => statement.run(chunk.id, embeddingSpaceKey(config.id, config.revision), config.dimensions, vectors[index], this.now()));
    });
    write();
  }

  searchKnowledge(input: {
    request: ResearchKnowledgeSearchRequest;
    vector: { configId: string; configRevision: number; blob: Buffer } | null;
  }): ResearchKnowledgeSearchResult {
    const keywordHits = this.keywordSearch(input.request.query, input.request.projectId, input.request.limit);
    const config = input.vector === null ? null : this.requireEmbeddingConfig(input.vector.configId, input.vector.configRevision);
    const vectorHits = input.vector === null || config === null ? [] : this.vectorSearch(input.request.projectId, input.request.limit,
      { spaceKey: embeddingSpaceKey(config.id, config.revision), dimensions: config.dimensions, blob: input.vector.blob });
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
      embeddingModel: config?.model ?? null,
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
    const projectClause = projectId === null ? '' : 'AND (d.project_id = ? OR d.project_id IS NULL)';
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
    vector: { spaceKey: string; dimensions: number; blob: Buffer }
  ): ResearchKnowledgeSearchHit[] {
    const blob = normalizeEmbeddingBlob(vector.blob, vector.dimensions);
    const projectClause = projectId === null ? '' : 'AND (c.project_id = ? OR c.project_id IS NULL)';
    const args = projectId === null
      ? [vector.spaceKey, vector.dimensions, blob, limit]
      : [vector.spaceKey, vector.dimensions, projectId, blob, limit];
    const rows = this.db
      .prepare(
        `SELECT e.chunk_id, c.document_id, d.title, c.content, c.locator,
                d.source_type, d.source_id
         FROM research_knowledge_embeddings e
         JOIN research_knowledge_chunks c ON c.id = e.chunk_id
         JOIN research_knowledge_documents d ON d.id = c.document_id
         WHERE e.space_key = ? AND e.dimensions = ? ${projectClause}
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
    if (project.status === 'archived') throw new Error('research_project_archived');
    if (project.currentStage !== request.expectedStage) {
      throw new Error(`research_workflow_stage_conflict:${project.currentStage}`);
    }
    const current = this.readStage(request.projectId, project.currentStage);
    const timestamp = this.now();
    const transition = this.db.transaction(() => {
      switch (request.action) {
        case 'start':
          this.requireStatus(current, ['ready'], 'research_stage_not_ready');
          this.updateStage(request.projectId, current.stage, { status: 'running', enteredAt: current.enteredAt ?? timestamp, lastError: null });
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
          if (current.activeRunId !== null) throw new Error('research_stage_run_active');
          if (current.gateRequired) {
            this.requireStageArtifacts(request.projectId, current);
            this.updateStage(request.projectId, current.stage, { status: 'waiting_approval' });
            this.appendEvent(request.projectId, current.stage, 'approval_requested', '阶段产物等待用户审核。', request, timestamp);
          } else {
            if (current.artifactIds.length > 0) {
              this.requireStageArtifacts(request.projectId, current);
              for (const id of current.artifactIds) {
                this.db.prepare("UPDATE research_artifacts SET status = 'approved', updated_at = ? WHERE id = ?").run(timestamp, id);
              }
            }
            this.completeStage(request.projectId, current.stage, timestamp);
          }
          break;
        case 'approve':
          this.requireStatus(current, ['waiting_approval'], 'research_stage_not_waiting_approval');
          this.requireStageArtifacts(request.projectId, current);
          current.artifactIds.forEach((artifactId) => {
            this.db.prepare("UPDATE research_artifacts SET status = 'approved', updated_at = ? WHERE id = ?").run(timestamp, artifactId);
          });
          this.updateStage(request.projectId, current.stage, { gateApproved: true });
          this.appendEvent(request.projectId, current.stage, 'approval_granted', request.note ?? '阶段产物已通过审核。', {
            artifactIds: current.artifactIds, reviewDecision: request.reviewDecision ?? null
          }, timestamp);
          this.completeStage(request.projectId, current.stage, timestamp, request.reviewDecision);
          break;
        case 'reject':
          this.requireStatus(current, ['waiting_approval'], 'research_stage_not_waiting_approval');
          this.updateStage(request.projectId, current.stage, { status: 'running', gateApproved: false, lastError: request.note ?? '用户要求修改。' });
          this.appendEvent(request.projectId, current.stage, 'approval_rejected', request.note ?? '用户要求修改。', request, timestamp);
          break;
        case 'move':
          this.moveStage(request.projectId, current, request.targetStage, request.note, timestamp);
          break;
      }
    });
    transition();
    return this.getWorkflow(request.projectId);
  }

  listWorkflowEvents(request: ResearchWorkflowEventsRequest): ResearchWorkflowEvent[] {
    this.getProject(request.projectId);
    const rows = this.db.prepare(
      `SELECT id, project_id, stage, type, message, payload_json, created_at
       FROM research_workflow_events WHERE project_id = ? ORDER BY rowid DESC LIMIT ?`
    ).all(request.projectId, request.limit) as Array<{
      id: string; project_id: string; stage: string; type: string; message: string; payload_json: string; created_at: string;
    }>;
    return rows.map((row) => researchWorkflowEventSchema.parse({
      id: row.id, projectId: row.project_id, stage: row.stage, type: row.type,
      message: row.message, payload: JSON.parse(row.payload_json), createdAt: row.created_at
    }));
  }

  private requireStageArtifacts(projectId: string, state: ResearchStageState): void {
    if (state.artifactIds.length === 0) throw new Error('research_stage_artifact_required');
    for (const id of state.artifactIds) {
      const artifact = this.getArtifact(id);
      if (artifact.projectId !== projectId || artifact.stage !== state.stage || artifact.status !== 'draft' ||
          artifact.kind !== getResearchStageRoleProfile(state.stage).outputKind) {
        throw new Error('research_stage_artifact_invalid');
      }
      this.evidence.assertPublishable(artifact);
      if (artifact.kind === 'experiment_run') this.experiments.forArtifact(artifact);
      if (artifact.kind === 'figure') this.figures.forArtifact(artifact);
    }
    if (state.stage === 'review') this.runs.requireReviewPanel(projectId, state.artifactIds);
    if (state.stage === 'export') {
      this.reviews.requireForStage(projectId, 'export');
      for (const id of state.artifactIds) this.exports.forArtifact(this.getArtifact(id));
    }
  }

  private moveStage(
    projectId: string,
    current: ResearchStageState,
    target: ResearchStageState['stage'],
    note: string | undefined,
    timestamp: string
  ): void {
    this.requireStatus(current, ['ready', 'paused', 'blocked', 'failed', 'completed'], 'research_stage_cannot_move');
    if (current.activeRunId !== null) throw new Error('research_stage_run_active');
    const targetIndex = researchStages.indexOf(target);
    const retainedManuscript = ['review', 'revision', 'export'].includes(target)
      ? this.reviews.get(projectId)?.manuscriptArtifactId ?? null : null;
    if (targetIndex <= researchStages.indexOf('review')) {
      this.db.prepare("UPDATE research_review_cycles SET status = 'reviewing', report_artifact_ids_json = '[]', updated_at = ? WHERE project_id = ?")
        .run(timestamp, projectId);
    }
    researchStages.forEach((stage, index) => {
      const state = this.readStage(projectId, stage);
      if (index < targetIndex && state.status === 'completed') return;
      this.db.prepare("UPDATE research_artifacts SET status = 'superseded', updated_at = ? WHERE project_id = ? AND stage = ? AND status != 'superseded' AND (? IS NULL OR id != ?)")
        .run(timestamp, projectId, stage, retainedManuscript, retainedManuscript);
      this.db.prepare("UPDATE research_stage_states SET artifact_ids_json = '[]' WHERE project_id = ? AND stage = ?").run(projectId, stage);
      this.updateStage(projectId, stage, {
        status: index === targetIndex ? 'ready' : 'locked', activeRunId: null,
        enteredAt: index === targetIndex ? timestamp : null, completedAt: null, gateApproved: false, lastError: null
      });
    });
    this.db.prepare("UPDATE research_projects SET current_stage = ?, status = 'active', updated_at = ? WHERE id = ?")
      .run(target, timestamp, projectId);
    const type = targetIndex <= researchStages.indexOf(current.stage) ? 'stage_reopened' : 'stage_entered';
    this.appendEvent(projectId, target, type, note ?? '已切换研究阶段，重新收集本阶段及后续产物。', { fromStage: current.stage, targetStage: target }, timestamp);
  }

  private completeStage(projectId: string, stage: ResearchStageState['stage'], timestamp: string, reviewDecision?: 'accept' | 'revise'): void {
    const index = researchStages.indexOf(stage);
    const nextStage = this.reviews.afterApproval(projectId, stage, this.readStage(projectId, stage).artifactIds, reviewDecision) ?? researchStages[index + 1];
    this.updateStage(projectId, stage, { status: 'completed', completedAt: timestamp });
    if (nextStage === undefined) {
      this.updateProjectStatus(projectId, 'completed', timestamp);
      this.appendEvent(projectId, stage, 'workflow_completed', '科研流程已完成。', {}, timestamp);
      return;
    }
    if (nextStage === 'review' || nextStage === 'revision') {
      this.db.prepare("UPDATE research_stage_states SET artifact_ids_json = '[]' WHERE project_id = ? AND stage = ?").run(projectId, nextStage);
    }
    this.updateStage(projectId, nextStage, { status: 'ready', enteredAt: timestamp, completedAt: null, gateApproved: false, lastError: null });
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
  revision: number;
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
  diagnostics_json: string;
  revision: number;
  compiled_revision: number | null;
  source_digest: string | null;
  compiled_digest: string | null;
  pdf_hash: string | null;
  active_compile_id: string | null;
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
  return researchTemplateSchema.parse({
    id: row.id,
    projectId: row.project_id,
    rootPath: row.root_path,
    entryPath: row.entry_path,
    status: row.status,
    pdfPath: row.pdf_path,
    errors,
    diagnostics: JSON.parse(row.diagnostics_json),
    revision: row.revision,
    compiledRevision: row.compiled_revision,
    sourceDigest: row.source_digest,
    compiledDigest: row.compiled_digest,
    pdfHash: row.pdf_hash,
    activeCompileId: row.active_compile_id,
    lastCompiledAt: row.last_compiled_at,
    updatedAt: row.updated_at
  });
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

function embeddingSpaceKey(id: string, revision: number): string {
  return `embedding:${id}:${revision}`;
}
