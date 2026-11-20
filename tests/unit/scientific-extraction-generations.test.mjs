import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture, hash} from './fixtures/scientific-search-fixture.mjs';

let api, extraction, schemas;
before(async () => {
  [api, extraction, schemas] = await Promise.all([
    loadScientificSearchApi(),
    importTypeScriptModule('src/main/plugins/research/scientific-extraction-repository.ts', {platform: 'node'}),
    importTypeScriptModule('src/shared/schemas/research-scientific-extraction.ts')
  ]);
  Object.assign(api, await importTypeScriptModule('src/main/plugins/research/scientific-search-snapshot.ts',
    {platform: 'node', external: ['@napi-rs/canvas'], tempDir: '.runtime/tmp'}));
});
after(() => api?.dispose());
const config = () => ({extractorVersion: 'roc-scientific-knowledge/1', promptVersion: 'prompt/1',
  model: {provider: 'fixture', modelId: 'fixture-model-id', model: 'fixture-model', revision: 'revision/1'},
  inputTokens: 16_000, batchTokens: 8000});
async function captured(f, overrides = {}) {
  const snapshots = new api.ScientificSearchSnapshots(f.repository, {library: f.root, index: null});
  const papers = await snapshots.capture(f.project.id, snapshots.catalog(f.project.id, [f.document.id]),
    new AbortController().signal);
  const paper = papers.find(p => p.ir.identity.documentId === f.document.id);
  const resolution = {aliases: [], targets: []};
  return {paper, snapshot: schemas.scientificExtractionSnapshotSchema.parse({
    projectId: f.project.id, source: paper.receipt, config: config(),
    aliasesHash: extraction.scientificResolutionHash(resolution), resolution, ...overrides})};
}
function candidates(ir) {
  const table = ir.tables[0], valueCell = table.cells.find(c => c.text === '90');
  const label = table.cells.find(c => c.text === 'Original baseline'), metric = table.cells.find(c => c.text === 'F1 (%)');
  const cell = c => ({kind: 'table_cell', tableId: table.id, cellId: c.id, raw: c.text});
  const source = ir.blocks.find(b => b.blockId === 'body');
  const quote = {kind: 'text', blockId: source.blockId, start: 0, end: source.text.length, quote: source.text};
  const unknown = {datasetId: null, datasetVersion: 'unknown', split: 'unknown', metricId: 'metric',
    baselineId: null, budget: 'unknown', other: {}};
  return {
    entities: [
      {id: 'paper', entityType: 'Paper', canonicalName: ir.metadata.title, aliases: [],
        attributes: {title: ir.metadata.title, doi: ir.metadata.doi, year: ir.metadata.year},
        evidence: [{kind: 'metadata', field: 'title', raw: ir.metadata.title}]},
      {id: 'method', entityType: 'Method', canonicalName: label.text, aliases: [],
        attributes: {description: null}, evidence: [cell(label)]},
      {id: 'metric', entityType: 'Metric', canonicalName: 'F1', aliases: [],
        attributes: {definition: null, direction: 'unknown', unit: '%'}, evidence: [cell(metric)]}
    ],
    facts: [{id: 'result', factType: 'experimental_result', subjectEntityId: 'method', predicate: 'F1',
      objectEntityId: null, value: {raw: '90', unit: null, unitEvidence: []}, conditions: unknown,
      conditionEvidence: [{field: 'metricId', key: null, evidence: [cell(metric)]}],
      table: {tableId: table.id, row: valueCell.row, cellId: valueCell.id},
      evidence: [cell(label), cell(metric), cell(valueCell)], confidence: .9}],
    relations: [{id: 'proposes', type: 'PROPOSES', fromEntityId: 'paper', toEntityId: 'method',
      factIds: ['result'], evidence: [quote]}]
  };
}
async function setup() {
  const f = await scientificSearchFixture(api, {embedded: false});
  const store = new extraction.ScientificExtractionRepository(f.db);
  const source = await captured(f);
  return {...f, ...source, store};
}
function publish(f, overrides = {}) {
  const snapshot = overrides.snapshot ?? f.snapshot, ir = overrides.ir ?? f.paper.ir;
  const job = f.store.enqueue(snapshot, ir, overrides.force ?? false);
  f.store.claim(job.id, f.project.id);
  return f.store.publish(job.id, f.project.id, overrides.candidates ?? candidates(ir), ir,
    overrides.current ?? (() => snapshot), overrides.consumer);
}

