import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import Database from 'better-sqlite3';

/**
 * Reference invalidation when the chunks a piece of evidence points at go away (proposal §8.4).
 *
 * The rule under test: a re-parse, an archive, a document delete or a contract-generation switch all
 * move a document from "chunks that exist" to "chunks that do not". The evidence row must survive —
 * the user's excerpt and its source are still theirs — but resolving it must say
 * `research_evidence_reference_superseded`, never `not_found` (that reads as "your evidence was
 * deleted") and never "here is some chunk" (silently repointing at new prose is worse than an error).
 *
 * The marker is written at the deletion site (`document-repository.removeIndex` →
 * `evidence.invalidateChunksOf`), not computed on read: chunks are keyed
 * `${knowledgeDocumentId}:chunk:${index}`, so a re-parse deletes the old knowledge document and
 * creates a new one. There is no "same chunk, changed text" case, which is why comparing content
 * hashes would have been a rule that can never fire.
 */

let tempDir;
let repository;
let schemas;
let db;

const now = '2026-06-01T00:00:00.000Z';
const EXCERPT = 'A sentence worth citing.';
const hashOf = (value) => createHash('sha256').update(value).digest('hex');

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-evidence-invalidation-'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(tempDir, 'node_modules'), 'dir');
  const build = (entry, outfile) =>
    esbuild.build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      packages: 'external',
      // `repository.ts` transitively inlines the stage SKILL.md files via `?raw`.
      loader: { '.md': 'text' },
      logLevel: 'silent'
    });
  await build('src/main/plugins/research/repository.ts', join(tempDir, 'repository.mjs'));
  await build('src/main/infrastructure/database-schemas.ts', join(tempDir, 'schemas.mjs'));
  ({ ResearchRepository: repository } = await import(join(tempDir, 'repository.mjs')));
  schemas = await import(join(tempDir, 'schemas.mjs'));
});

