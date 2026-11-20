/** Current-schema DDL only. Existing databases require the separate offline migration. */
export const researchScientificExtractionSchema = `
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
`;
