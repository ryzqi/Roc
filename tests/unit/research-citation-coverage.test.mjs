import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {captureResearchArtifactVersions, createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const hash = value => createHash('sha256').update(value).digest('hex');

function scene(count = 1, imported = false) {
  const f = createResearchFixture(api, 'writing');
  f.sources = [];
  if (imported) {
    const document = f.repository.documents.import({id: 'coverage-document', libraryItemId: null, projectId: f.project.id,
      filename: 'fixture.pdf', mediaType: 'pdf', sourcePath: 'documents/fixture.pdf', sourceHash: hash('synthetic PDF'), size: 13,
      entry: {metadata: {id: 'coverage-literature', source: 'local', externalId: 'coverage-fixture', doi: null,
        title: 'Coverage fixture', authors: ['Synthetic Author'], abstract: null, publishedYear: 2026, citationCount: null,
        url: null, openAccessUrl: null, importedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z'},
      bibliography: {citationKey: 'coverage2026', entryType: 'article', fields: {title: 'Coverage fixture'}, preambles: [],
        csl: null, title: 'Coverage fixture', authors: ['Synthetic Author'], doi: null, publishedYear: 2026, abstract: null, url: null}}
    }, false).document;
    f.document = document;
    f.repository.documents.begin(document.id, 'coverage-parse');
    f.repository.documents.complete(document.id, 'coverage-parse', {outputPath: '/tmp/synthetic-coverage', files: {}, content: {
      contractVersion: 4, engine: 'paddleocr.js', engineVersion: 'synthetic-test', parserVersion: 'roc-research-parser/2',
      parserFingerprint: hash('synthetic parser'), modelManifest: '', runtime: {node: 'synthetic'}, tier: 'compact',
      parseMode: 'native-text', device: 'cpu', sourceHash: document.sourceHash, pageCount: 4,
      content: 'Synthetic measured result.', blocks: [{id: 'result-block', kind: 'paragraph', label: 'Synthetic result',
        text: 'Synthetic measured result.', locator: 'page:3', imageAssetId: null,
        locations: [{page: 3, bbox: [1, 2, 30, 40], coordinateOrigin: 'TOPLEFT'}]}], assets: [],
      artifacts: {middleJson: 'artifacts/middle.json', markdown: 'artifacts/document.md', structuredContent: 'artifacts/structured.json'},
      warnings: []
    }}, null);
    f.sources.push(f.repository.evidence.capture({projectId: f.project.id, chunkId: 'document:coverage-parse:chunk:0'}));
  } else for (let i = 0; i < count; i++) {
    const id = `coverage-${i}`;
    f.repository.knowledge.upsertFromSource({id, projectId: f.project.id, sourceType: 'file', sourceId: `synthetic-${i}.md`,
      title: `Synthetic source ${i}`, content: `Measured result ${i}.`,
      chunks: [{content: `Measured result ${i}.`, locator: `block:${i}`}], embeddingPolicy: 'none'});
    f.sources.push(f.repository.evidence.capture({projectId: f.project.id, chunkId: `${id}:chunk:0`}));
  }
  const completed = f.repository.runs.complete(f.run.id, f.project.id, {
    title: 'Citation inspection fixture', markdown: 'Synthetic claim awaiting human verification.',
    claims: [{subjectType: 'paragraph', content: 'A measured synthetic result.', status: 'supported', evidenceIds: f.sources.map(s => s.id)}],
    sections: [{title: 'Results', claimIndexes: [0]}], verdict: 'ready'
  });
  f.artifactId = completed.outputArtifactIds[0];
  f.claim = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: f.artifactId})[0];
  f.request = {projectId: f.project.id, artifactId: f.artifactId, expectedHash: null};
  f.service = new api.ResearchCitationCoverageService(f.repository);
  f.inspect = overrides => f.service.inspect({...f.request, ...overrides});
  f.relations = () => f.repository.evidence.relations.list({projectId: f.project.id, claimId: f.claim.id});
  f.review = (relation, decision = 'confirm') => f.repository.evidence.relations.review({
    projectId: f.project.id, relationId: relation.id, expectedVersion: relation.version,
    expectedClaimVersion: relation.claimVersion, expectedSourceDigest: relation.sourceDigest, decision, note: 'Human checked synthetic relation.'
  }, {kind: 'user', id: 'coverage-reviewer'});
  f.propose = (kind, condition = null) => f.repository.evidence.relations.propose({
    projectId: f.project.id, claimId: f.claim.id, expectedClaimVersion: f.claim.version, evidenceId: f.sources[0].id,
    expectedSourceDigest: api.relationSourceDigest(f.repository.evidence.inspectEvidence(f.sources[0].id, f.project.id)),
    kind, condition, supersedesRelationId: null
  }, {kind: 'user', id: 'coverage-reviewer'});
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  return f;
}

