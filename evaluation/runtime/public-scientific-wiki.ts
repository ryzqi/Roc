import Database from 'better-sqlite3';
import {applyResearchDatabaseSchema} from '../../src/main/infrastructure/database-schemas';
import {ResearchKnowledgeRepository} from '../../src/main/plugins/research/knowledge-repository';
import {ResearchEvidenceRepository} from '../../src/main/plugins/research/evidence-repository';
import {ResearchWikiRepository} from '../../src/main/plugins/research/wiki-repository';

type Document = {
  id: string; sourceId: string; sourceVersion: string; sourceUri: string; license: string;
  parserVersion: string; title: string; content: string; contentSha256: string;
  blocks: Array<{startOffset: number; endOffset: number; section: string | null}>;
};

/** Deterministic source compilation and explicit invalidation only.
 * Inputs are published text, never gold facts/questions or model responses. */
export async function runPublicScientificWiki(input: {path: string; documents: Document[]}) {
  const db = new Database(input.path), projectId = 'scientific-public-qasper';
  const now = () => '2026-11-16T00:00:00.000Z';
  applyResearchDatabaseSchema(db, now);
  db.prepare(`INSERT INTO research_projects
    (id,title,description,status,current_stage,created_at,updated_at)
    VALUES (?,?,'Public text component baseline','active','reading',?,?)`)
    .run(projectId, projectId, now(), now());
  const requireProject = (id: string) => {if (id !== projectId) throw new Error('wiki_project_mismatch');};
  const unavailable = () => {throw new Error('wiki_component_artifacts_unavailable');};
  const evidence = new ResearchEvidenceRepository(db,
    {get: unavailable, requireEditable: unavailable, requireReviewable: unavailable}, now, unavailable);
  const knowledge = new ResearchKnowledgeRepository(db, requireProject, now);
  const wiki = new ResearchWikiRepository(db, evidence, requireProject, now, knowledge);
  const timings: Array<{paperId: string; stage: string; elapsedMs: number; inputs: number; outputs: number}> = [];
  const cases: Array<{paperId: string; pageId: string; invalidatedEvidenceId: string}> = [];
  try {
    for (const document of input.documents) {
      let started = performance.now();
      knowledge.upsertFromSource({id: document.id, projectId, sourceId: document.sourceId,
        sourceType: 'literature', title: document.title, content: document.content, embeddingPolicy: 'none',
        chunks: document.blocks.map(block => ({content: document.content.slice(block.startOffset, block.endOffset),
          locator: `utf16:${block.startOffset}-${block.endOffset}`, section: block.section}))},
      {sourceHash: document.contentSha256, sourceVersion: document.sourceVersion,
        sourceUri: document.sourceUri, license: document.license, parserVersion: document.parserVersion,
        parseId: document.parserVersion});
      const chunks = knowledge.knowledgeChunks(document.id).slice(0, 50);
      timings.push({paperId: document.sourceId, stage: 'index', elapsedMs: performance.now() - started,
        inputs: document.blocks.length, outputs: chunks.length});
      if (chunks.length < 2) throw new Error('wiki_component_cohort_insufficient');
      const captured = chunks.map(chunk => evidence.capture({projectId, chunkId: chunk.id}));
      started = performance.now();
      const page = wiki.create({projectId, kind: 'topic', title: `QASPER ${document.sourceId}`,
        evidenceIds: captured.slice(0, 20).map(item => item.id), claimIds: []});
      await wiki.idle();
      let current = wiki.read(projectId, page.page.id);
      if (!current.current || current.page.job?.status !== 'ready') throw new Error('wiki_component_compile_failed');
      // Source-copy probe exercises retained assistant dependency semantics;
      // it is explicitly not model generation or a fact-quality sample.
      current = wiki.save({projectId, pageId: page.page.id, expectedRevision: current.page.revision,
        expectedBasisDigest: current.basisDigest,
        section: {id: 'source-copy-probe', title: 'Source copy dependency probe',
          body: captured[0]!.excerpt.slice(0, 1000), evidenceIds: [captured[0]!.id],
          claimIds: [], links: []}}, 'assistant');
      timings.push({paperId: document.sourceId, stage: 'wiki-compile',
        elapsedMs: performance.now() - started, inputs: captured.length,
        outputs: current.current!.sections.length});
      cases.push({paperId: document.sourceId, pageId: current.page.id,
        invalidatedEvidenceId: captured[0]!.id});
    }
    await wiki.idle();
    const pages = db.prepare('SELECT id FROM research_wiki_pages ORDER BY rowid').all() as Array<{id: string}>;
    const before = pages.map(({id}) => wiki.read(projectId, id));
    const immutableEvidenceBefore = db.prepare('SELECT * FROM research_evidence ORDER BY rowid').all();
    const immutableRevisionsBefore = db.prepare('SELECT * FROM research_wiki_revisions ORDER BY page_id,revision').all();
    for (const item of cases) evidence.invalidateEvidence(item.invalidatedEvidenceId, projectId);
    const queued = db.prepare('SELECT * FROM research_wiki_jobs ORDER BY page_id').all();
    while (wiki.compileNext()) {}
    await wiki.idle();
    const after = pages.map(({id}) => wiki.read(projectId, id));
    return {projectId, cases, timings, before, queued, after,
      immutableEvidenceBefore, immutableRevisionsBefore,
      immutableEvidenceAfter: db.prepare('SELECT * FROM research_evidence ORDER BY rowid').all(),
      immutableRevisionsAfter: db.prepare('SELECT * FROM research_wiki_revisions ORDER BY page_id,revision').all(),
      jobs: db.prepare('SELECT * FROM research_wiki_jobs ORDER BY page_id').all()};
  } finally {
    await wiki.shutdown();
    db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
  }
}
