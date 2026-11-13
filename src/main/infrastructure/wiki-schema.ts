/** Transactional invalidation and outbox; no network work runs in source transactions. */
const enqueue = (where: string): string => `INSERT INTO research_wiki_jobs(page_id,generation,status,error)
 SELECT id,lower(hex(randomblob(16))),'queued',NULL FROM research_wiki_pages WHERE ${where}
 ON CONFLICT(page_id) DO UPDATE SET generation=excluded.generation,status='queued',error=NULL;`;
const affected = (kind: string, key: string): string =>
  `id IN (SELECT page_id FROM research_wiki_dependencies WHERE kind='${kind}' AND dependency_id=${key})`;
export const researchWikiSchema = `
CREATE TABLE research_paper_cards (
 document_id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL, version TEXT NOT NULL,
 snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
 generation TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')), error TEXT
);
CREATE TABLE research_wiki_pages (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('source','topic','comparison','dispute')), title TEXT NOT NULL,
 source_document_id TEXT, selection_json TEXT NOT NULL CHECK(json_valid(selection_json)),
 revision INTEGER NOT NULL DEFAULT 0, search_text TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
 UNIQUE(project_id,source_document_id)
);
CREATE INDEX research_wiki_project ON research_wiki_pages(project_id,updated_at);
CREATE TABLE research_wiki_revisions (
 page_id TEXT NOT NULL REFERENCES research_wiki_pages(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), PRIMARY KEY(page_id,revision)
);
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
 ${enqueue(`project_id=new.project_id AND source_document_id IN (new.document_id,
 json_extract((SELECT metadata_json FROM research_knowledge_documents WHERE id=new.document_id),'$.documentId'),
 json_extract((SELECT metadata_json FROM research_knowledge_documents WHERE id=new.document_id),'$.fileId'))`)}
END;
${(['UPDATE', 'DELETE'] as const).map(event => `CREATE TRIGGER research_wiki_evidence_${event.toLowerCase()}
 AFTER ${event} ON research_evidence BEGIN
 ${enqueue(`(project_id=old.project_id AND source_document_id IN (old.document_id,
 json_extract((SELECT metadata_json FROM research_evidence_source_metadata WHERE evidence_id=old.id),'$.documentId'),
 json_extract((SELECT metadata_json FROM research_evidence_source_metadata WHERE evidence_id=old.id),'$.fileId'))) OR ${affected('evidence', 'old.id')}`)} END;`).join('\n')}
${(['UPDATE', 'DELETE'] as const).map(event => `CREATE TRIGGER research_wiki_claim_${event.toLowerCase()}
 AFTER ${event} ON research_claims BEGIN ${enqueue(affected('claim', 'old.id'))} END;`).join('\n')}
${(['INSERT', 'UPDATE', 'DELETE'] as const).map(event => `CREATE TRIGGER research_wiki_relation_${event.toLowerCase()}
 AFTER ${event} ON research_evidence_relations BEGIN
 ${enqueue(affected('relations', `${event === 'INSERT' ? 'new' : 'old'}.claim_id`))} END;`).join('\n')}
`;