test('current draft coverage maps exact manuscript paragraphs, citations and source bytes without writes or inferred support', () => {
  const f = scene(2);
  try {
    const before = f.changes(), first = f.inspect(), bytes = JSON.stringify(first);
    assert.equal(first.status, 'current');
    assert.equal(first.reportHash, hash(JSON.stringify(first.report)));
    assert.deepEqual(first.report.counts, {paragraphs: 1, citations: 2, humanReviewedCitations: 0, qualifiedCitations: 0, paragraphsWithIssues: 1, directCitations: 0, indirectCitations: 0, unsupportedCitations: 0, unreviewedDirectnessCitations: 2});
    const paragraph = first.report.paragraphs[0];
    assert.deepEqual([paragraph.sectionIndex, paragraph.sectionTitle, paragraph.paragraphIndex], [0, 'Results', 0]);
    assert.deepEqual(paragraph.claim, f.claim);
    assert.deepEqual(paragraph.citations.map(c => c.manuscriptCitationKey), f.claim.evidenceIds);
    assert.ok(first.report.manuscript.latex.includes(`\\cite{${f.claim.evidenceIds.join(',')}}`));
    assert.deepEqual(first.report.sources.map(s => s.source.evidence), f.sources);
    assert.ok(first.report.sources.every(s => s.locationLevel === 'locator' && s.bibliography === null));
    assert.deepEqual(f.inspect({expectedHash: first.reportHash}), first);
    assert.equal(JSON.stringify(first), bytes);
    assert.equal(f.changes(), before);
  } finally {f.close();}
});

test('human support, qualification, contradiction and dependency remain distinct and invalidate previous report hashes', () => {
  const f = scene();
  try {
    const first = f.inspect(), bytes = JSON.stringify(first);
    f.review(f.relations()[0], 'reject');
    f.review(f.propose('depends_on'));
    assert.equal(f.inspect().report.counts.humanReviewedCitations, 0);
    const qualified = f.review(f.propose('qualifies', 'Only under the declared synthetic condition.'));
    let current = f.inspect({expectedHash: first.reportHash});
    assert.equal(current.status, 'stale');
    assert.equal(current.report.paragraphs[0].citations[0].supportReview, 'qualified');
    assert.deepEqual(current.report.paragraphs[0].citations[0].supportRelationIds, [qualified.id]);
    assert.equal(current.report.paragraphs[0].relations.find(r => r.id === qualified.id).condition, qualified.condition);
    f.review(f.propose('contradicts'));
    const supported = f.review(f.propose('supports'));
    const before = f.changes();
    current = f.inspect();
    assert.equal(current.report.paragraphs[0].citations[0].supportReview, 'confirmed');
    assert.ok(current.report.paragraphs[0].citations[0].supportRelationIds.includes(supported.id));
    assert.ok(current.report.paragraphs[0].issues.some(i => i.kind === 'confirmed_contradiction'));
    assert.equal(current.report.paragraphs[0].relations.find(r => r.id === supported.id).reviewer.id, 'coverage-reviewer');
    assert.equal(JSON.stringify(first), bytes);
    assert.equal(f.changes(), before);
  } finally {f.close();}
});

test('real imported PDF citation retains parse, page, region and current bibliography revision', () => {
  const f = scene(1, true);
  try {
    const first = f.inspect(), bytes = JSON.stringify(first), source = first.report.sources[0];
    assert.equal(source.source.evidence.sourceType, 'file');
    assert.equal(source.locationLevel, 'region');
    assert.deepEqual(source.source.sourceLocator.locations, [{page: 3, bbox: [1, 2, 30, 40], coordinateOrigin: 'TOPLEFT'}]);
    assert.equal(source.source.sourceLocator.parseId, 'coverage-parse');
    assert.equal(source.bibliography.itemId, f.document.libraryItemId);
    const item = f.repository.library.setCitationKey(source.bibliography.itemId, source.bibliography.revision, 'revised2026');
    const before = f.changes(), current = f.inspect({expectedHash: first.reportHash});
    assert.equal(current.status, 'stale');
    assert.equal(current.report.sources[0].bibliography.revision, item.revision);
    assert.equal(current.report.sources[0].bibliography.entry.citationKey, 'revised2026');
    assert.equal(current.report.sources[0].manuscriptCitationKey, f.sources[0].id);
    assert.equal(JSON.stringify(first), bytes);
    assert.equal(f.changes(), before);
    f.repository.library.archive(item.id, item.revision, true);
    const archived = f.changes();
    assert.throws(() => f.inspect(), /research_evidence_reference_superseded/u);
    assert.equal(f.changes(), archived);
  } finally {f.close();}
});

