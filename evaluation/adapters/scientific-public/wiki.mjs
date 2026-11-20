import Database from 'better-sqlite3';
import {hash, sha256} from '../../lib/common.mjs';
import {readRagState} from '../rag/evidence.mjs';

/** Host-only verifier: raw SQLite, locked source intervals and immutable rows.
 * No production citation/digest helper is imported. */
export function scorePublicScientificWiki(path, documents, run) {
  const state = readRagState(path, documents);
  const chunks = new Map(state.chunks.map(chunk => [chunk.chunkId, chunk]));
  const sources = new Map(documents.map(document => [document.id, document]));
  const db = new Database(path, {readonly: true, fileMustExist: true});
  try {
    const raw = db.prepare('SELECT * FROM research_evidence ORDER BY rowid').all();
    if (hash(raw) !== hash(run.immutableEvidenceAfter)) throw new Error('wiki_evidence_receipt_changed');
    const records = new Map(raw.map(record => [record.id, record]));
    const identities = new Map(raw.map(record => [record.id, record.chunk_id]));
    for (const record of raw) {
      const chunk = chunks.get(record.chunk_id), document = sources.get(record.document_id);
      if (!chunk || !document || record.project_id !== run.projectId
        || record.excerpt !== document.content.slice(chunk.startOffset, chunk.endOffset)
        || record.content_hash !== sha256(record.excerpt) || record.locator !== chunk.locator) {
        throw new Error('wiki_original_source_invalid');
      }
    }
    const revisions = db.prepare('SELECT * FROM research_wiki_revisions ORDER BY page_id,revision').all();
    if (hash(revisions) !== hash(run.immutableRevisionsAfter)) throw new Error('wiki_revision_receipt_changed');
    const oldRevisions = new Map(revisions.map(row => [`${row.page_id}:${row.revision}`, row]));
    if (run.immutableRevisionsBefore.some(row => hash(row) !== hash(oldRevisions.get(`${row.page_id}:${row.revision}`)))) {
      throw new Error('wiki_old_revision_changed');
    }
    const stripInvalidation = row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'invalidated_at'));
    if (run.immutableEvidenceBefore.length !== raw.length || run.immutableEvidenceBefore.some(row =>
      hash(stripInvalidation(row)) !== hash(stripInvalidation(records.get(row.id))))) {
      throw new Error('wiki_immutable_excerpt_changed');
    }
    const before = new Map(run.before.map(page => [page.page.id, page]));
    const invalidated = new Set(run.cases.map(item => item.invalidatedEvidenceId));
    if (invalidated.size !== documents.length || raw.some(row =>
      Boolean(row.invalidated_at) !== invalidated.has(row.id))) throw new Error('wiki_invalidation_invalid');
    const pages = db.prepare('SELECT * FROM research_wiki_pages ORDER BY rowid').all();
    const jobs = db.prepare('SELECT * FROM research_wiki_jobs ORDER BY page_id').all();
    if (pages.length !== run.after.length || new Set(run.after.map(page => page.page.id)).size !== pages.length
      || hash(jobs) !== hash(run.jobs)) throw new Error('wiki_page_receipt_changed');
    const scores = run.after.map(page => {
      const prior = before.get(page.page.id);
      const row = pages.find(item => item.id === page.page.id);
      const job = jobs.find(item => item.page_id === page.page.id);
      const queued = run.queued.find(item => item.page_id === page.page.id);
      const persisted = oldRevisions.get(`${page.page.id}:${page.page.revision}`);
      const priorPersisted = oldRevisions.get(`${page.page.id}:${prior?.page.revision}`);
      if (!row || row.revision !== page.page.revision || row.project_id !== run.projectId
        || row.title !== page.page.title || row.kind !== page.page.kind
        || !persisted || hash(JSON.parse(persisted.snapshot_json)) !== hash(page.current)
        || !priorPersisted || hash(JSON.parse(priorPersisted.snapshot_json)) !== hash(prior.current)
        || job?.status !== 'ready' || queued?.status !== 'queued' || job.generation !== queued.generation
        || prior.page.job?.generation === queued.generation
        || page.page.revision <= prior.page.revision) throw new Error('wiki_page_state_invalid');
      if (!prior?.current || !page.current || page.page.job?.status !== 'ready') {
        throw new Error('wiki_compile_not_ready');
      }
      const expected = prior.current.sections.filter(section => section.evidenceIds.some(id => invalidated.has(id)));
      const stale = expected.filter(section =>
        page.current.sections.find(item => item.id === section.id)?.status === 'stale');
      const unaffected = prior.current.sections.filter(section => !section.evidenceIds.some(id => invalidated.has(id)));
      const unchanged = unaffected.filter(section =>
        hash(section) === hash(page.current.sections.find(item => item.id === section.id)));
      const citations = prior.current.sections.flatMap(section => section.evidenceIds.map(id => {
        const record = records.get(id);
        if (!record) throw new Error('wiki_citation_missing');
        const expectedText = section.id === 'source-copy-probe' ? record.excerpt.slice(0, 1000) : record.excerpt.slice(0, 5800);
        return {chunkId: identities.get(id), exact: section.body === expectedText,
          // The production section boundary trims outer whitespace. Preserve
          // byte-exact rate separately from source-prefix citation validity.
          valid: section.body.length > 0 && expectedText.trim().startsWith(section.body)};
      }));
      const probes = prior.current.sections.filter(section => section.id === 'source-copy-probe');
      const preservedProbe = probes.length > 0 &&
        probes.every(section => section.body === page.current.sections.find(item => item.id === section.id)?.body);
      const ordinal = run.before.findIndex(item => item.page.id === page.page.id);
      return {page: ordinal, title: page.page.title, citations,
        affectedSections: expected.length, staleSections: stale.length,
        unaffectedSections: unaffected.length, unchangedSections: unchanged.length, preservedProbe};
    });
    const total = key => scores.reduce((sum, score) => sum + score[key], 0);
    const citations = scores.flatMap(score => score.citations);
    return {scores, deterministicScoreHash: hash(scores), metrics: {
      pages: scores.length, capturedEvidence: raw.length, citationCount: citations.length,
      exactSourceCopyCitations: citations.filter(citation => citation.exact).length,
      sourceCopyExactRate: citations.length ? citations.filter(citation => citation.exact).length / citations.length : null,
      validSourceCopyCitations: citations.filter(citation => citation.valid).length,
      sourceCopyCitationValidity: citations.length ? citations.filter(citation => citation.valid).length / citations.length : null,
      affectedSections: total('affectedSections'), staleSections: total('staleSections'),
      stalePropagation: total('affectedSections') ? total('staleSections') / total('affectedSections') : null,
      unaffectedSections: total('unaffectedSections'), unchangedSections: total('unchangedSections'),
      oldRevisionsPreserved: run.immutableRevisionsBefore.length,
      immutableExcerptsPreserved: raw.length, preservedSourceCopyProbes: scores.filter(score => score.preservedProbe).length,
      factCoverage: null, generatedCitationValidity: null}};
  } finally {db.close();}
}
