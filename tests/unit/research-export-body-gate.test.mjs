import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import Database from 'better-sqlite3';

/**
 * Where the body invariants are actually enforced, pinned against the real repositories.
 *
 * This file exists because of a wrong premise. The plan was to add a gate for "an unsupported claim
 * reaches the export PDF", arguing from `evidence.assertPublishable()` returning early for non-figure
 * artifacts. That observation is true and the conclusion is false: `resolveManuscriptClaims()` calls
 * `assertSupported()` for every claim in every section, at write time *and* at read time. So the
 * invariant was already enforced twice, and a new check for it could never fire.
 *
 * Two things are worth pinning in a test rather than in a comment:
 *
 *   1. **where** the enforcement lives — if someone relaxes `saveManuscript` to accept hypotheses and
 *      moves the check to the export path, these tests fail and point at the move;
 *   2. the one rule that is genuinely missing — a `figure`-subject claim in a body section, which
 *      `assertSupported()` accepts (it does not look at `subjectType`) and which would therefore be
 *      rendered as prose *and* as a caption.
 *
 * `better-sqlite3` is native and cannot be bundled into a `data:` module, hence the temp directory
 * with a `node_modules` symlink. The `?raw` loaders are needed because `repository.ts` reaches
 * `figure-runner.ts` and `research-skills.ts`, which inline `figure.py` and the stage Skills —
 * the same two loaders `electron.vite.config.ts` sets for the main bundle.
 */

let tempDir;
let sources;
let schemas;
let repository;
let db;

const now = '2026-06-01T00:00:00.000Z';
const EVIDENCE_EXCERPT = 'An excerpt.';
const hashOf = (value) => createHash('sha256').update(value).digest('hex');

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-export-gate-'));
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
      loader: { '.py': 'text', '.md': 'text' },
      logLevel: 'silent'
    });
  await build('src/main/plugins/research/export-sources.ts', join(tempDir, 'export-sources.mjs'));
  await build('src/main/plugins/research/repository.ts', join(tempDir, 'repository.mjs'));
  await build('src/main/infrastructure/database-schemas.ts', join(tempDir, 'schemas.mjs'));
  ({ ResearchExportSourceService: sources } = await import(join(tempDir, 'export-sources.mjs')));
  ({ ResearchRepository: repository } = await import(join(tempDir, 'repository.mjs')));
  schemas = await import(join(tempDir, 'schemas.mjs'));
});