test('SQLite publishes complete typed generations and original fact evidence without approved claims', async () => {
  const f = await setup();
  try {
    const job = publish(f), knowledge = f.store.bundle(job.id, f.project.id, f.paper.ir);
    assert.equal(job.status, 'published'); assert.equal(job.publication, 'active'); assert.equal(job.attempts, 1);
    assert.equal(knowledge.entities.length, 3); assert.equal(knowledge.facts.length, 1); assert.equal(knowledge.relations.length, 1);
    assert.deepEqual(knowledge.facts[0].value, {raw: '90', normalized: '0.9', rawUnit: '%', unit: 'ratio',
      unitEvidence: knowledge.facts[0].value.unitEvidence});
    assert.equal(knowledge.facts[0].value.unitEvidence.length, 1);
    assert.equal(knowledge.facts[0].conditions.split, 'unknown');
    assert.ok(knowledge.facts[0].evidence.every(e => e.identity.parseId === f.paper.ir.identity.parseId));
    assert.ok([...knowledge.entities, ...knowledge.facts, ...knowledge.relations].every(item => item.scientificApproval === 'unreviewed'));
    assert.equal(f.db.prepare('SELECT count(*) FROM research_paper_fact_evidence').pluck().get(), 5);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_claims').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence_relations').pluck().get(), 0);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    const before = f.db.serialize();
    assert.equal(f.store.enqueue(f.snapshot, f.paper.ir).id, job.id);
    assert.deepEqual(f.db.serialize(), before, 'identical work is read-only');
  } finally {await f.close();}
});

test('new prompt/model generations preserve prior results on failure and switch atomically on success', async () => {
  const f = await setup();
  try {
    const old = publish(f), original = f.store.bundle(old.id, f.project.id);
    const next = structuredClone(f.snapshot); next.config.promptVersion = 'prompt/2';
    const job = f.store.enqueue(next, f.paper.ir); f.store.claim(job.id, f.project.id);
    const bad = candidates(f.paper.ir); bad.facts[0].value.raw = '91';
    assert.throws(() => f.store.publish(job.id, f.project.id, bad, f.paper.ir, () => next), /fact_value_invalid/u);
    f.store.fail(job.id, f.project.id, 'fact_value_invalid');
    assert.equal(f.store.active(f.project.id, f.document.id).id, old.id);
    assert.deepEqual(f.store.bundle(old.id, f.project.id), original);
    assert.equal(f.store.enqueue(next, f.paper.ir).id, job.id, 'failed inputs require an explicit retry');
    assert.equal(f.store.get(job.id, f.project.id).status, 'failed');
    const retry = f.store.enqueue(next, f.paper.ir, true); assert.equal(retry.generation, 3);
    f.store.claim(retry.id, f.project.id);
    const current = structuredClone(next); current.config.model.revision = 'revision/2';
    assert.throws(() => f.store.publish(retry.id, f.project.id, candidates(f.paper.ir), f.paper.ir,
      () => current), /extraction_input_changed/u);
    assert.throws(() => f.store.publish(retry.id, f.project.id, candidates(f.paper.ir), f.paper.ir,
      () => next, () => {throw new Error('consumer_rolls_back');}), /consumer_rolls_back/u);
    assert.equal(f.store.active(f.project.id, f.document.id).id, old.id);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_paper_facts WHERE generation_id=?').pluck().get(retry.id), 0);
    f.store.publish(retry.id, f.project.id, candidates(f.paper.ir), f.paper.ir, () => next);
    assert.equal(f.store.get(old.id, f.project.id).publication, 'retired');
    assert.equal(f.store.active(f.project.id, f.document.id).id, retry.id);
    assert.deepEqual(f.store.bundle(old.id, f.project.id), original);
    f.store.fail(retry.id, f.project.id, 'late_failure');
    assert.equal(f.store.get(retry.id, f.project.id).status, 'published');
  } finally {await f.close();}
});

