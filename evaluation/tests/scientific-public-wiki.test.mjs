import assert from 'node:assert/strict';
import {copyFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {ROOT, sha256} from '../lib/common.mjs';
import {scorePublicScientificWiki} from '../adapters/scientific-public/wiki.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

test('independent Wiki scorer checks production persistence and rejects tampered receipts and sources', async t => {
  const root = mkdtempSync(join(tmpdir(), 'roc-scientific-wiki-'));
  const content = 'First published paragraph.\n\nSecond published paragraph.';
  const document = {id: 'qasper:test', sourceId: 'test', projectId: 'scientific-public-qasper',
    sourceVersion: 'published-test-v1', sourceUri: 'https://example.org/test', license: 'test-only',
    parserVersion: 'published-paragraphs-test-v1', title: 'Test paper', content,
    contentSha256: sha256(content), current: true, sourceType: 'literature',
    blocks: [{startOffset: 0, endOffset: 26, section: 'Introduction'},
      {startOffset: 28, endOffset: content.length, section: 'Method'}]};
  try {
    const {runPublicScientificWiki} = await importTypeScriptModule(
      join(ROOT, 'evaluation/runtime/public-scientific-wiki.ts'),
      {platform: 'node', external: ['better-sqlite3', 'zod', 'pdfjs-dist', 'pdfjs-dist/legacy/build/pdf.mjs'],
        tempDir: join(ROOT, 'evaluation/.runtime/imports')});
    const path = join(root, 'original.sqlite');
    const run = await runPublicScientificWiki({path, documents: [document]});
    await t.test('real compile, original citations, invalidation and immutable history', () => {
      const {metrics} = scorePublicScientificWiki(path, [document], run);
      assert.equal(metrics.pages, 2);
      assert.equal(metrics.sourceCopyCitationValidity, 1);
      assert.equal(metrics.stalePropagation, 1);
      assert.equal(metrics.preservedSourceCopyProbes, 1);
      assert.equal(metrics.factCoverage, null);
    });
    await t.test('modified after snapshot cannot claim a successful result', () => {
      const altered = structuredClone(run);
      altered.after[0].current.sections[0].body = 'invented scientific fact';
      assert.throws(() => scorePublicScientificWiki(path, [document], altered), /page_state_invalid/);
    });
    await t.test('modified persisted evidence is rejected before scoring', () => {
      const alteredPath = join(root, 'evidence.sqlite');
      copyFileSync(path, alteredPath);
      const db = new Database(alteredPath);
      db.prepare("UPDATE research_evidence SET excerpt='invented' WHERE id=?").run(run.immutableEvidenceAfter[0].id);
      db.close();
      assert.throws(() => scorePublicScientificWiki(alteredPath, [document], run), /evidence_receipt_changed/);
    });
    await t.test('changing an immutable old revision is rejected', () => {
      const alteredPath = join(root, 'revision.sqlite');
      copyFileSync(path, alteredPath);
      const db = new Database(alteredPath);
      const old = run.immutableRevisionsBefore[0];
      db.prepare("UPDATE research_wiki_revisions SET snapshot_json='{}' WHERE page_id=? AND revision=?")
        .run(old.page_id, old.revision);
      db.close();
      assert.throws(() => scorePublicScientificWiki(alteredPath, [document], run), /revision_receipt_changed/);
    });
    await t.test('claimed invalidation must have occurred in persisted evidence', () => {
      const alteredPath = join(root, 'invalidation.sqlite');
      copyFileSync(path, alteredPath);
      const db = new Database(alteredPath);
      db.function('roc_payload_hash', {deterministic: true}, raw => sha256(raw));
      db.prepare('UPDATE research_evidence SET invalidated_at=NULL WHERE id=?').run(run.cases[0].invalidatedEvidenceId);
      const altered = structuredClone(run);
      altered.immutableEvidenceAfter = db.prepare('SELECT * FROM research_evidence ORDER BY rowid').all();
      db.close();
      assert.throws(() => scorePublicScientificWiki(alteredPath, [document], altered), /invalidation_invalid/);
    });
    await t.test('wrong source identity is rejected by unchanged RAG verifier', () => {
      assert.throws(() => scorePublicScientificWiki(path, [{...document, content: 'changed'}], run), /source_mismatch/);
    });
  } finally {rmSync(root, {recursive: true, force: true});}
});