after(() => {
  db?.close();
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * A project in the writing stage with a draft manuscript artifact and the given claims.
 *
 * Writing must be the active, editable stage while claims are created: `requireEditableArtifact`
 * refuses a stage the project has already left, which is orthogonal to what is under test.
 */
function setup({ claims = [], evidence = [] } = {}) {
  db?.close();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  schemas.applyResearchDatabaseSchema(db, () => now);
  const repo = new repository(db, () => now);
  const project = repo.createProject({ title: 'Gate', description: 'why', workspacePath: `/tmp/${randomUUID()}` });
  db.prepare("UPDATE research_projects SET current_stage = 'writing' WHERE id = ?").run(project.id);
  db.prepare("UPDATE research_stage_states SET status = 'ready' WHERE project_id = ? AND stage = 'writing'").run(project.id);

  const manuscriptId = `artifact_${randomUUID()}`;
  const insertArtifact = db.prepare(
    `INSERT INTO research_artifacts (id, project_id, stage, kind, title, path, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`
  );
  insertArtifact.run(manuscriptId, project.id, 'writing', 'manuscript', 'Body', 'draft', now, now);

  for (const entry of evidence) {
    db.prepare(
      `INSERT INTO research_evidence (id, project_id, document_id, chunk_id, source_type, source_id, source_version, title, locator, excerpt, content_hash, created_at)
       VALUES (?, ?, 'doc', 'chunk', 'literature', 'src', 'v1', 'T', 'p1', ?, ?, ?)`
    ).run(entry.id, project.id, EVIDENCE_EXCERPT, hashOf(EVIDENCE_EXCERPT), now);
  }

  const claimIds = claims.map((claim) => {
    // Through the repository: `createClaim` validates that the evidence ids resolve, so a fixture
    // mistake surfaces here rather than as a puzzling failure further down.
    const created = repo.evidence.createClaim({ projectId: project.id, artifactId: manuscriptId,
      subjectType: claim.subjectType ?? 'claim', content: claim.content ?? 'A sentence.',
      status: claim.status ?? 'supported', evidenceIds: claim.evidenceIds ?? [] });
    return created.id;
  });
  return { repo, projectId: project.id, manuscriptId, claimIds };
}

/** Save the manuscript, approve it and accept the review cycle — the state an export starts from. */
function finalize(seeded, { cycleStatus = 'accepted' } = {}) {
  const sections = [{ title: 'Introduction', claimIds: seeded.claimIds }];
  seeded.repo.manuscripts.saveManuscript({ artifactId: seeded.manuscriptId, sections });
  db.prepare("UPDATE research_artifacts SET status = 'approved' WHERE id = ?").run(seeded.manuscriptId);
  db.prepare("UPDATE research_projects SET current_stage = 'export' WHERE id = ?").run(seeded.projectId);
  db.prepare(
    `INSERT INTO research_review_cycles
       (project_id, origin_artifact_id, manuscript_artifact_id, revision_round, status, report_artifact_ids_json, updated_at)
     VALUES (?, ?, ?, 0, ?, '[]', ?)`
  ).run(seeded.projectId, seeded.manuscriptId, seeded.manuscriptId, cycleStatus, now);
  return seeded;
}

/** `collect()` is private; `assertCurrent` is the public path that reaches the same gate. */
function attempt(seeded) {
  const service = new sources(seeded.repo, { verify: async () => undefined }, { snapshot: async () => undefined }, { files: async () => [] });
  return () => service.assertCurrent(
    { projectId: seeded.projectId, requestId: 'r1', title: 'T', manuscriptArtifactId: seeded.manuscriptId,
      figureIds: [], template: { kind: 'default', language: 'zh' } },
    { projectId: seeded.projectId, manuscriptArtifactId: seeded.manuscriptId, figureIds: [], claims: [], evidence: [],
      citationKeys: {}, bibliography: [], figures: [], experiments: [], libraryRevisions: [], provenance: [], modelRuns: [],
      evidenceMetadata: {}, review: { projectId: seeded.projectId, originArtifactId: seeded.manuscriptId,
        manuscriptArtifactId: seeded.manuscriptId, revisionRound: 0, status: 'accepted', reportArtifactIds: [], updatedAt: now },
      template: null, project: { id: seeded.projectId, title: 'Gate', description: 'why', workspacePath: null },
      manuscriptArtifact: seeded.repo.getArtifact(seeded.manuscriptId),
      manuscript: seeded.repo.manuscripts.getManuscript(seeded.manuscriptId) });
}

test('an unsupported claim cannot be written into the body at all', () => {
  // This is the invariant the plan believed was missing. It is enforced at write time, by
  // `manuscript-repository.ts resolveManuscriptClaims() -> evidence.assertSupported()`.
  const seeded = setup({ evidence: [{ id: 'ev-1' }], claims: [{ status: 'hypothesis', evidenceIds: ['ev-1'] }] });
  assert.throws(
    () => seeded.repo.manuscripts.saveManuscript({ artifactId: seeded.manuscriptId,
      sections: [{ title: 'Introduction', claimIds: seeded.claimIds }] }),
    /^Error: research_claim_unverified:claim_/u
  );
});

test('a supported claim with no evidence cannot even be created', () => {
  // Enforced one step earlier than the manuscript: `createClaim -> validateSupport` refuses it, so
  // it can never exist to be placed in a section. Recorded here so the enforcement point is not
  // guessed at later — this is the third layer the body gate would have duplicated.
  assert.throws(() => setup({ claims: [{ status: 'supported', evidenceIds: [] }] }), /^Error: research_claim_evidence_required/u);
});

test('a figure claim in a body section survives writing — that is the gap', () => {
  // `assertSupported()` checks status and evidence, not `subjectType`, so this is accepted. If it
  // ever starts failing, the one rule this step adds becomes unnecessary and should be deleted
  // rather than left as a second name for the same defect.
  const seeded = setup({ evidence: [{ id: 'ev-1' }], claims: [{ subjectType: 'figure', evidenceIds: ['ev-1'] }] });
  finalize(seeded);
  const manuscript = seeded.repo.manuscripts.getManuscript(seeded.manuscriptId);
  assert.deepEqual(manuscript.sections, [{ title: 'Introduction', claimIds: seeded.claimIds }]);
  assert.match(manuscript.latex, /A sentence\./u);
});

test('the export path refuses the body with the figure claim in it, and names the claim', () => {
  const seeded = setup({ evidence: [{ id: 'ev-1' }], claims: [{ subjectType: 'figure', evidenceIds: ['ev-1'] }] });
  finalize(seeded);
  assert.throws(attempt(seeded), (error) => {
    assert.equal(error.message, `research_export_figure_claim_in_body:${seeded.claimIds[0]}`);
    return true;
  });
});

test('a clean body gets past the gate on the real path', () => {
  const seeded = setup({ evidence: [{ id: 'ev-1' }], claims: [{ evidenceIds: ['ev-1'] }] });
  finalize(seeded);
  // It still fails later (no approved figures, no provenance), but it must not fail on the new
  // gate: a fixture gap masquerading as a gate failure is how a false gate gets written.
  try {
    attempt(seeded)();
  } catch (error) {
    assert.doesNotMatch(error.message, /research_export_figure_claim_in_body/u);
  }
});

test('an unaccepted review cycle keeps its own code, so a caller can still tell the two apart', () => {
  const seeded = setup({ evidence: [{ id: 'ev-1' }], claims: [{ evidenceIds: ['ev-1'] }] });
  finalize(seeded, { cycleStatus: 'reviewing' });
  assert.throws(attempt(seeded), /research_review_acceptance_required/u);
});
