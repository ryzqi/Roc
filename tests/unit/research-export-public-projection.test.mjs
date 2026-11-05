import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const options = {platform: 'node', external: ['zod'], tempDir: join(process.cwd(), '.runtime/tmp')};
const api = await importTypeScriptModule('src/main/plugins/research/export-public-projection.ts', options);
const schemas = await importTypeScriptModule('src/shared/schemas/research-public-projection.ts', options);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('public projection retains scientific values, source identities and histories while declaring native omissions', () => {
  const source = {project: {id: 'project-1', workspacePath: '/Users/person/study'},
    experiment: {id: 'run-1', workspaceRoot: '/private/tmp/study', environment: {
      executable: '/usr/bin/python3', prefix: '/opt/python', basePrefix: '/opt/python',
      hash: 'a'.repeat(64), version: 'CPython 3.14.7', packages: [{name: 'test', version: null}]}},
    receipt: {verification: 'stored_receipt', snapshotHash: 'b'.repeat(64), result: -4, unit: 'seconds'},
    seed: 42, cost: {kind: 'unknown', reason: 'No trusted price receipt'}, history: [{version: 1}, {version: 2}]};
  const before = structuredClone(source);
  const publicReceipt = api.projectResearchPublicValue(source);
  assert.deepEqual(source, before);
  assert.equal(publicReceipt.verification, 'public_projection');
  assert.equal(publicReceipt.originalSha256, hash(source));
  assert.equal(publicReceipt.projectionSha256, hash(publicReceipt.value));
  assert.notEqual(publicReceipt.originalSha256, publicReceipt.projectionSha256);
  assert.deepEqual(publicReceipt.value.receipt, {...source.receipt, verification: 'private_source_receipt'});
  assert.deepEqual(publicReceipt.value.history, source.history);
  assert.equal(publicReceipt.value.seed, 42);
  assert.deepEqual(publicReceipt.value.cost, source.cost);
  assert.equal(publicReceipt.value.experiment.environment.version, 'CPython 3.14.7');
  assert.equal(publicReceipt.value.project.workspacePath, undefined);
  assert.equal(publicReceipt.value.experiment.environment.executable, undefined);
  assert.deepEqual(publicReceipt.omittedFields.map(field => field.pointer),
    ['/project/workspacePath', '/experiment/workspaceRoot', '/experiment/environment/executable',
      '/experiment/environment/prefix', '/experiment/environment/basePrefix', '/receipt/verification']);
  assert.deepEqual(publicReceipt.omittedFields.at(-1), {pointer: '/receipt/verification', reason: 'verification_claim'});
  assert.deepEqual(api.validateResearchPublicProjection(publicReceipt), publicReceipt);
  assert.equal(api.serializeResearchPublicProjection(source), `${JSON.stringify(publicReceipt)}\n`);
});

test('private values in arbitrary excerpts, parameters, keys and credential URLs are explicitly omitted', () => {
  const source = JSON.parse(`{"api_key":"synthetic-secret","parameters":{"path":"Read /data/private/source.csv",
    "argument":"file:///Volumes/private/data","windows":"C:\\\\private\\\\source.csv"},
    "excerpt":"authorization: Bearer synthetic-secret","url":"https://example.org/data?token=private",
    "authUrl":"https://person:synthetic-secret@example.org/data","privateKey":{"/Users/private/name":"secret"},
    "allowedUrl":"https://example.org/public","allowedPath":"input/data.csv"}`);
  const receipt = api.projectResearchPublicValue(source);
  const serialized = JSON.stringify(receipt);
  for (const privateText of ['synthetic-secret', '/data/private', '/Volumes/private', 'C:\\\\private', '/Users/private',
    'token=private', 'person:']) assert.equal(serialized.includes(privateText), false, privateText);
  assert.equal(receipt.value.parameters.path, null);
  assert.equal(receipt.value.excerpt, null);
  assert.equal(receipt.value.api_key, undefined);
  assert.equal(receipt.value.allowedUrl, source.allowedUrl);
  assert.equal(receipt.value.allowedPath, source.allowedPath);
  assert.ok(receipt.omittedFields.some(field => field.reason === 'credential'));
  assert.ok(receipt.omittedFields.some(field => field.reason === 'private_url'));
  assert.ok(receipt.omittedFields.some(field => field.reason === 'private_key'));
});

test('changing only private source still changes original provenance and invalidates the complete public seal', () => {
  const first = {workspacePath: '/Users/first/project', result: 2};
  const second = {...first, workspacePath: '/Users/second/project'};
  const a = api.projectResearchPublicValue(first), b = api.projectResearchPublicValue(second);
  assert.equal(a.projectionSha256, b.projectionSha256);
  assert.notEqual(a.originalSha256, b.originalSha256);
  assert.notEqual(api.serializeResearchPublicProjection(first), api.serializeResearchPublicProjection(second));
});

test('public projection validator rejects altered public bytes, undeclared private values and old raw receipts', () => {
  const receipt = api.projectResearchPublicValue({metric: -4, unit: 's'});
  const changed = structuredClone(receipt); changed.value.metric = 4;
  assert.throws(() => api.validateResearchPublicProjection(changed), /research_export_projection_changed/u);
  changed.projectionSha256 = hash(changed.value);
  changed.value.executable = '/usr/bin/python';
  changed.projectionSha256 = hash(changed.value);
  assert.throws(() => api.validateResearchPublicProjection(changed), /research_export_private_metadata/u);
  for (const bad of [{metric: -4}, {...receipt, schemaVersion: 0}, {...receipt, unknown: true},
    {...receipt, omittedFields: undefined}, {...receipt, originalSha256: undefined}]) {
    assert.equal(schemas.researchPublicProjectionSchema.safeParse(bad).success, false);
  }
  assert.throws(() => api.projectResearchPublicValue({unknown: undefined}));
  assert.throws(() => api.projectResearchPublicValue(JSON.parse('{"__proto__":{"metric":3}}')),
    /research_export_projection_invalid/u);
});
