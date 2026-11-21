import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createResearchFixture, loadResearchTestApi, unknownExperiment, withResearchTestWorker} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());

async function scene() {
  const root = await mkdtemp(join(tmpdir(), 'roc-manuscript-sync-'));
  const fixture = createResearchFixture(api, 'writing', root);
  const {project, repository, run} = fixture;
  repository.knowledge.upsertFromSource({id: 'manuscript-sync-notes', projectId: project.id, sourceType: 'file', sourceId: 'observed.txt',
    title: 'Measured timings', content: 'Recorded means and trial count.', embeddingPolicy: 'none',
    chunks: [{content: 'Observed mean 42 ms across three runs.', locator: 'block:0'}]});
  const evidence = repository.evidence.capture({projectId: project.id, chunkId: 'manuscript-sync-notes:chunk:0'});
  const result = withResearchTestWorker(api, repository, run.id, project.id, id => repository.runs.complete(id, project.id, {
    title: 'Synthetic paper', markdown: 'Original model output', verdict: 'ready', sections: [{title: 'Results & Limitations', claimIndexes: [0, 1]}],
    claims: ['Mean: 42 ms.', 'Three trials.'].map(content => ({subjectType: 'paragraph', content,
      status: 'supported', experiment: {...unknownExperiment}, evidenceIds: [evidence.id]}))
  }));
  repository.transitionWorkflow({projectId: project.id, expectedStage: 'writing', action: 'complete'});
  const artifactId = result.outputArtifactIds[0], scope = {projectId: project.id, artifactId};
  const claims = repository.evidence.listClaims(scope), sync = repository.manuscriptSync;
  const texPath = 'paper.tex', bibPath = 'references.bib';
  const human = (name, action) => api.withResearchHumanContext({capability: `research.manuscriptSync.${name}`,
    projectId: project.id, windowId: 12}, action);
  const version = () => repository.inspectArtifact({...scope, expectedVersion: null}).snapshot.version;
  const attachment = overrides => ({...scope, expectedArtifactVersion: version(), texPath, bibPath, mode: 'checkout', ...overrides});
  const attach = overrides => human('attach', () => sync.attach(attachment(overrides)));
  const apply = request => human('apply', () => sync.apply(request));
  const applyRequest = (preview, changes = preview.changes, requestId = 'revise') => ({...scope,
    expectedPreviewHash: preview.previewHash, requestId, changes: changes.map(({id, evidenceIds}) => ({id, evidenceIds}))});
  const tex = join(root, texPath), bib = join(root, bibPath);
  const close = async () => {try {await fixture.close();} finally {await rm(root, {recursive: true, force: true});}};
  return {...fixture, root, scope, artifactId, claims, evidence, sync, tex, bib, human, version, attachment, attach, apply, applyRequest, close};
}

test('checkout, exact review, partial adoption and reopened SQLite retain the current structured manuscript and outstanding workspace edits', async () => {
  const f = await scene();
  let disk, reopened;
  try {
    assert.equal((await f.sync.inspect(f.scope)).status, 'unbound');
    await assert.rejects(f.sync.attach(f.attachment()), /research_human_required/u);
    assert.equal((await f.attach()).status, 'current');
    const base = await readFile(f.tex, 'utf8'), beforeVersion = f.version();
    assert.ok(base.includes(`% roc-claim ${f.claims[0].id}`));
    const edited = base.replace('42 ms', '38 ms').replace('Three trials.', 'Four trials.');
    await writeFile(f.tex, edited);
    const first = await f.sync.inspect(f.scope);
    assert.equal(first.canApply, true);
    assert.deepEqual(first.changes.map(change => [change.before, change.after]), [['Mean: 42 ms.', 'Mean: 38 ms.'], ['Three trials.', 'Four trials.']]);
    await assert.rejects(f.sync.assertCurrent(f.scope.projectId, f.artifactId), /workspace_changed/u);
    const apply = f.applyRequest(first, [first.changes[0]]);
    await assert.rejects(f.sync.apply(apply), /research_human_required/u);
    await writeFile(f.tex, `${edited}\n% an edit after preview\n`);
    await assert.rejects(f.apply(apply), /research_manuscript_sync_conflict/u);
    await writeFile(f.tex, edited);
    await assert.rejects(f.apply({...apply, changes: [{id: first.changes[0].id, evidenceIds: []}]}), /evidence_mismatch/u);
    const partial = await f.apply(apply);
    assert.equal(partial.status, 'changed');
    assert.deepEqual(partial.changes.map(change => change.after), ['Four trials.']);
    assert.notEqual(partial.artifactVersion, beforeVersion);
    assert.deepEqual(f.repository.evidence.claimHistory(f.claims[0].id).map(claim => claim.content), ['Mean: 38 ms.', 'Mean: 42 ms.']);
    assert.equal(f.repository.evidence.getClaim(f.claims[1].id).version, 1);
    assert.equal(await readFile(f.tex, 'utf8'), edited);
    assert.equal(f.repository.getArtifact(f.artifactId).status, 'draft');
    assert.deepEqual(await f.apply(apply), partial);
    const dbPath = join(f.root, 'research-copy.sqlite');
    await f.db.backup(dbPath);
    disk = new Database(dbPath);
    api.applyResearchDatabaseSchema(disk);
    reopened = new api.ResearchRepository(disk, f.tasks);
    const afterRestart = await reopened.manuscriptSync.inspect(f.scope);
    assert.deepEqual(afterRestart, partial);
    const final = await f.human('apply', () => reopened.manuscriptSync.apply(f.applyRequest(afterRestart, afterRestart.changes, 'remaining')));
    assert.equal(final.status, 'current');
    await reopened.manuscriptSync.assertCurrent(f.scope.projectId, f.artifactId);
    assert.throws(() => reopened.manuscripts.exportBundle(f.scope), /approval_required/u);
    assert.equal(reopened.evidence.getClaim(f.claims[1].id).content, 'Four trials.');
  } finally {
    if (reopened !== undefined) await Promise.all([reopened.knowledgeJobs.shutdown(), reopened.paperCards.shutdown(), reopened.wiki.shutdown()]);
    disk?.close();
    await f.close();
  }
});

