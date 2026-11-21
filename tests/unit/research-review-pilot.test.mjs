import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {writeFile} from 'node:fs/promises';
import {createReviewExtractionFixture} from './fixtures/research-review-extraction.mjs';
import {fullTextActor as actor} from './fixtures/research-review-fulltext-screening.mjs';
import {reviewProtocolBodyFixture} from './fixtures/research-review-protocol.mjs';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());

async function scene(options) {
  const f = await createReviewExtractionFixture(api, options);
  const pilot = new api.ResearchReviewExtractionPilot(f.repository, f.fullFreezing, f.fulltexts, f.extractions);
  const request = () => ({...f.get, expectedFullFreezeHash: f.fullFrozen?.freezeHash ?? 'a'.repeat(64),
    expectedProtocolVersionHash: f.protocol.versionHash, hitIds: [f.corpus.snapshot.hits[0].id], expectedReportHash: null});
  return {...f, pilot, request};
}

test('pilot reads a frozen included sample and real binding, preserving absent cells without writing extraction decisions', async () => {
  const body = reviewProtocolBodyFixture();
  body.extractionFields.push({id: 'setting', label: 'Observed setting', unit: null, required: false});
  const f = await scene({protocolBody: body});
  try {
    const before = f.changes();
    const report = await f.pilot.inspect(f.request());
    assert.equal(report.status, 'current');
    assert.equal(report.attentionRequired, true);
    assert.equal(report.samples.length, 1);
    assert.equal(report.samples[0].sourceStatus, 'byte_checked');
    assert.equal(report.samples[0].binding.id, f.binding.snapshot.id);
    assert.equal(report.samples[0].extraction, null);
    assert.deepEqual(report.fieldDefinitions, f.protocol.version.body.extractionFields);
    assert.deepEqual(report.samples[0].fields.map(cell => [cell.fieldId, cell.status]), [['difference', 'unextracted'], ['setting', 'unextracted']]);
    assert.ok(report.nextActions.some(action => action.action === 'extract_sample'));
    assert.equal(f.changes(), before);
    assert.deepEqual(await f.pilot.inspect({...f.request(), expectedReportHash: report.reportHash}), report);
    assert.equal(f.changes(), before);
    for (const hitIds of [[], [f.corpus.snapshot.hits[0].id, f.corpus.snapshot.hits[0].id],
      f.corpus.snapshot.hits.slice(0, 6).map(hit => hit.id), [f.corpus.snapshot.hits[1].id]]) {
      await assert.rejects(f.pilot.inspect({...f.request(), hitIds}));
    }
    assert.equal(f.changes(), before);
  } finally {await f.cleanup();}
});

test('recorded, missing and unjudgeable fields remain distinct, bounded source-linked findings after individual human saves', async () => {
  const f = await scene();
  try {
    const request = f.extract();
    request.fields[0].value = {kind: 'missing', reason: 'The inspected report does not give this outcome.'};
    request.studyDesign.value = {kind: 'unjudgeable', reason: 'Insufficient design detail in the report.'};
    const saved = await f.extractions.save(request, actor), before = f.changes();
    const report = await f.pilot.inspect(f.request());
    assert.equal(report.samples[0].sourceStatus, 'byte_checked');
    assert.equal(report.samples[0].studyDesign.status, 'unjudgeable');
    assert.equal(report.samples[0].fields[0].status, 'missing');
    assert.equal(report.samples[0].fields[0].reason, request.fields[0].value.reason);
    assert.deepEqual(report.samples[0].fields[0].evidenceIds, [f.evidence.id]);
    assert.deepEqual(report.samples[0].extraction, {id: saved.snapshot.id, hash: saved.snapshotHash});
    assert.equal(report.attentionRequired, true);
    assert.ok(report.nextActions.length <= 20);
    assert.equal(f.changes(), before);
    const corrected = {...f.extract('correction'), parentExtractionId: saved.snapshot.id,
      expectedParentHash: saved.snapshotHash, revisionReason: 'Re-examined the exact controlled report.'};
    await f.extractions.save(corrected, actor);
    const current = await f.pilot.inspect({...f.request(), expectedReportHash: report.reportHash});
    assert.equal(current.status, 'stale');
    assert.equal(current.samples[0].fields[0].status, 'recorded');
    assert.equal(current.samples[0].fields[0].value.number, 1);
    assert.equal(current.samples[0].studyDesign.status, 'recorded');
    assert.equal(current.attentionRequired, false);
    assert.equal(current.samples[0].sourceStatus, 'byte_checked');
  } finally {await f.cleanup();}
});

test('protocol drift retains frozen fields while actual corrupt original bytes cannot be presented as checked', async () => {
  const f = await scene();
  try {
    await f.extractions.save(f.extract(), actor);
    const original = await f.pilot.inspect(f.request());
    await writeFile(f.sourcePath, Buffer.from('Changed original source.'));
    const changed = await f.pilot.inspect(f.request());
    assert.equal(changed.samples[0].sourceStatus, 'stale');
    assert.equal(changed.samples[0].fields[0].status, 'stale');
    assert.ok(changed.issues.some(issue => issue.code === 'research_document_source_changed'));
    await writeFile(f.sourcePath, f.original);
    const body = structuredClone(f.protocol.version.body);
    body.extractionFields[0].label = 'Revised extraction definition';
    f.repository.systematicReviews.save({projectId: f.project.id, requestId: 'later-pilot-protocol', protocolId: f.protocol.version.protocolId,
      expectedVersionId: f.protocol.version.id, expectedVersionHash: f.protocol.versionHash, body, deviationReason: 'Revise fields after pilot.'}, actor);
    const before = f.changes();
    const stale = await f.pilot.inspect({...f.request(), expectedReportHash: original.reportHash});
    assert.equal(stale.status, 'stale');
    assert.equal(stale.fieldDefinitions[0].label, f.protocol.version.body.extractionFields[0].label);
    assert.ok(stale.issues.some(issue => issue.code === 'protocol_changed'));
    assert.equal(stale.samples[0].sourceStatus, 'stale');
    assert.equal(f.changes(), before);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    const archived = await f.pilot.inspect(f.request());
    assert.equal(archived.samples[0].sourceStatus, 'unavailable');
    assert.ok(archived.issues.some(issue => issue.code === 'project_archived'));
  } finally {await f.cleanup();}
});
