
CREATE TABLE research_artifact_contents (
        artifact_id TEXT PRIMARY KEY REFERENCES research_artifacts(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES research_stage_runs(id),
        output_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE research_artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        path TEXT,
        status TEXT NOT NULL CHECK(status IN ('draft','approved','superseded')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE
      );
CREATE TABLE research_citation_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES research_artifacts(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES research_claims(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES research_evidence(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(claim_id,evidence_id,version),
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_claim_revisions (
        claim_id TEXT NOT NULL REFERENCES research_claims(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY(claim_id, version)
      );
CREATE TABLE research_claims (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL REFERENCES research_artifacts(id) ON DELETE CASCADE,
        subject_type TEXT NOT NULL CHECK(subject_type IN ('claim','paragraph','figure')),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('supported','hypothesis','pending')),
        evidence_ids_json TEXT NOT NULL,
        experiment_json TEXT NOT NULL CHECK(json_valid(experiment_json)),
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE research_consistency_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES research_artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(artifact_id,version),
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_document_annotation_captures (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  annotation_id TEXT NOT NULL UNIQUE REFERENCES research_document_annotations(id),
  request_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES research_evidence(id),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_document_annotations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES research_documents(id),
  parse_id TEXT NOT NULL REFERENCES research_document_parses(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_document_parse_coordinates (
  parse_id TEXT PRIMARY KEY REFERENCES research_document_parses(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES research_documents(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE research_document_parses (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES research_documents(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('running','ready','failed','cancelled')),
        data_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      , coordinate_snapshot_hash TEXT);
CREATE TABLE research_documents (
        id TEXT PRIMARY KEY,
        library_item_id TEXT NOT NULL REFERENCES research_library(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size >= 0),
        status TEXT NOT NULL CHECK(status IN ('imported','parsing','ready','failed','cancelled')),
        current_parse_id TEXT,
        active_parse_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(library_item_id, source_hash)
      );
CREATE TABLE research_embedding_cache (
 config_id TEXT NOT NULL REFERENCES research_embedding_configs(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, input_version TEXT NOT NULL, input_hash TEXT NOT NULL,
 vector_blob BLOB NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(config_id,revision,input_version,input_hash)
);
CREATE TABLE research_embedding_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        api_key_secret_key TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE research_evidence (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('literature','file','experiment')),
        source_id TEXT NOT NULL,
        source_version TEXT NOT NULL,
        title TEXT NOT NULL,
        locator TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, invalidated_at TEXT,
        UNIQUE(project_id, chunk_id, source_version, locator, content_hash)
      );
CREATE TABLE research_evidence_relation_revisions (
  relation_id TEXT NOT NULL REFERENCES research_evidence_relations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  PRIMARY KEY(relation_id,version)
);
CREATE TABLE research_evidence_relations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES research_claims(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES research_evidence(id),
  claim_version INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('supports','contradicts','qualifies','depends_on','supersedes','historical')),
  status TEXT NOT NULL CHECK(status IN ('proposed','confirmed','rejected','invalidated','historical')),
  version INTEGER NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE research_evidence_source_locators (
  evidence_id TEXT PRIMARY KEY REFERENCES research_evidence(id) ON DELETE CASCADE,
  locator_json TEXT NOT NULL CHECK(json_valid(locator_json)),
  captured_at TEXT NOT NULL
);
CREATE TABLE research_evidence_source_metadata (
        evidence_id TEXT PRIMARY KEY REFERENCES research_evidence(id) ON DELETE CASCADE, metadata_json TEXT NOT NULL
      );
CREATE TABLE research_execution_outbox (
  event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
  event_type TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  delivered_at TEXT, error TEXT
);
CREATE TABLE research_experiment_executions (
        run_id TEXT PRIMARY KEY REFERENCES research_experiment_runs(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('preparing','running','completed','failed','cancelled','interrupted')),
        snapshot_json TEXT NOT NULL, root_path TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(project_id,request_id)
      );
CREATE TABLE research_experiment_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES research_experiment_executions(run_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_experiment_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        label TEXT NOT NULL,
        command TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        environment_json TEXT NOT NULL,
        status TEXT NOT NULL,
        outputs_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE
      );
CREATE TABLE research_export_executions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('preparing','ready','failed','cancelled','interrupted')),
        artifact_id TEXT UNIQUE REFERENCES research_artifacts(id) ON DELETE CASCADE,
        snapshot_json TEXT NOT NULL, root_path TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(project_id,request_id)
      );
CREATE TABLE research_figure_consistency_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES research_artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(artifact_id,version),
  UNIQUE(project_id,request_id)
);
CREATE TABLE "research_figure_publications" (
        figure_id TEXT PRIMARY KEY REFERENCES research_figures(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE REFERENCES research_figure_runs(run_id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL UNIQUE REFERENCES research_artifacts(id) ON DELETE CASCADE,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE research_figure_runs (
        run_id TEXT PRIMARY KEY REFERENCES research_experiment_runs(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('preparing','running','completed','failed','cancelled','interrupted')),
        snapshot_json TEXT NOT NULL,
        root_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, request_id)
      );
CREATE TABLE research_figures (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        code_path TEXT NOT NULL,
        data_paths_json TEXT NOT NULL,
        output_paths_json TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(run_id) REFERENCES research_experiment_runs(id) ON DELETE SET NULL
      );
CREATE TABLE research_hf_downloads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES research_hf_observations(id),
  authorization_json TEXT NOT NULL CHECK(json_valid(authorization_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  state TEXT NOT NULL CHECK(state IN ('running','completed','failed','cancelled','interrupted')),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_hf_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('model','dataset')),
  repo TEXT NOT NULL,
  revision TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_idea_canvas_revisions (
        artifact_id TEXT NOT NULL REFERENCES research_idea_canvases(artifact_id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY(artifact_id, version)
      );
CREATE TABLE research_idea_canvases (
        artifact_id TEXT PRIMARY KEY REFERENCES research_artifacts(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK(version >= 1),
        snapshot_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE research_idea_outcomes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES research_idea_canvases(artifact_id) ON DELETE CASCADE,
  plan_version_id TEXT NOT NULL REFERENCES research_idea_plan_freezes(version_id),
  version INTEGER NOT NULL CHECK(version > 0),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(plan_version_id, version),
  UNIQUE(project_id, request_id)
);
CREATE TABLE research_idea_plan_freezes (
  version_id TEXT PRIMARY KEY REFERENCES research_idea_plan_versions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, request_id)
);
CREATE TABLE research_idea_plan_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES research_idea_canvases(artifact_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  freeze_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(artifact_id, version),
  UNIQUE(project_id, request_id)
);
CREATE TABLE research_index_files (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, signature TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed','missing')),
        source_hash TEXT, indexed_hash TEXT, indexed_chunks INTEGER NOT NULL, parser_key TEXT, embedding_key TEXT NOT NULL,
        payload_json TEXT, error TEXT, active_job_id TEXT, force_needed INTEGER NOT NULL CHECK(force_needed IN (0,1)), updated_at TEXT NOT NULL,
        UNIQUE(project_id,path)
      );
CREATE TABLE research_index_jobs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL REFERENCES research_index_files(id) ON DELETE CASCADE, path TEXT NOT NULL, generation INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed','cancelled')), error TEXT, snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
CREATE TABLE research_index_projects (
        project_id TEXT PRIMARY KEY REFERENCES research_projects(id) ON DELETE CASCADE,
        options_json TEXT NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL,
        workspace_path TEXT, root_path TEXT, archived INTEGER NOT NULL CHECK(archived IN (0,1)),
        phase TEXT NOT NULL, error TEXT, scan_id TEXT, last_scan_at TEXT, embedding_key TEXT NOT NULL,
        scan_requested INTEGER NOT NULL, scan_force INTEGER NOT NULL, active_scan_force INTEGER NOT NULL
      );
CREATE TABLE research_index_sources (
        file_id TEXT NOT NULL REFERENCES research_index_files(id) ON DELETE CASCADE, source_hash TEXT NOT NULL,
        cache_path TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(file_id,source_hash)
      );
CREATE TABLE research_journal_compliance (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES research_artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(artifact_id,version),
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_knowledge_chunk_structure (
 chunk_id TEXT PRIMARY KEY REFERENCES research_knowledge_chunks(id) ON DELETE CASCADE,
 parent_chunk_id TEXT REFERENCES research_knowledge_chunks(id) ON DELETE CASCADE,
 start_utf16 INTEGER NOT NULL, end_utf16 INTEGER NOT NULL, section TEXT,
 CHECK(start_utf16 >= 0 AND end_utf16 > start_utf16)
);
CREATE TABLE research_knowledge_chunk_semantics (
 chunk_id TEXT PRIMARY KEY REFERENCES research_knowledge_chunks(id) ON DELETE CASCADE,
 metadata_json TEXT NOT NULL
);
CREATE TABLE research_knowledge_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        project_id TEXT,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        locator TEXT,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(document_id) REFERENCES research_knowledge_documents(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE,
        UNIQUE(document_id, chunk_index)
      );
CREATE VIRTUAL TABLE research_knowledge_chunks_fts USING fts5(
  content,
  content='research_knowledge_chunks',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TABLE research_knowledge_documents (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE
      );
CREATE VIRTUAL TABLE research_knowledge_documents_fts USING fts5(
        title,
        content,
        content='research_knowledge_documents',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
CREATE TABLE research_knowledge_embeddings (
        chunk_id TEXT NOT NULL,
        space_key TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_blob BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(chunk_id, space_key),
        FOREIGN KEY(chunk_id) REFERENCES research_knowledge_chunks(id) ON DELETE CASCADE
      );
CREATE TABLE research_knowledge_jobs (
 document_id TEXT PRIMARY KEY REFERENCES research_knowledge_documents(id) ON DELETE CASCADE,
 generation TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','blocked','failed','ready')),
 attempts INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE research_knowledge_keywords USING fts5(content,title);
CREATE TABLE "research_library" (
  id TEXT PRIMARY KEY, identity_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL, bibliography_json TEXT NOT NULL, sources_json TEXT NOT NULL,
  revision INTEGER NOT NULL, archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE research_library_aliases (
  item_id TEXT NOT NULL REFERENCES research_library(id) ON DELETE CASCADE,
  identity TEXT NOT NULL, PRIMARY KEY(item_id,identity)
);
CREATE TABLE research_library_projects (
        item_id TEXT NOT NULL REFERENCES research_library(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        PRIMARY KEY(item_id, project_id)
      );
CREATE TABLE research_library_provider_identifiers (
  item_id TEXT NOT NULL REFERENCES research_library(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL REFERENCES research_literature_search_executions(id),
  source TEXT NOT NULL, rank INTEGER NOT NULL CHECK(rank>0),
  metadata_hash TEXT NOT NULL, external_id TEXT NOT NULL, retrieved_at TEXT NOT NULL,
  raw_json TEXT NOT NULL, mapped_json TEXT NOT NULL,
  PRIMARY KEY(item_id,execution_id,source,rank),
  UNIQUE(execution_id,source,rank)
);
CREATE TABLE research_library_provider_reviews (
  item_id TEXT NOT NULL REFERENCES research_library(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL REFERENCES research_literature_search_executions(id),
  source TEXT NOT NULL, rank INTEGER NOT NULL CHECK(rank>0),
  retrieved_at TEXT NOT NULL, record_json TEXT NOT NULL,
  PRIMARY KEY(item_id,execution_id,source,rank), UNIQUE(execution_id,source,rank)
);
CREATE TABLE research_literature_imports (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope_project TEXT NOT NULL,
  run_id TEXT, request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
  frozen_json TEXT NOT NULL, result_json TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(owner, scope_project, request_id)
);
CREATE TABLE research_literature_records (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        doi TEXT,
        title TEXT NOT NULL,
        authors_json TEXT NOT NULL,
        abstract TEXT,
        published_year INTEGER,
        citation_count INTEGER,
        url TEXT,
        open_access_url TEXT,
        imported_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source, external_id)
      );
CREATE TABLE research_literature_request_receipts (
  execution_id TEXT NOT NULL REFERENCES research_literature_search_executions(id) ON DELETE CASCADE,
  source TEXT NOT NULL, attempt INTEGER NOT NULL CHECK (attempt > 0),
  state TEXT NOT NULL CHECK (state IN ('dispatched','received','unknown')),
  receipt_json TEXT NOT NULL, PRIMARY KEY (execution_id,source,attempt)
);
CREATE TABLE research_literature_search_executions (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, project_id TEXT, run_id TEXT,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','complete','partial','failed','cancelled','interrupted')),
  search_id TEXT, error_code TEXT, created_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE research_literature_search_pools (
  execution_id TEXT PRIMARY KEY REFERENCES research_literature_search_executions(id),
  pool_json TEXT NOT NULL
);
CREATE TABLE research_literature_searches (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, project_id TEXT,
  request_json TEXT NOT NULL, result_json TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE research_manuscripts (
        artifact_id TEXT PRIMARY KEY REFERENCES research_artifacts(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        sections_json TEXT NOT NULL,
        latex TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        claims_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE research_monitor_alerts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  monitor_id TEXT NOT NULL REFERENCES research_monitors(id) ON DELETE CASCADE,
  check_id TEXT NOT NULL REFERENCES research_monitor_checks(id),
  query_version INTEGER NOT NULL, source TEXT NOT NULL, identity TEXT NOT NULL, kind TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  ack_json TEXT CHECK(ack_json IS NULL OR json_valid(ack_json)), UNIQUE(monitor_id,identity,kind)
);
CREATE TABLE research_monitor_checkpoints (
  monitor_id TEXT NOT NULL REFERENCES research_monitors(id) ON DELETE CASCADE,
  query_version INTEGER NOT NULL, source TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), PRIMARY KEY(monitor_id,query_version,source)
);
CREATE TABLE research_monitor_checks (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES research_monitors(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  query_version INTEGER NOT NULL, control_revision INTEGER NOT NULL,
  check_key TEXT NOT NULL, status TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), UNIQUE(monitor_id,check_key)
);
CREATE TABLE research_monitor_requests (
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  monitor_id TEXT NOT NULL REFERENCES research_monitors(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL, request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), PRIMARY KEY(project_id,request_id)
);
CREATE TABLE research_monitor_seen (
  monitor_id TEXT NOT NULL REFERENCES research_monitors(id) ON DELETE CASCADE,
  query_version INTEGER NOT NULL, source TEXT NOT NULL, identity TEXT NOT NULL,
  first_check_id TEXT NOT NULL REFERENCES research_monitor_checks(id),
  PRIMARY KEY(monitor_id,query_version,source,identity)
);
CREATE TABLE research_monitor_versions (
  monitor_id TEXT NOT NULL REFERENCES research_monitors(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  PRIMARY KEY(monitor_id,version)
);
CREATE TABLE research_monitors (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, query_version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
);
CREATE TABLE research_node_decision_receipts (
  node_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id),
  output_hash TEXT NOT NULL, output_revision INTEGER NOT NULL,
  accepted INTEGER NOT NULL CHECK(accepted IN (0,1))
);
CREATE TABLE research_node_output_receipts (
  execution_id TEXT PRIMARY KEY REFERENCES research_stage_runs(id),
  lease_json TEXT NOT NULL CHECK(json_valid(lease_json)),
  output_json TEXT NOT NULL CHECK(json_valid(output_json))
);
CREATE TABLE research_notebooks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  source_bytes BLOB NOT NULL CHECK(length(source_bytes)<=8388608),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, request_id)
);
CREATE TABLE research_openreview_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  query_json TEXT NOT NULL CHECK(json_valid(query_json)),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        workspace_path TEXT,
        status TEXT NOT NULL CHECK(status IN ('active','paused','completed','archived')),
        current_stage TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , language TEXT NOT NULL DEFAULT 'zh' CHECK(language IN ('zh','en')), origin_project_id TEXT REFERENCES research_projects(id) ON DELETE SET NULL, origin_artifact_id TEXT REFERENCES research_artifacts(id) ON DELETE SET NULL, origin_version INTEGER);
CREATE TABLE research_provenance (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        artifact_id TEXT,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        locator TEXT,
        excerpt TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(artifact_id) REFERENCES research_artifacts(id) ON DELETE SET NULL
      );
CREATE TABLE research_python_environment_selections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, request_id)
);
CREATE TABLE research_radar_articles (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
 feed_id TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
);
CREATE TABLE research_radar_feeds (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
);
CREATE TABLE research_radar_recommendations (
 project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
 cache_key TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), PRIMARY KEY(project_id,cache_key)
);
CREATE TABLE research_reading_highlights (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
 document_id TEXT NOT NULL, source_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
);
CREATE TABLE research_reading_notes (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, updated_at TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
);
CREATE TABLE research_resource_associations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  resource_id TEXT NOT NULL REFERENCES research_resource_observations(id),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('literature','experiment')),
  target_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_resource_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  doi TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_response_matrices (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES research_artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(artifact_id,version),
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_review_corpora (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  protocol_version_id TEXT NOT NULL REFERENCES research_review_protocol_versions(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, dedup_freeze_hash TEXT, screening_plan_hash TEXT,
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_review_cycles (
        project_id TEXT PRIMARY KEY REFERENCES research_projects(id) ON DELETE CASCADE,
        origin_artifact_id TEXT NOT NULL REFERENCES research_artifacts(id),
        manuscript_artifact_id TEXT NOT NULL REFERENCES research_artifacts(id),
        revision_round INTEGER NOT NULL CHECK(revision_round BETWEEN 0 AND 2),
        status TEXT NOT NULL CHECK(status IN ('reviewing','revision_required','accepted')),
        report_artifact_ids_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE research_review_deduplication_freezes (
  corpus_id TEXT PRIMARY KEY REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_review_duplicate_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  pair_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  parent_id TEXT REFERENCES research_review_duplicate_decisions(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id),
  UNIQUE(corpus_id,pair_key,version)
);
CREATE TABLE research_review_extractions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  hit_id TEXT NOT NULL,
  binding_id TEXT NOT NULL REFERENCES research_review_fulltext_bindings(id),
  version INTEGER NOT NULL CHECK(version > 0),
  parent_id TEXT REFERENCES research_review_extractions(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, quality_plan_hash TEXT,
  UNIQUE(project_id,request_id),
  UNIQUE(corpus_id,hit_id,version)
);
CREATE TABLE research_review_fulltext_bindings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  hit_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  parent_id TEXT REFERENCES research_review_fulltext_bindings(id),
  document_id TEXT REFERENCES research_documents(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id),
  UNIQUE(corpus_id,hit_id,version)
);
CREATE TABLE research_review_protocol_freezes (
  version_id TEXT PRIMARY KEY REFERENCES research_review_protocol_versions(id),
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_review_protocol_versions (
  id TEXT PRIMARY KEY,
  protocol_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  parent_version_id TEXT REFERENCES research_review_protocol_versions(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  freeze_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(protocol_id,version),
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_review_quality_assessments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES research_review_quality_plans(id),
  version INTEGER NOT NULL CHECK(version>0),
  parent_id TEXT REFERENCES research_review_quality_assessments(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id),
  UNIQUE(plan_id,version)
);
CREATE TABLE research_review_quality_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  hit_id TEXT NOT NULL,
  extraction_id TEXT NOT NULL UNIQUE REFERENCES research_review_extractions(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, assessment_head_hash TEXT,
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_review_screening_arbitrations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  hit_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  parent_id TEXT REFERENCES research_review_screening_arbitrations(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id),
  UNIQUE(corpus_id,phase,hit_id,version)
);
CREATE TABLE research_review_screening_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  hit_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  parent_id TEXT REFERENCES research_review_screening_decisions(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id),
  UNIQUE(corpus_id,phase,hit_id,reviewer_id,version)
);
CREATE TABLE research_review_screening_freezes (
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(corpus_id,phase),
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_review_screening_plans (
  id TEXT PRIMARY KEY,
  corpus_id TEXT NOT NULL UNIQUE REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, title_freeze_hash TEXT, full_freeze_hash TEXT, study_group_head_hash TEXT,
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_review_screening_suggestions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  hit_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_review_search_cancellations (
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  review_search_id TEXT NOT NULL UNIQUE REFERENCES research_review_searches(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  PRIMARY KEY(project_id,request_id)
);
CREATE TABLE research_review_search_owners (
  review_search_id TEXT PRIMARY KEY REFERENCES research_review_searches(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL
);
CREATE TABLE research_review_searches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  protocol_version_id TEXT NOT NULL REFERENCES research_review_protocol_versions(id),
  database_index INTEGER NOT NULL,
  query_index INTEGER NOT NULL,
  retry_of TEXT REFERENCES research_review_searches(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','cancelling','complete','partial','failed','cancelled','interrupted')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  receipt_hash TEXT,
  cancellation_hash TEXT,
  updated_at TEXT NOT NULL, owner_hash TEXT,
  UNIQUE(project_id,request_id),
  UNIQUE(retry_of)
);
CREATE TABLE research_review_study_groupings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version>0),
  parent_id TEXT REFERENCES research_review_study_groupings(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id),
  UNIQUE(corpus_id,version)
);
CREATE TABLE research_scholarly_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES research_library(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_source_migration_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES research_source_migration_proposals(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_source_migration_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES research_evidence(id),
  document_id TEXT NOT NULL REFERENCES research_documents(id),
  target_parse_id TEXT NOT NULL REFERENCES research_document_parses(id),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(evidence_id,target_parse_id)
);
CREATE TABLE research_source_replacements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES research_evidence(id),
  target_evidence_id TEXT NOT NULL REFERENCES research_evidence(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id),
  UNIQUE(project_id,evidence_id,target_evidence_id)
);
CREATE TABLE research_stage_policies (
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        PRIMARY KEY(project_id, stage)
      );
CREATE TABLE research_stage_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        request_id TEXT NOT NULL,
        parent_run_id TEXT REFERENCES research_stage_runs(id),
        status TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        context_json TEXT NOT NULL, task_id TEXT,
        UNIQUE(project_id, request_id)
      );
CREATE TABLE research_stage_states (
        project_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        active_run_id TEXT,
        artifact_ids_json TEXT NOT NULL,
        entered_at TEXT,
        completed_at TEXT,
        gate_required INTEGER NOT NULL,
        gate_approved INTEGER NOT NULL,
        last_error TEXT,
        PRIMARY KEY(project_id, stage),
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE
      );
CREATE TABLE research_templates (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        entry_path TEXT NOT NULL,
        status TEXT NOT NULL,
        pdf_path TEXT,
        errors_json TEXT NOT NULL,
        last_compiled_at TEXT,
        updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, compiled_revision INTEGER, source_digest TEXT, compiled_digest TEXT, pdf_hash TEXT, active_compile_id TEXT, diagnostics_json TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE
      );
CREATE TABLE research_workflow_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE
      );
CREATE TABLE research_workspace_files (
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size >= 0),
        revision INTEGER NOT NULL,
        owner_run_id TEXT REFERENCES research_stage_runs(id),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, path)
      );
CREATE TABLE research_zenodo_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  preparation_id TEXT NOT NULL REFERENCES research_zenodo_preparations(id),
  request_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  status TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id), UNIQUE(project_id,preparation_id)
);
CREATE TABLE research_zenodo_preparations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE TABLE research_zenodo_publication_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL REFERENCES research_zenodo_operations(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE(operation_id,request_id)
);
CREATE TABLE research_zotero_attachment_grants (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope_project TEXT NOT NULL,
  request_id TEXT NOT NULL, inspection_id TEXT NOT NULL REFERENCES research_zotero_attachment_inspections(id),
  grant_json TEXT NOT NULL, granted_at TEXT NOT NULL,
  UNIQUE(owner,scope_project,request_id)
);
CREATE TABLE research_zotero_attachment_imports (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope_project TEXT NOT NULL, request_id TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES research_zotero_attachment_grants(id),
  document_id TEXT NOT NULL REFERENCES research_documents(id), receipt_json TEXT NOT NULL, imported_at TEXT NOT NULL,
  UNIQUE(owner,scope_project,request_id)
);
CREATE TABLE research_zotero_attachment_inspections (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope_project TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES research_literature_imports(id),
  server_id TEXT NOT NULL, library_kind TEXT NOT NULL CHECK(library_kind IN ('user','group')), library_id INTEGER NOT NULL,
  item_key TEXT NOT NULL, attachment_key TEXT NOT NULL, inspection_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
  FOREIGN KEY(operation_id,server_id,library_kind,library_id,item_key)
    REFERENCES research_zotero_import_observations(operation_id,server_id,library_kind,library_id,item_key)
);
CREATE TABLE research_zotero_import_observations (
  operation_id TEXT NOT NULL REFERENCES research_literature_imports(id),
  server_id TEXT NOT NULL, library_kind TEXT NOT NULL, library_id INTEGER NOT NULL, item_key TEXT NOT NULL,
  object_version INTEGER NOT NULL, library_version INTEGER NOT NULL CHECK(library_version>=object_version),
  preview_id TEXT NOT NULL REFERENCES research_zotero_previews(id),
  captured_at TEXT NOT NULL, imported_at TEXT NOT NULL,
  PRIMARY KEY(operation_id,server_id,library_kind,library_id,item_key),
  FOREIGN KEY(server_id,library_kind,library_id,item_key,object_version)
    REFERENCES research_zotero_object_versions(server_id,library_kind,library_id,item_key,object_version)
);
CREATE TABLE research_zotero_object_versions (
  server_id TEXT NOT NULL, library_kind TEXT NOT NULL, library_id INTEGER NOT NULL, item_key TEXT NOT NULL,
  object_version INTEGER NOT NULL, item_id TEXT NOT NULL REFERENCES research_library(id),
  item_hash TEXT NOT NULL, preview_id TEXT NOT NULL REFERENCES research_zotero_previews(id),
  item_json TEXT NOT NULL, captured_at TEXT NOT NULL, imported_at TEXT NOT NULL,
  PRIMARY KEY(server_id,library_kind,library_id,item_key,object_version),
  FOREIGN KEY(server_id,library_kind,library_id,item_key)
    REFERENCES research_zotero_objects(server_id,library_kind,library_id,item_key)
);
CREATE TABLE research_zotero_objects (
  server_id TEXT NOT NULL, library_kind TEXT NOT NULL CHECK(library_kind IN ('user','group')),
  library_id INTEGER NOT NULL, item_key TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES research_library(id), object_version INTEGER NOT NULL CHECK(object_version>=0),
  item_hash TEXT NOT NULL, imported_at TEXT NOT NULL,
  PRIMARY KEY(server_id,library_kind,library_id,item_key)
);
CREATE TABLE research_zotero_previews (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, project_id TEXT, run_id TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, snapshot_json TEXT NOT NULL
);
CREATE TABLE research_zotero_source_states (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope_project TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES research_literature_imports(id),
  server_id TEXT NOT NULL, library_kind TEXT NOT NULL CHECK(library_kind IN ('user','group')), library_id INTEGER NOT NULL,
  item_key TEXT NOT NULL, collection_key TEXT,
  state_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
  FOREIGN KEY(operation_id,server_id,library_kind,library_id,item_key)
    REFERENCES research_zotero_import_observations(operation_id,server_id,library_kind,library_id,item_key)
);
CREATE TABLE research_zotero_sync_checkpoints (
  scope_key TEXT PRIMARY KEY, sync_id TEXT NOT NULL REFERENCES research_zotero_syncs(id),
  library_version INTEGER NOT NULL CHECK(library_version>=0), updated_at TEXT NOT NULL
);
CREATE TABLE research_zotero_sync_pages (
  sync_id TEXT NOT NULL REFERENCES research_zotero_syncs(id),
  source_offset INTEGER NOT NULL CHECK(source_offset>=0),
  preview_id TEXT NOT NULL REFERENCES research_zotero_previews(id),
  decisions_json TEXT NOT NULL, acknowledged_at TEXT NOT NULL,
  PRIMARY KEY(sync_id,source_offset), UNIQUE(preview_id)
);
CREATE TABLE research_zotero_sync_seen (
  sync_id TEXT NOT NULL REFERENCES research_zotero_syncs(id), item_key TEXT NOT NULL,
  object_version INTEGER NOT NULL CHECK(object_version>=0),
  source_offset INTEGER NOT NULL CHECK(source_offset>=0),
  PRIMARY KEY(sync_id,item_key),
  FOREIGN KEY(sync_id,source_offset) REFERENCES research_zotero_sync_pages(sync_id,source_offset)
);
CREATE TABLE research_zotero_syncs (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope_project TEXT NOT NULL, scope_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','paused','completed','reset_required')),
  revision INTEGER NOT NULL CHECK(revision>=0), state_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_research_artifacts_project_stage
        ON research_artifacts(project_id, stage, updated_at DESC);
CREATE INDEX idx_research_claims_artifact ON research_claims(project_id, artifact_id);
CREATE INDEX idx_research_document_annotations_parse ON research_document_annotations(project_id,document_id,parse_id);
CREATE INDEX idx_research_document_coordinate_document ON research_document_parse_coordinates(document_id,parse_id);
CREATE INDEX idx_research_document_parses_document ON research_document_parses(document_id, created_at);
CREATE INDEX idx_research_evidence_locator_document ON research_evidence_source_locators(json_extract(locator_json,'$.documentId'));
CREATE INDEX idx_research_evidence_project ON research_evidence(project_id, created_at DESC);
CREATE INDEX idx_research_evidence_relations_claim ON research_evidence_relations(project_id,claim_id,status);
CREATE INDEX idx_research_evidence_relations_source ON research_evidence_relations(evidence_id,status);
CREATE UNIQUE INDEX idx_research_experiment_artifact ON research_experiment_executions(json_extract(snapshot_json, '$.artifactId'))
        WHERE json_extract(snapshot_json, '$.artifactId') IS NOT NULL;
CREATE INDEX idx_research_experiment_executions_project ON research_experiment_executions(project_id,created_at);
CREATE INDEX idx_research_experiment_owner ON research_experiment_executions(json_extract(snapshot_json, '$.ownerRunId'));
CREATE INDEX idx_research_experiment_runs_project
        ON research_experiment_runs(project_id, started_at DESC);
CREATE INDEX idx_research_export_executions_project ON research_export_executions(project_id,created_at);
CREATE INDEX idx_research_export_owner ON research_export_executions(json_extract(snapshot_json, '$.ownerRunId'));
CREATE INDEX idx_research_figure_publications_project ON research_figure_publications(project_id, created_at);
CREATE UNIQUE INDEX idx_research_figure_run_artifact ON research_figure_runs(json_extract(snapshot_json, '$.artifactId'))
        WHERE json_extract(snapshot_json, '$.artifactId') IS NOT NULL;
CREATE INDEX idx_research_figure_run_owner ON research_figure_runs(json_extract(snapshot_json, '$.ownerRunId'));
CREATE INDEX idx_research_figure_runs_project ON research_figure_runs(project_id, created_at);
CREATE INDEX idx_research_figures_project
        ON research_figures(project_id, updated_at DESC);
CREATE INDEX idx_research_index_jobs_file ON research_index_jobs(file_id);
CREATE INDEX idx_research_index_jobs_project ON research_index_jobs(project_id,created_at);
CREATE INDEX idx_research_index_jobs_queue ON research_index_jobs(status,created_at);
CREATE INDEX idx_research_knowledge_chunks_document
        ON research_knowledge_chunks(document_id, chunk_index);
CREATE INDEX idx_research_knowledge_documents_project
        ON research_knowledge_documents(project_id, indexed_at DESC);
CREATE INDEX idx_research_library_alias_identity ON research_library_aliases(identity,item_id);
CREATE INDEX idx_research_library_citation_key ON research_library(json_extract(bibliography_json, '$.citationKey'));
CREATE INDEX idx_research_library_identity ON research_library(identity_key);
CREATE INDEX idx_research_library_projects_project ON research_library_projects(project_id, item_id);
CREATE INDEX idx_research_library_provider_identifiers_item
  ON research_library_provider_identifiers(item_id,retrieved_at,execution_id,source,rank);
CREATE INDEX idx_research_library_provider_reviews_item
  ON research_library_provider_reviews(item_id,retrieved_at,execution_id,source,rank);
CREATE INDEX idx_research_literature_doi
        ON research_literature_records(doi);
CREATE INDEX idx_research_literature_updated
        ON research_literature_records(updated_at DESC);
CREATE UNIQUE INDEX idx_research_projects_origin
        ON research_projects(origin_artifact_id, origin_version)
        WHERE origin_artifact_id IS NOT NULL AND origin_version IS NOT NULL;
CREATE INDEX idx_research_projects_updated
        ON research_projects(updated_at DESC);
CREATE UNIQUE INDEX idx_research_projects_workspace_path
        ON research_projects(workspace_path)
        WHERE workspace_path IS NOT NULL AND trim(workspace_path) != '';
CREATE INDEX idx_research_provenance_subject
        ON research_provenance(subject_type, subject_id);
CREATE INDEX idx_research_source_migration_evidence ON research_source_migration_proposals(project_id,evidence_id);
CREATE INDEX idx_research_source_replacement_source ON research_source_replacements(project_id,evidence_id);
CREATE INDEX idx_research_stage_runs_project ON research_stage_runs(project_id, stage, status);
CREATE INDEX idx_research_stage_states_project
        ON research_stage_states(project_id, stage);
CREATE INDEX idx_research_templates_project
        ON research_templates(project_id, updated_at DESC);
CREATE INDEX idx_research_workflow_events_project_created
        ON research_workflow_events(project_id, created_at DESC);
CREATE INDEX idx_research_zotero_attachment_inspections_scope ON research_zotero_attachment_inspections
  (owner,scope_project,operation_id,server_id,library_kind,library_id,item_key,attachment_key);
CREATE INDEX idx_research_zotero_objects_item ON research_zotero_objects(item_id);
CREATE INDEX idx_research_zotero_previews_scope
  ON research_zotero_previews(owner,project_id,created_at,id);
CREATE INDEX idx_research_zotero_source_states_scope ON research_zotero_source_states
  (owner,scope_project,operation_id,server_id,library_kind,library_id,item_key,collection_key);
CREATE UNIQUE INDEX idx_research_zotero_syncs_active ON research_zotero_syncs(scope_key)
  WHERE status IN ('active','paused');
CREATE INDEX idx_review_corpus_version ON research_review_corpora(project_id,protocol_version_id);
CREATE INDEX idx_review_protocol_project ON research_review_protocol_versions(project_id,protocol_id,version);
CREATE INDEX idx_review_screening_suggestions ON research_review_screening_suggestions(corpus_id,phase,hit_id);
CREATE INDEX idx_review_search_version ON research_review_searches(project_id,protocol_version_id,database_index,query_index);
CREATE INDEX research_citation_reviews_artifact ON research_citation_reviews(artifact_id);
CREATE INDEX research_consistency_reviews_artifact ON research_consistency_reviews(artifact_id);
CREATE INDEX research_experiment_results_run ON research_experiment_results(project_id,run_id);
CREATE INDEX research_figure_consistency_reviews_artifact ON research_figure_consistency_reviews(artifact_id);
CREATE INDEX research_hf_download_observation ON research_hf_downloads(project_id,observation_id);
CREATE INDEX research_hf_revision ON research_hf_observations(project_id,kind,repo,revision);
CREATE INDEX research_journal_compliance_artifact ON research_journal_compliance(artifact_id);
CREATE INDEX research_knowledge_child_parent ON research_knowledge_chunk_structure(parent_chunk_id);
CREATE INDEX research_knowledge_jobs_pending ON research_knowledge_jobs(status,updated_at,document_id);
CREATE INDEX research_literature_execution_run ON research_literature_search_executions(run_id);
CREATE INDEX research_literature_execution_scope ON research_literature_search_executions(owner, project_id, created_at);
CREATE UNIQUE INDEX research_literature_frozen_query ON research_literature_search_executions(
  project_id, json_extract(request_json,'$.strategy.artifactId'),
  json_extract(request_json,'$.strategy.contentHash'), json_extract(request_json,'$.strategy.queryId')
) WHERE json_type(request_json,'$.strategy.queryId')='text';
CREATE INDEX research_literature_search_owner ON research_literature_searches(owner, project_id);
CREATE UNIQUE INDEX research_monitor_one_running ON research_monitor_checks(monitor_id) WHERE status='running';
CREATE INDEX research_radar_articles_feed ON research_radar_articles(project_id,feed_id);
CREATE INDEX research_reading_highlights_document ON research_reading_highlights(project_id,document_id,source_hash);
CREATE INDEX research_reading_notes_project ON research_reading_notes(project_id,updated_at);
CREATE INDEX research_resource_association_resource ON research_resource_associations(project_id,resource_id);
CREATE INDEX research_resource_association_target ON research_resource_associations(project_id,target_kind,target_id);
CREATE INDEX research_resource_doi ON research_resource_observations(project_id,doi);
CREATE INDEX research_response_matrices_artifact ON research_response_matrices(artifact_id);
CREATE INDEX research_scholarly_item ON research_scholarly_snapshots(project_id,item_id);
CREATE INDEX research_stage_task ON research_stage_runs(task_id);
CREATE TRIGGER research_claim_review_outbox AFTER UPDATE OF status ON research_evidence_relations
WHEN NEW.status IN ('confirmed','rejected') AND NEW.status!=OLD.status BEGIN
  INSERT INTO research_execution_outbox(event_id,task_id,project_id,event_type,payload_json,payload_hash,created_at)
  SELECT NEW.id || ':' || NEW.version || ':' || r.task_id,r.task_id,NEW.project_id,'claim_reviewed',
    NEW.snapshot_json,roc_payload_hash(NEW.snapshot_json),NEW.updated_at
  FROM research_stage_runs r JOIN research_claims c ON c.id=NEW.claim_id
  JOIN research_artifacts a ON a.id=c.artifact_id
  WHERE r.project_id=NEW.project_id AND r.stage=a.stage AND r.task_id IS NOT NULL GROUP BY r.task_id;
END;
CREATE TRIGGER research_knowledge_chunks_ad AFTER DELETE ON research_knowledge_chunks BEGIN
  INSERT INTO research_knowledge_chunks_fts(research_knowledge_chunks_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER research_knowledge_chunks_ai AFTER INSERT ON research_knowledge_chunks BEGIN
  INSERT INTO research_knowledge_chunks_fts(rowid, content)
    VALUES (new.rowid, new.content);
END;
CREATE TRIGGER research_knowledge_chunks_au AFTER UPDATE ON research_knowledge_chunks BEGIN
  INSERT INTO research_knowledge_chunks_fts(research_knowledge_chunks_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  INSERT INTO research_knowledge_chunks_fts(rowid, content)
    VALUES (new.rowid, new.content);
END;
CREATE TRIGGER research_knowledge_documents_ad AFTER DELETE ON research_knowledge_documents BEGIN
        INSERT INTO research_knowledge_documents_fts(research_knowledge_documents_fts, rowid, title, content)
          VALUES ('delete', old.rowid, old.title, old.content);
      END;
CREATE TRIGGER research_knowledge_documents_ai AFTER INSERT ON research_knowledge_documents BEGIN
        INSERT INTO research_knowledge_documents_fts(rowid, title, content)
          VALUES (new.rowid, new.title, new.content);
      END;
CREATE TRIGGER research_knowledge_documents_au AFTER UPDATE ON research_knowledge_documents BEGIN
        INSERT INTO research_knowledge_documents_fts(research_knowledge_documents_fts, rowid, title, content)
          VALUES ('delete', old.rowid, old.title, old.content);
        INSERT INTO research_knowledge_documents_fts(rowid, title, content)
          VALUES (new.rowid, new.title, new.content);
      END;
CREATE TRIGGER research_knowledge_keywords_delete AFTER DELETE ON research_knowledge_chunks BEGIN
 DELETE FROM research_knowledge_keywords WHERE rowid=old.rowid;
END;
CREATE TRIGGER research_projects_origin_complete
        BEFORE INSERT ON research_projects
        WHEN ((NEW.origin_project_id IS NULL) = 1) + ((NEW.origin_artifact_id IS NULL) = 1) + ((NEW.origin_version IS NULL) = 1) NOT IN (0, 3)
        BEGIN SELECT RAISE(ABORT, 'research_project_origin_invalid'); END;
CREATE TRIGGER research_projects_origin_complete_update
        BEFORE UPDATE OF origin_project_id, origin_artifact_id, origin_version ON research_projects
        WHEN ((NEW.origin_project_id IS NULL) = 1) + ((NEW.origin_artifact_id IS NULL) = 1) + ((NEW.origin_version IS NULL) = 1) NOT IN (0, 3)
        BEGIN SELECT RAISE(ABORT, 'research_project_origin_invalid'); END;
CREATE TRIGGER research_source_invalidation_outbox AFTER UPDATE OF invalidated_at ON research_evidence
WHEN NEW.invalidated_at IS NOT NULL AND OLD.invalidated_at IS NULL BEGIN
  INSERT INTO research_execution_outbox(event_id,task_id,project_id,event_type,payload_json,payload_hash,created_at)
  SELECT NEW.id || ':' || NEW.invalidated_at || ':' || task_id,task_id,NEW.project_id,'source_invalidated',
    json_object('evidenceId',NEW.id,'sourceVersion',NEW.source_version,'contentHash',NEW.content_hash),
    roc_payload_hash(json_object('evidenceId',NEW.id,'sourceVersion',NEW.source_version,'contentHash',NEW.content_hash)),NEW.invalidated_at
  FROM research_stage_runs WHERE project_id=NEW.project_id AND task_id IS NOT NULL GROUP BY task_id;
END;
CREATE TRIGGER research_stage_skill_pin_required BEFORE INSERT ON research_stage_runs
WHEN json_type(NEW.context_json,'$.skillPin') IS NOT 'object'
BEGIN SELECT RAISE(ABORT,'research_stage_skill_pin_required'); END;
CREATE TRIGGER research_workflow_semantic_outbox AFTER INSERT ON research_workflow_events
WHEN NEW.type IN ('approval_granted','approval_requested','approval_rejected') BEGIN
  INSERT INTO research_execution_outbox(event_id,task_id,project_id,event_type,payload_json,payload_hash,created_at)
  SELECT NEW.id || ':' || task_id,task_id,NEW.project_id,
    CASE WHEN NEW.type='approval_granted' AND NEW.stage='planning' THEN 'plan_approved' ELSE 'quality_gate' END,
    json_object('sourceEventId',NEW.id,'stage',NEW.stage,'decision',NEW.type,'facts',json(NEW.payload_json)),
    roc_payload_hash(json_object('sourceEventId',NEW.id,'stage',NEW.stage,'decision',NEW.type,'facts',json(NEW.payload_json))),NEW.created_at
  FROM research_stage_runs WHERE project_id=NEW.project_id AND stage=NEW.stage AND task_id IS NOT NULL GROUP BY task_id;
END;

CREATE TABLE research_paper_cards (
 document_id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL, version TEXT NOT NULL,
 snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
 generation TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')), error TEXT
);
CREATE TABLE research_wiki_pages (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('source','topic','comparison','dispute')), title TEXT NOT NULL,
 source_document_id TEXT, selection_json TEXT NOT NULL CHECK(json_valid(selection_json)),
 revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
 UNIQUE(project_id,source_document_id)
);
CREATE INDEX research_wiki_project ON research_wiki_pages(project_id,updated_at);
CREATE TABLE research_wiki_revisions (
 page_id TEXT NOT NULL REFERENCES research_wiki_pages(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), PRIMARY KEY(page_id,revision)
);
CREATE TABLE research_wiki_sections (
 id INTEGER PRIMARY KEY, page_id TEXT NOT NULL REFERENCES research_wiki_pages(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, section_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
 input_text TEXT NOT NULL, input_hash TEXT NOT NULL, UNIQUE(page_id,section_id)
);
CREATE VIRTUAL TABLE research_wiki_fts USING fts5(
 title,body,content='research_wiki_sections',content_rowid='id',tokenize='unicode61'
);
CREATE TRIGGER research_wiki_section_insert AFTER INSERT ON research_wiki_sections BEGIN
 INSERT INTO research_wiki_fts(rowid,title,body) VALUES(new.id,new.title,new.body);
END;
CREATE TRIGGER research_wiki_section_delete AFTER DELETE ON research_wiki_sections BEGIN
 INSERT INTO research_wiki_fts(research_wiki_fts,rowid,title,body) VALUES('delete',old.id,old.title,old.body);
END;
CREATE TABLE research_wiki_dependencies (
 page_id TEXT NOT NULL REFERENCES research_wiki_pages(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, dependency_id TEXT NOT NULL, PRIMARY KEY(page_id,kind,dependency_id)
);
CREATE INDEX research_wiki_dependency ON research_wiki_dependencies(kind,dependency_id);
CREATE TABLE research_wiki_jobs (
 page_id TEXT PRIMARY KEY REFERENCES research_wiki_pages(id) ON DELETE CASCADE,
 generation TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')), error TEXT
);
CREATE TRIGGER research_wiki_source_insert AFTER INSERT ON research_evidence BEGIN
 INSERT INTO research_wiki_pages(id,project_id,kind,title,source_document_id,selection_json,updated_at)
 VALUES ('wiki_'||lower(hex(randomblob(16))),new.project_id,'source',new.title,
 COALESCE(json_extract((SELECT metadata_json FROM research_knowledge_documents WHERE id=new.document_id),'$.documentId'),
 json_extract((SELECT metadata_json FROM research_knowledge_documents WHERE id=new.document_id),'$.fileId'),new.document_id),
 '{"evidenceIds":[],"claimIds":[]}',new.created_at)
 ON CONFLICT(project_id,source_document_id) DO NOTHING;
 INSERT INTO research_wiki_jobs(page_id,generation,status,error)
 SELECT id,lower(hex(randomblob(16))),'queued',NULL FROM research_wiki_pages WHERE project_id=new.project_id AND source_document_id IN (new.document_id,
 json_extract((SELECT metadata_json FROM research_knowledge_documents WHERE id=new.document_id),'$.documentId'),
 json_extract((SELECT metadata_json FROM research_knowledge_documents WHERE id=new.document_id),'$.fileId'))
 ON CONFLICT(page_id) DO UPDATE SET generation=excluded.generation,status='queued',error=NULL;
END;
CREATE TRIGGER research_wiki_evidence_update
 AFTER UPDATE ON research_evidence BEGIN
 INSERT INTO research_wiki_jobs(page_id,generation,status,error)
 SELECT id,lower(hex(randomblob(16))),'queued',NULL FROM research_wiki_pages WHERE (project_id=old.project_id AND source_document_id IN (old.document_id,
 json_extract((SELECT metadata_json FROM research_evidence_source_metadata WHERE evidence_id=old.id),'$.documentId'),
 json_extract((SELECT metadata_json FROM research_evidence_source_metadata WHERE evidence_id=old.id),'$.fileId'))) OR id IN (SELECT page_id FROM research_wiki_dependencies WHERE kind='evidence' AND dependency_id=old.id)
 ON CONFLICT(page_id) DO UPDATE SET generation=excluded.generation,status='queued',error=NULL; END;
CREATE TRIGGER research_wiki_evidence_delete
 AFTER DELETE ON research_evidence BEGIN
 INSERT INTO research_wiki_jobs(page_id,generation,status,error)
 SELECT id,lower(hex(randomblob(16))),'queued',NULL FROM research_wiki_pages WHERE (project_id=old.project_id AND source_document_id IN (old.document_id,
 json_extract((SELECT metadata_json FROM research_evidence_source_metadata WHERE evidence_id=old.id),'$.documentId'),
 json_extract((SELECT metadata_json FROM research_evidence_source_metadata WHERE evidence_id=old.id),'$.fileId'))) OR id IN (SELECT page_id FROM research_wiki_dependencies WHERE kind='evidence' AND dependency_id=old.id)
 ON CONFLICT(page_id) DO UPDATE SET generation=excluded.generation,status='queued',error=NULL; END;
CREATE TRIGGER research_wiki_claim_update
 AFTER UPDATE ON research_claims BEGIN INSERT INTO research_wiki_jobs(page_id,generation,status,error)
 SELECT id,lower(hex(randomblob(16))),'queued',NULL FROM research_wiki_pages WHERE id IN (SELECT page_id FROM research_wiki_dependencies WHERE kind='claim' AND dependency_id=old.id)
 ON CONFLICT(page_id) DO UPDATE SET generation=excluded.generation,status='queued',error=NULL; END;
CREATE TRIGGER research_wiki_claim_delete
 AFTER DELETE ON research_claims BEGIN INSERT INTO research_wiki_jobs(page_id,generation,status,error)
 SELECT id,lower(hex(randomblob(16))),'queued',NULL FROM research_wiki_pages WHERE id IN (SELECT page_id FROM research_wiki_dependencies WHERE kind='claim' AND dependency_id=old.id)
 ON CONFLICT(page_id) DO UPDATE SET generation=excluded.generation,status='queued',error=NULL; END;
CREATE TRIGGER research_wiki_relation_insert
 AFTER INSERT ON research_evidence_relations BEGIN
 INSERT INTO research_wiki_jobs(page_id,generation,status,error)
 SELECT id,lower(hex(randomblob(16))),'queued',NULL FROM research_wiki_pages WHERE id IN (SELECT page_id FROM research_wiki_dependencies WHERE kind='relations' AND dependency_id=new.claim_id)
 ON CONFLICT(page_id) DO UPDATE SET generation=excluded.generation,status='queued',error=NULL; END;
CREATE TRIGGER research_wiki_relation_update
 AFTER UPDATE ON research_evidence_relations BEGIN
 INSERT INTO research_wiki_jobs(page_id,generation,status,error)
 SELECT id,lower(hex(randomblob(16))),'queued',NULL FROM research_wiki_pages WHERE id IN (SELECT page_id FROM research_wiki_dependencies WHERE kind='relations' AND dependency_id=old.claim_id)
 ON CONFLICT(page_id) DO UPDATE SET generation=excluded.generation,status='queued',error=NULL; END;
CREATE TRIGGER research_wiki_relation_delete
 AFTER DELETE ON research_evidence_relations BEGIN
 INSERT INTO research_wiki_jobs(page_id,generation,status,error)
 SELECT id,lower(hex(randomblob(16))),'queued',NULL FROM research_wiki_pages WHERE id IN (SELECT page_id FROM research_wiki_dependencies WHERE kind='relations' AND dependency_id=old.claim_id)
 ON CONFLICT(page_id) DO UPDATE SET generation=excluded.generation,status='queued',error=NULL; END;


CREATE TABLE research_scientific_index_generations (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES research_projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  parse_id TEXT NOT NULL,
  parse_hash TEXT NOT NULL,
  paper_ir_version TEXT NOT NULL,
  chunk_version TEXT NOT NULL,
  embedding_config_id TEXT,
  embedding_config_revision INTEGER,
  embedding_model TEXT,
  dimensions INTEGER,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  chunk_count INTEGER NOT NULL CHECK(chunk_count >= 0),
  retrievable_count INTEGER NOT NULL CHECK(retrievable_count >= 0 AND retrievable_count <= chunk_count),
  chunks_hash TEXT NOT NULL,
  relations_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('building','active','retired','failed','cancelled')),
  error TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  CHECK((embedding_config_id IS NULL AND embedding_config_revision IS NULL AND embedding_model IS NULL AND dimensions IS NULL)
    OR (embedding_config_id IS NOT NULL AND embedding_config_revision IS NOT NULL AND embedding_config_revision > 0
      AND embedding_model IS NOT NULL AND dimensions IS NOT NULL AND dimensions > 0))
);
CREATE UNIQUE INDEX research_scientific_active_scope ON research_scientific_index_generations(scope_key)
  WHERE status='active';
CREATE UNIQUE INDEX research_scientific_building_scope ON research_scientific_index_generations(scope_key)
  WHERE status='building';
CREATE INDEX research_scientific_generation_scope ON research_scientific_index_generations(project_id,document_id,created_at);
CREATE TABLE research_scientific_chunks (
  generation_id TEXT NOT NULL REFERENCES research_scientific_index_generations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  project_id TEXT REFERENCES research_projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  paper_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  parent_id TEXT,
  chunk_type TEXT NOT NULL CHECK(chunk_type IN ('paragraph','table','table_row_group','figure','equation','algorithm','caption')),
  section_path TEXT NOT NULL CHECK(json_valid(section_path)),
  semantic_roles TEXT NOT NULL CHECK(json_valid(semantic_roles)),
  content TEXT NOT NULL,
  embedding_text TEXT NOT NULL,
  locator_json TEXT NOT NULL CHECK(json_valid(locator_json)),
  content_hash TEXT NOT NULL,
  input_version TEXT NOT NULL,
  embedding_text_hash TEXT NOT NULL,
  chunk_json TEXT NOT NULL CHECK(json_valid(chunk_json)),
  chunk_hash TEXT NOT NULL,
  retrieval INTEGER NOT NULL CHECK(retrieval IN (0,1)),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  PRIMARY KEY(generation_id,id),
  UNIQUE(generation_id,ordinal),
  FOREIGN KEY(generation_id,parent_id) REFERENCES research_scientific_chunks(generation_id,id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX research_scientific_parent ON research_scientific_chunks(generation_id,parent_id);
CREATE TABLE research_scientific_chunk_relations (
  generation_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  relation_id TEXT NOT NULL,
  relation_json TEXT NOT NULL CHECK(json_valid(relation_json)),
  PRIMARY KEY(generation_id,chunk_id,relation_id),
  FOREIGN KEY(generation_id,chunk_id) REFERENCES research_scientific_chunks(generation_id,id) ON DELETE CASCADE
);
CREATE VIRTUAL TABLE research_scientific_fts USING fts5(
  generation_id UNINDEXED, chunk_id UNINDEXED, content,
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER research_scientific_chunks_fts_insert AFTER INSERT ON research_scientific_chunks
WHEN new.retrieval=1 BEGIN
  INSERT INTO research_scientific_fts(generation_id,chunk_id,content)
    VALUES(new.generation_id,new.id,new.embedding_text);
END;
CREATE TRIGGER research_scientific_chunks_fts_delete AFTER DELETE ON research_scientific_chunks BEGIN
  DELETE FROM research_scientific_fts WHERE generation_id=old.generation_id AND chunk_id=old.id;
END;
CREATE TABLE research_scientific_embeddings (
  generation_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  config_id TEXT NOT NULL,
  config_revision INTEGER NOT NULL CHECK(config_revision > 0),
  model TEXT NOT NULL,
  input_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK(dimensions > 0),
  embedding BLOB NOT NULL,
  embedding_hash TEXT NOT NULL,
  PRIMARY KEY(generation_id,chunk_id),
  FOREIGN KEY(generation_id,chunk_id) REFERENCES research_scientific_chunks(generation_id,id) ON DELETE CASCADE,
  CHECK(length(embedding)=dimensions*4)
);


CREATE TABLE research_paper_extraction_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  source_generation_id TEXT NOT NULL REFERENCES research_scientific_index_generations(id),
  parse_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  parse_hash TEXT NOT NULL,
  parser_fingerprint TEXT NOT NULL,
  paper_ir_hash TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation > 0),
  input_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','published','failed','cancelled')),
  publication TEXT NOT NULL CHECK(publication IN ('unpublished','active','retired')),
  attempts INTEGER NOT NULL CHECK(attempts >= 0),
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  published_at TEXT,
  candidates_json TEXT CHECK(candidates_json IS NULL OR json_valid(candidates_json)),
  candidates_hash TEXT,
  result_hash TEXT,
  CHECK((status='published') = (publication IN ('active','retired'))),
  CHECK((status='published') = (published_at IS NOT NULL AND candidates_json IS NOT NULL
    AND candidates_hash IS NOT NULL AND result_hash IS NOT NULL)),
  UNIQUE(project_id,document_id,generation)
);
CREATE UNIQUE INDEX research_paper_extraction_active ON research_paper_extraction_jobs(project_id,document_id)
  WHERE publication='active';
CREATE UNIQUE INDEX research_paper_extraction_pending ON research_paper_extraction_jobs(project_id,document_id)
  WHERE status IN ('queued','running');
CREATE INDEX research_paper_extraction_schedule ON research_paper_extraction_jobs(status,created_at);
CREATE TABLE research_paper_entities (
  generation_id TEXT NOT NULL REFERENCES research_paper_extraction_jobs(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL,
  id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  PRIMARY KEY(generation_id,candidate_id),
  UNIQUE(generation_id,ordinal)
);
CREATE INDEX research_paper_entities_identity ON research_paper_entities(id,generation_id);
CREATE TABLE research_paper_entity_aliases (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  alias TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_by TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  PRIMARY KEY(id,revision),
  UNIQUE(project_id,id,revision)
);
CREATE TABLE research_paper_facts (
  generation_id TEXT NOT NULL REFERENCES research_paper_extraction_jobs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  PRIMARY KEY(generation_id,id),
  UNIQUE(generation_id,ordinal)
);
CREATE TABLE research_paper_fact_evidence (
  generation_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('evidence','condition','unit')),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  PRIMARY KEY(generation_id,fact_id,ordinal),
  FOREIGN KEY(generation_id,fact_id) REFERENCES research_paper_facts(generation_id,id) ON DELETE CASCADE
);
CREATE TABLE research_paper_relations (
  generation_id TEXT NOT NULL REFERENCES research_paper_extraction_jobs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  PRIMARY KEY(generation_id,id),
  UNIQUE(generation_id,ordinal)
);