after(() => {
  db?.close();
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * A project with one document whose parse produced `chunks`, and one evidence row pointing at
 * `chunkIndex`. The knowledge document is written through the real repository so the chunk ids are
 * exactly what a parse would have produced.
 */
function setup({ chunks = ['First paragraph.', 'Second paragraph.'], chunkIndex = 0 } = {}) {
  db?.close();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  schemas.applyResearchDatabaseSchema(db, () => now);
  const repo = new repository(db, () => now);
  const project = repo.createProject({ title: 'Refs', description: 'why', workspacePath: `/tmp/${randomUUID()}` });
  // Through the real repositories: document import creates its own library item from the metadata,
  // so the fixture cannot drift from the product's identity/linking rules.
  const { document } = repo.documents.import({
    id: `doc_${randomUUID()}`, libraryItemId: null, projectId: project.id,
    entry: {
      metadata: { id: `lit_${randomUUID()}`, source: 'local', externalId: `ext_${randomUUID()}`, doi: null,
        title: 'A paper', authors: ['A. Author'], abstract: null, publishedYear: 2024, citationCount: null,
        url: null, openAccessUrl: null, importedAt: now, updatedAt: now },
      bibliography: { citationKey: 'paper2024', entryType: 'article', fields: { title: 'A paper' }, preambles: [],
        csl: null, title: 'A paper', authors: ['A. Author'], doi: null, publishedYear: 2024, abstract: null, url: null }
    },
    filename: 'a.pdf', mediaType: 'pdf', sourcePath: 'docs/a.pdf', sourceHash: hashOf('pdf'), size: 3
  });

  const parseId = `parse_${randomUUID()}`;
  repo.knowledge.upsertFromSource({
    id: `document:${parseId}`, projectId: null, sourceType: 'file', sourceId: document.libraryItemId,
    title: 'A paper — a.pdf', content: chunks.join('\n\n'),
    chunks: chunks.map((content, index) => ({ content, locator: `p${index + 1}` })), embeddingPolicy: 'none'
  });

  const evidenceId = `ev_${randomUUID()}`;
  db.prepare(
    `INSERT INTO research_evidence (id, project_id, document_id, chunk_id, source_type, source_id, source_version, title, locator, excerpt, content_hash, created_at)
     VALUES (?, ?, ?, ?, 'file', ?, 'v1', 'A paper', 'p1', ?, ?, ?)`
  ).run(evidenceId, project.id, document.id, `document:${parseId}:chunk:${chunkIndex}`, document.libraryItemId, EXCERPT, hashOf(EXCERPT), now);

  return { repo, project, documentId: document.id, parseId, evidenceId, knowledgeDocumentId: `document:${parseId}` };
}

test('a live reference resolves', () => {
  const seeded = setup();
  const evidence = seeded.repo.evidence.getEvidence(seeded.evidenceId, seeded.project.id);
  assert.equal(evidence.excerpt, EXCERPT);
});

test('deleting the knowledge document invalidates the reference it carried, and keeps the row', () => {
  const seeded = setup();
  // This is the exact call `document-repository.removeIndex()` makes before deleting the document.
  const invalidated = seeded.repo.evidence.invalidateChunksOf(seeded.knowledgeDocumentId);
  assert.equal(invalidated, 1);
  db.prepare('DELETE FROM research_knowledge_documents WHERE id = ?').run(seeded.knowledgeDocumentId);

  assert.throws(
    () => seeded.repo.evidence.getEvidence(seeded.evidenceId, seeded.project.id),
    /^Error: research_evidence_reference_superseded$/u
  );
  // The row is still there — this is "rebuild the reference", not "your evidence is gone".
  const row = db.prepare('SELECT excerpt FROM research_evidence WHERE id = ?').get(seeded.evidenceId);
  assert.equal(row.excerpt, EXCERPT);
});

test('invalidating one knowledge document leaves another document\'s evidence alone', () => {
  const seeded = setup();
  // A second, unrelated parse result: same shape, different knowledge document.
  const otherId = `document:parse_${randomUUID()}`;
  seeded.repo.knowledge.upsertFromSource({
    id: otherId, projectId: null, sourceType: 'file', sourceId: seeded.documentId,
    title: 'Other', content: 'Other paragraph.',
    chunks: [{ content: 'Other paragraph.', locator: 'p1' }], embeddingPolicy: 'none'
  });
  const otherEvidence = `ev_${randomUUID()}`;
  db.prepare(
    `INSERT INTO research_evidence (id, project_id, document_id, chunk_id, source_type, source_id, source_version, title, locator, excerpt, content_hash, created_at)
     VALUES (?, ?, ?, ?, 'file', ?, 'v1', 'Other', 'p1', 'Other excerpt.', ?, ?)`
  ).run(otherEvidence, seeded.project.id, seeded.documentId, `${otherId}:chunk:0`, seeded.documentId, hashOf('Other excerpt.'), now);

  assert.equal(seeded.repo.evidence.invalidateChunksOf(seeded.knowledgeDocumentId), 1);
  assert.throws(() => seeded.repo.evidence.getEvidence(seeded.evidenceId, seeded.project.id), /research_evidence_reference_superseded/u);
  // The untouched document's reference still resolves.
  assert.equal(seeded.repo.evidence.getEvidence(otherEvidence, seeded.project.id).excerpt, 'Other excerpt.');
});

test('a missing reference still reports not_found rather than superseded', () => {
  const seeded = setup();
  assert.throws(() => seeded.repo.evidence.getEvidence('ev_does_not_exist', seeded.project.id), /^Error: research_evidence_not_found$/u);
});

test('invalidating twice is idempotent and does not rewrite the marker', () => {
  const seeded = setup();
  assert.equal(seeded.repo.evidence.invalidateChunksOf(seeded.knowledgeDocumentId), 1);
  const first = db.prepare('SELECT invalidated_at FROM research_evidence WHERE id = ?').get(seeded.evidenceId).invalidated_at;
  assert.equal(seeded.repo.evidence.invalidateChunksOf(seeded.knowledgeDocumentId), 0);
  assert.equal(db.prepare('SELECT invalidated_at FROM research_evidence WHERE id = ?').get(seeded.evidenceId).invalidated_at, first);
});
