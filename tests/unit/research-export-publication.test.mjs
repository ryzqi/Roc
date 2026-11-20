import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const options = {platform: 'node', external: ['zod'], tempDir: join(process.cwd(), '.runtime/tmp')};
const api = await importTypeScriptModule('src/main/plugins/research/export-publication.ts', options);
const schemas = await importTypeScriptModule('src/shared/schemas/research-export-publication.ts', options);
const hash = value => createHash('sha256').update(value).digest('hex');
const license = {name: 'Synthetic permission', description: 'Explicit synthetic redistribution permission.', url: null};
const file = (path, area) => ({path, area, sha256: hash(path), size: Buffer.byteLength(path)});
const sources = () => ({
  project: {id: 'project'},
  experiments: [{id: 'run', request: {engine: 'typescript', sourcePath: 'run.mts'},
    files: [file('run.mts', 'input'), file('restricted.csv', 'input'), file('result.json', 'output'), file('stdout.txt', 'log')]}],
  figures: [{id: 'fig', runId: 'figure-run', validation: {files: [file('plot.pdf', 'output')]}}],
  template: {id: 'template', files: [{path: 'main.tex', size: 8, sha256: hash('template')}]},
  bibliography: [{citationKey: 'reference', title: 'Synthetic reference', url: null}]
});
const repository = {figureRuns: {get(project, id) {
  assert.equal(project, 'project'); assert.equal(id, 'figure-run');
  return {request: {sourcePath: 'plot.vl.json'},
    files: [file('plot.vl.json', 'input'), file('plot.pdf', 'output'), file('stderr.txt', 'log')]};
}}};
function review(candidates) {
  return {
    sourceHash: candidates.sourceHash,
    publication: {profile: 'roc-research-1', version: '1.2', name: 'Synthetic paper', description: 'Engineering fixture',
      datePublished: '2026-11-06', authors: [{name: 'Synthetic author', orcid: null}], license},
    resources: candidates.resources.map(candidate => ({
      source: structuredClone(candidate.source), kind: candidate.role === 'program' ? 'software' : candidate.role === 'figure' ? 'figure' : 'dataset',
      name: candidate.source.path, description: 'Explicit synthetic resource', license,
      version: candidate.role === 'program' ? 'fixture-1' : null,
      url: candidate.role === 'program' ? 'https://example.org/synthetic-code' : null,
      delivery: candidate.mandatory ? {kind: 'bundled'} :
        {kind: 'metadata_only', url: null, instructions: 'Obtain separate permission from the synthetic owner.'}
    })),
    references: candidates.references.map(reference => ({
      ...reference, description: 'Restricted synthetic reference', version: null, license,
      instructions: 'Consult the synthetic source separately.'
    }))
  };
}

test('candidates bind original bytes and current sources without including raw logs or native paths', () => {
  const source = sources(), candidates = api.collectExportInputs(repository, source);
  assert.equal(candidates.sourceHash, hash(JSON.stringify(source)));
  assert.equal(candidates.resources.length, 6);
  assert.deepEqual(candidates.resources.filter(resource => resource.mandatory).map(resource => resource.role), ['figure', 'template']);
  assert.deepEqual(candidates.resources.filter(resource => resource.role === 'program').map(resource => resource.source.path), ['run.mts', 'plot.vl.json']);
  assert.ok(candidates.resources.every(resource => resource.source.area !== 'log'));
  assert.deepEqual(api.validateExportPublication(review(candidates), candidates), review(candidates));
  source.experiments[0].files[0].sha256 = hash('changed');
  assert.notEqual(api.collectExportInputs(repository, source).sourceHash, candidates.sourceHash);
});

test('every input output template and reference requires an explicit selection; foreign and duplicate selections fail', () => {
  const candidates = api.collectExportInputs(repository, sources());
  for (let index = 0; index < candidates.resources.length; index++) {
    const selected = review(candidates); selected.resources.splice(index, 1);
    assert.throws(() => api.validateExportPublication(selected, candidates), /research_export_resource_selection_required/u);
  }
  const missing = review(candidates); missing.references = [];
  assert.throws(() => api.validateExportPublication(missing, candidates), /research_export_reference_selection_required/u);
  const foreign = review(candidates); foreign.resources[0].source.id = 'foreign';
  assert.throws(() => api.validateExportPublication(foreign, candidates), /research_export_resource_selection_required/u);
  const duplicate = review(candidates); duplicate.resources[1] = duplicate.resources[0];
  assert.equal(schemas.researchExportPublicationReviewSchema.safeParse(duplicate).success, false);
});

test('restricted figure and template bytes cannot become successful deliveries and source identities cannot drift', () => {
  const candidates = api.collectExportInputs(repository, sources());
  for (const [index, candidate] of candidates.resources.entries()) {
    if (!candidate.mandatory) continue;
    const selected = review(candidates);
    selected.resources[index].delivery = {kind: 'metadata_only', url: null, instructions: 'No redistribution'};
    assert.throws(() => api.validateExportPublication(selected, candidates), /research_export_resource_bundled_required/u);
  }
  for (const mutate of [
    selected => selected.sourceHash = hash('stale'),
    selected => selected.resources[0].source.sha256 = hash('changed'),
    selected => selected.resources[0].source.size++,
    selected => selected.resources[0].kind = 'dataset',
    selected => selected.resources[4].kind = 'result'
  ]) {
    const selected = review(candidates); mutate(selected);
    assert.throws(() => api.validateExportPublication(selected, candidates), /research_export_(sources_changed|resource_changed|program_metadata_required|figure_metadata_required)/u);
  }
});

test('public metadata is required and rejects software without URL/version and private paths instead of filling defaults', () => {
  const candidates = api.collectExportInputs(repository, sources());
  for (const mutate of [
    selected => delete selected.publication.authors,
    selected => delete selected.resources[1].license,
    selected => selected.resources[0].url = null,
    selected => selected.resources[0].version = null,
    selected => selected.resources[1].delivery.instructions = 'Read /Users/private/resource.csv',
    selected => selected.publication.description = 'file:///private/workspace',
    selected => selected.publication.version = '1.1'
  ]) {
    const selected = review(candidates); mutate(selected);
    assert.equal(schemas.researchExportPublicationReviewSchema.safeParse(selected).success, false);
  }
});