test('checkout never replaces existing work, and existing plain manuscripts surface unsupported TeX and changed bibliography entries', async () => {
  const owner = await scene(), target = await scene();
  try {
    await writeFile(owner.tex, 'owner had existing edits');
    await assert.rejects(owner.attach(), /path_exists/u);
    assert.equal(await readFile(owner.tex, 'utf8'), 'owner had existing edits');
    await assert.rejects(readFile(owner.bib), {code: 'ENOENT'});
    const entry = `@misc{${target.evidence.id}, title={Measured timings}, note={file: observed.txt}}`;
    const plain = `\\documentclass{article}\n\\begin{document}\n\\section{Results \\& Limitations}\nMean: 38 ms.\\cite{${target.evidence.id}}\n\nThree trials.\\cite{${target.evidence.id}}\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n`;
    await writeFile(target.bib, entry);
    await symlink(owner.tex, target.tex);
    await assert.rejects(target.attach({mode: 'existing'}), /research_path_symlink/u);
    await rm(target.tex);
    await writeFile(target.tex, plain);
    const existing = await target.attach({mode: 'existing'});
    assert.equal(existing.status, 'changed');
    assert.deepEqual(existing.changes.map(change => change.after), ['Mean: 38 ms.']);
    await writeFile(target.tex, plain.replace('Mean: 38 ms.', '\\input{different.tex}'));
    const unsupported = await target.sync.inspect(target.scope);
    assert.equal(unsupported.status, 'conflict');
    assert.equal(unsupported.canApply, false);
    assert.match(unsupported.issues[0], /TeX/u);
    assert.deepEqual(unsupported.changes, []);
    await writeFile(target.tex, plain);
    await writeFile(target.bib, entry.replace('Measured timings', 'A different experiment'));
    const changedBibliography = await target.sync.inspect(target.scope);
    assert.equal(changedBibliography.status, 'conflict');
    assert.match(changedBibliography.issues[0], /资料库不一致/u);
    await assert.rejects(target.sync.assertCurrent(target.scope.projectId, target.artifactId), /workspace_changed/u);
  } finally {await Promise.all([owner.close(), target.close()]);}
});