test('reparse returns stale historical facts without rewriting published rows and fences old running work', async () => {
  const f = await setup();
  try {
    const old = publish(f), before = f.store.bundle(old.id, f.project.id);
    const unfinished = f.store.enqueue(f.snapshot, f.paper.ir, true); f.store.claim(unfinished.id, f.project.id);
    await f.publish();
    const next = await captured(f);
    assert.throws(() => f.store.publish(unfinished.id, f.project.id, candidates(f.paper.ir), f.paper.ir,
      () => next.snapshot), /extraction_input_changed/u);
    const serialized = f.db.serialize(), read = f.store.read(f.project.id, f.document.id, next.paper.receipt.paperIR);
    assert.equal(read.state, 'stale');
    assert.ok(read.knowledge.facts.every(fact => fact.status === 'stale'));
    assert.ok(read.knowledge.entities.every(entity => entity.status === 'stale'));
    assert.deepEqual(f.store.bundle(old.id, f.project.id), before);
    assert.deepEqual(f.db.serialize(), serialized);
    const newer = f.store.enqueue(next.snapshot, next.paper.ir);
    assert.equal(f.store.get(unfinished.id, f.project.id).status, 'cancelled');
    f.store.claim(newer.id, f.project.id);
    f.store.publish(newer.id, f.project.id, candidates(next.paper.ir), next.paper.ir, () => next.snapshot);
    assert.equal(f.store.read(f.project.id, f.document.id, next.paper.receipt.paperIR, null, next.paper.ir).state, 'current');
    assert.equal(f.store.read(f.project.id, f.document.id, next.paper.receipt.paperIR, old.id).state, 'stale');
  } finally {await f.close();}
});

test('interrupted work recovers after real SQLite close/reopen with attempts and immutable history retained', async () => {
  const f = await setup();
  let db;
  try {
    const old = publish(f), job = f.store.enqueue(f.snapshot, f.paper.ir, true); f.store.claim(job.id, f.project.id);
    const path = join(f.root, 'reopened.db'); await writeFile(path, f.db.serialize());
    db = new Database(path); api.applyResearchDatabaseSchema(db); db.close(); db = new Database(path);
    api.applyResearchDatabaseSchema(db);
    const store = new extraction.ScientificExtractionRepository(db);
    assert.equal(store.recover(), 1); assert.equal(store.recover(), 0);
    assert.equal(store.get(job.id, f.project.id).attempts, 1);
    assert.equal(store.queued()[0].id, job.id);
    store.claim(job.id, f.project.id); assert.equal(store.get(job.id, f.project.id).attempts, 2);
    store.publish(job.id, f.project.id, candidates(f.paper.ir), f.paper.ir, () => f.snapshot);
    assert.equal(store.get(old.id, f.project.id).publication, 'retired');
    assert.deepEqual(store.bundle(old.id, f.project.id), f.store.bundle(old.id, f.project.id));
    assert.deepEqual(db.pragma('integrity_check'), [{integrity_check: 'ok'}]);
  } finally {db?.close(); await f.close();}
});