test('source and manuscript changes refuse stale citation content, then resaved claims get a distinct version', () => {
  const f = scene();
  try {
    const first = f.inspect();
    f.review(f.relations()[0]);
    f.claim = f.repository.evidence.updateClaim({id: f.claim.id, expectedVersion: f.claim.version, content: 'A revised measurement.',
      status: 'supported', evidenceIds: f.claim.evidenceIds});
    let before = f.changes();
    assert.throws(() => f.inspect(), /research_manuscript_stale/u);
    assert.equal(f.changes(), before);
    f.repository.manuscripts.saveManuscript({artifactId: f.artifactId, sections: first.report.manuscript.sections});
    before = f.changes();
    const current = f.inspect({expectedHash: first.reportHash});
    assert.equal(current.status, 'stale');
    assert.equal(current.report.paragraphs[0].claim.version, f.claim.version);
    assert.equal(current.report.counts.humanReviewedCitations, 0);
    assert.equal(f.changes(), before);
    f.repository.evidence.invalidateChunksOf(f.sources[0].documentId);
    before = f.changes();
    assert.throws(() => f.inspect(), /research_evidence_reference_superseded/u);
    assert.equal(f.changes(), before);
  } finally {f.close();}
});

test('approved and archived projects remain inspectable without executions or approval mutations', async () => {
  const f = scene();
  try {
    f.review(f.relations()[0]);
    const gate = api.createResearchHumanGate({repository: f.repository});
    await gate.complete({projectId: f.project.id, expectedStage: 'writing', action: 'complete'});
    await gate.approve({projectId: f.project.id, expectedStage: 'writing', action: 'approve',
      expectedArtifactVersions: captureResearchArtifactVersions(f.repository, f.project.id)});
    const first = f.inspect();
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    const before = f.changes();
    assert.equal(f.inspect().report.counts.humanReviewedCitations, 1);
    assert.equal(f.repository.getArtifact(f.artifactId).status, 'approved');
    assert.equal(f.inspect({expectedHash: first.reportHash}).status, 'stale');
    assert.equal(f.changes(), before);
  } finally {f.close();}
});

test('actual IPC reports missing, wrong-scope and stale manuscript failures and rejects unknown request keys', async () => {
  const f = scene();
  try {
    const handlers = new Map();
    api.registerResearchCitationCoverageCapability({pluginId: 'fixture',
      capabilities: {register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}}}, f.service);
    const bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => handlers.get(name)(input)});
    const invoke = input => bridge.invoke('research.inspectCitationCoverage', [input], 72);
    assert.equal((await invoke(f.request)).ok, true);
    const other = f.repository.createProject({title: 'Other scope', description: '', workspacePath: '/tmp/coverage-other'});
    let result = await invoke({...f.request, projectId: other.id});
    assert.equal(result.ok, false); assert.equal(result.error.code, 'research_manuscript_project_mismatch');
    assert.equal(result.error.category, 'permission');
    result = await invoke({...f.request, artifactId: 'missing'});
    assert.equal(result.ok, false); assert.equal(result.error.code, 'research_artifact_not_found');
    assert.equal(api.researchCitationCoverageRequestSchema.safeParse({...f.request, acceptUnreviewed: true}).success, false);
    assert.equal(api.researchCitationCoverageRequestSchema.safeParse({projectId: f.project.id, artifactId: f.artifactId}).success, false);
    f.db.prepare('DELETE FROM research_manuscripts WHERE artifact_id=?').run(f.artifactId);
    const before = f.changes();
    result = await invoke(f.request);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'research_manuscript_required');
    assert.equal(result.error.category, 'validation');
    assert.equal(f.changes(), before);
  } finally {f.close();}
});