test('a citation key change needs the exact captured evidence in the bibliography and invalidates the old claim relationships', async () => {
  const f = await scene();
  try {
    await f.attach();
    f.repository.knowledge.upsertFromSource({id: 'manuscript-sync-followup', projectId: f.project.id,
      sourceType: 'file', sourceId: 'followup.txt', title: 'Follow-up timings', content: 'New data.', embeddingPolicy: 'none',
      chunks: [{content: 'Observed mean 38 ms.', locator: 'block:0'}]});
    const replacement = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'manuscript-sync-followup:chunk:0'});
    const originalTex = await readFile(f.tex, 'utf8');
    const revisedTex = originalTex.replace(`42 ms.\\cite{${f.evidence.id}}`, `38 ms.\\cite{${replacement.id}}`);
    await writeFile(f.tex, revisedTex);
    assert.match((await f.sync.inspect(f.scope)).issues[0], /缺少引用键/u);
    const originalBib = await readFile(f.bib, 'utf8');
    const revisedBib = `${originalBib}\n@misc{${replacement.id}, title={Follow-up timings}, note={file: followup.txt}}\n`;
    await writeFile(f.bib, `${revisedBib}\n@preamble{"Changed metadata"}\n`);
    assert.match((await f.sync.inspect(f.scope)).issues[0], /前导定义/u);
    await writeFile(f.bib, revisedBib);
    const preview = await f.sync.inspect(f.scope);
    assert.deepEqual(preview.changes.map(change => change.citationKeys), [[replacement.id]]);
    const request = f.applyRequest(preview);
    await assert.rejects(f.apply({...request, changes: [{id: request.changes[0].id, evidenceIds: [f.evidence.id]}]}), /evidence_mismatch/u);
    const applied = await f.apply({...request, changes: [{id: request.changes[0].id, evidenceIds: [replacement.id]}]});
    assert.equal(applied.status, 'current');
    assert.deepEqual(f.repository.evidence.getClaim(f.claims[0].id).evidenceIds, [replacement.id]);
    assert.ok(f.repository.evidence.relations.forArtifact(f.artifactId, f.project.id).some(relation =>
      relation.claimId === f.claims[0].id && relation.status === 'invalidated' && relation.invalidatedReason === 'claim_changed'));
  } finally {await f.close();}
});

test('real export capture rejects edited checkout and revision creates a new artifact without reusing human relation approvals', async () => {
  const f = await scene();
  try {
    await f.attach();
    const {projectId, artifactId} = f.scope;
    for (const relation of f.repository.evidence.relations.forArtifact(artifactId, projectId)) {
      f.repository.evidence.relations.review({projectId, relationId: relation.id,
        expectedVersion: relation.version, expectedClaimVersion: relation.claimVersion, expectedSourceDigest: relation.sourceDigest,
        decision: 'confirm', note: 'Confirmed synthetic source for export fixture.'}, {kind: 'user', id: 'fixture-reviewer'});
    }
    f.repository.transitionWorkflow({projectId, expectedStage: 'writing', action: 'approve',
      expectedArtifactVersions: [{artifactId, version: f.version()}]});
    const original = f.repository.manuscripts.getManuscript(artifactId);
    f.db.prepare("UPDATE research_projects SET current_stage='export' WHERE id=?").run(projectId);
    f.db.prepare("UPDATE research_review_cycles SET status='accepted' WHERE project_id=?").run(projectId);
    const never = async () => assert.fail('No figures, experiments or template in sync fixture.');
    const exports = new api.ResearchExportSourceService(f.repository, {verify: never}, {snapshot: never}, {files: never});
    const exportRequest = {projectId, manuscriptArtifactId: artifactId, figureIds: [], template: {kind: 'default', language: 'en'}};
    assert.equal((await exports.capture(exportRequest, new AbortController().signal)).manuscript.contentHash, original.contentHash);
    await writeFile(f.tex, (await readFile(f.tex, 'utf8')).replace('42 ms', '38 ms'));
    await assert.rejects(exports.capture(exportRequest, new AbortController().signal), /workspace_changed/u);
    assert.equal((await f.sync.inspect(f.scope)).canApply, false);
    f.db.prepare("UPDATE research_projects SET current_stage='revision' WHERE id=?").run(projectId);
    f.db.prepare("UPDATE research_stage_states SET status='ready' WHERE project_id=? AND stage='revision'").run(projectId);
    f.db.prepare("UPDATE research_review_cycles SET status='revision_required' WHERE project_id=?").run(projectId);
    const preview = await f.sync.inspect(f.scope);
    assert.equal(preview.canApply, true);
    const result = await f.apply(f.applyRequest(preview));
    assert.notEqual(result.artifactId, artifactId);
    assert.equal(result.status, 'current');
    assert.equal(f.repository.getArtifact(result.artifactId).status, 'draft');
    assert.equal(f.repository.reviews.get(projectId).manuscriptArtifactId, artifactId);
    assert.deepEqual(f.repository.manuscripts.getManuscript(artifactId), original);
    assert.equal(f.repository.evidence.getClaim(f.claims[0].id).content, 'Mean: 42 ms.');
    assert.deepEqual(f.repository.evidence.relations.forArtifact(result.artifactId, projectId), []);
    assert.equal((await f.sync.inspect(f.scope)).canApply, false);
  } finally {await f.close();}
});