test('scope, source membership, snapshot/row corruption and async publication reject without replacing history', async () => {
  const f = await setup();
  try {
    const job = publish(f);
    assert.throws(() => f.store.get(job.id, 'foreign-project'), /scope_invalid/u);
    const unrecorded = structuredClone(f.snapshot);
    unrecorded.resolution.aliases = [{id: 'injected', projectId: f.project.id, entityType: 'Method', alias: 'name',
      targetEntityId: 'invented', canonicalName: 'name', revision: 1, createdBy: 'model'}];
    unrecorded.aliasesHash = extraction.scientificResolutionHash(unrecorded.resolution);
    assert.throws(() => f.store.enqueue(unrecorded, f.paper.ir), /aliases_changed/u);
    const newer = f.store.enqueue(f.snapshot, f.paper.ir, true); f.store.claim(newer.id, f.project.id);
    assert.throws(() => f.store.publish(newer.id, f.project.id, candidates(f.paper.ir), f.paper.ir,
      () => f.snapshot, () => Promise.resolve()), /must_be_synchronous/u);
    assert.equal(f.store.active(f.project.id, f.document.id).id, job.id);
    const row = f.db.prepare('SELECT * FROM research_paper_facts WHERE generation_id=?').get(job.id);
    f.db.prepare("UPDATE research_paper_facts SET fact_type='limitation' WHERE generation_id=?").run(job.id);
    assert.throws(() => f.store.bundle(job.id, f.project.id), /result_invalid/u);
    f.db.prepare('UPDATE research_paper_facts SET fact_type=? WHERE generation_id=?').run(row.fact_type, job.id);
    const data = JSON.parse(row.snapshot_json); data.value.raw = '91';
    const json = JSON.stringify(data);
    f.db.prepare('UPDATE research_paper_facts SET snapshot_json=?,snapshot_hash=? WHERE generation_id=?')
      .run(json, hash(json), job.id);
    assert.throws(() => f.store.bundle(job.id, f.project.id), /result_invalid/u);
    f.db.prepare('UPDATE research_paper_facts SET snapshot_json=?,snapshot_hash=? WHERE generation_id=?')
      .run(row.snapshot_json, row.snapshot_hash, job.id);
    f.repository.library.link(f.document.libraryItemId, f.project.id, false, {notify: false});
    assert.throws(() => f.store.enqueue(f.snapshot, f.paper.ir, true), /scope_invalid/u);
  } finally {await f.close();}
});

test('explicit alias revisions require an actual current target and keep prior dictionary history', async () => {
  const f = await setup();
  try {
    const job = publish(f), target = f.store.bundle(job.id, f.project.id).entities.find(e => e.entityType === 'Method');
    const entry = {id: 'human-alias', projectId: f.project.id, entityType: 'Method', alias: 'Original baseline',
      targetEntityId: target.id, canonicalName: target.canonicalName, revision: 1, createdBy: 'local-user'};
    assert.throws(() => f.store.putAlias(entry, {...target, id: 'invented'}), /alias_target_invalid/u);
    f.store.putAlias(entry, target);
    assert.deepEqual(f.store.aliases(f.project.id), [entry]);
    assert.throws(() => f.store.putAlias(entry, target), /alias_revision_invalid/u);
    f.store.putAlias({...entry, revision: 2}, target);
    assert.equal(f.store.aliases(f.project.id)[0].revision, 2);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_paper_entity_aliases').pluck().get(), 2);
    const resolution = {aliases: f.store.aliases(f.project.id), targets: [target]};
    const next = {...f.snapshot, resolution, aliasesHash: extraction.scientificResolutionHash(resolution)};
    const updated = publish(f, {snapshot: next});
    const merged = f.store.bundle(updated.id, f.project.id, f.paper.ir).entities.find(e => e.entityType === 'Method');
    assert.equal(merged.id, target.id); assert.equal(merged.identityBasis.revision, 2);
    const currentResolution = {aliases: f.store.aliases(f.project.id), targets: [merged]};
    assert.equal(extraction.scientificResolutionHash(currentResolution), next.aliasesHash,
      'republishing the same target identity must not schedule endless extractions');
    assert.equal(f.store.enqueue({...next, resolution: currentResolution}, f.paper.ir).id, updated.id);
    const queued = f.store.enqueue(next, f.paper.ir, true);
    f.store.claim(queued.id, f.project.id);
    f.store.publish(queued.id, f.project.id, candidates(f.paper.ir), f.paper.ir,
      () => ({...next, resolution: currentResolution}));
    assert.throws(() => f.store.putAlias({...entry, revision: 3}, target), /alias_target_invalid/u,
      'new dictionary revisions still require the exact current target');
    const injected = structuredClone(next); injected.resolution.targets[0].proposal.attributes.description = 'invented';
    assert.throws(() => f.store.enqueue(injected, f.paper.ir, true), /alias_target_invalid/u,
      'a historical target must be authentic, not a caller-supplied merge authority');
    assert.deepEqual(f.store.bundle(job.id, f.project.id).entities.find(e => e.entityType === 'Method'), target);
  } finally {await f.close();}
});
