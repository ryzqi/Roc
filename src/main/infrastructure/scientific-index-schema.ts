/** Part of the current Research schema; never initialized separately or backfilled at startup. */
export const researchScientificIndexSchema = `
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
`;
