import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {researchCrateFixture as fixture} from '../fixtures/research-ro-crate.mjs';

const options = {platform: 'node', external: ['zod'], tempDir: join(process.cwd(), '.runtime/tmp')};
const api = await importTypeScriptModule('src/main/plugins/research/export-ro-crate.ts', options);
const schemas = await importTypeScriptModule('src/shared/schemas/research-ro-crate.ts', options);
const researchCrateFixture = () => fixture(api.researchCrateProfileHtml);
const clone = value => structuredClone(value);

test('RO-Crate 1.2 graph preserves registered UTF-8 files, source relations, real fields without financial metadata', () => {
  const {input} = researchCrateFixture(), crate = api.buildResearchCrate(input);
  const serialized = api.serializeResearchCrate(crate);
  assert.deepEqual(api.validateResearchCrate(JSON.parse(serialized), input.files), crate);
  assert.deepEqual(crate['@context'], ['https://w3id.org/ro/crate/1.2/context', {roc: 'urn:roc:research:'}]);
  const data = crate['@graph'].find(node => node.name === 'data/混合 sample.csv');
  assert.equal(data['@id'], 'data/%E6%B7%B7%E5%90%88%20sample.csv');
  assert.equal(data.sha256, input.files[1].sha256);
  assert.deepEqual(crate['@graph'].find(node => node['@id'] === 'ro-crate-profile.html')['@type'], ['File', 'CreativeWork', 'Profile']);
  assert.deepEqual(crate['@graph'].find(node => node['@id'] === 'code/run.py')['@type'], ['File', 'SoftwareSourceCode']);
  assert.ok(crate['@graph'].some(node => node.propertyID === 'random seed' && node.value === 42));
  assert.equal(JSON.stringify(crate).includes('cost unknown'), false);
  assert.equal(api.serializeResearchCrate(api.buildResearchCrate(input)), serialized);
});

test('strict public input requires manuscript, author, license, version and approval instead of filling defaults', () => {
  const {input} = researchCrateFixture();
  for (const mutate of [
    value => value.publication.authors = [], value => delete value.publication.license,
    value => value.publication.version = '1.1', value => value.publication.profile = 'legacy',
    value => value.publication.datePublished = '2026-02-30',
    value => value.works = value.works.filter(work => work.kind !== 'manuscript'),
    value => value.approvals = [], value => value.approvals[0].workId = 'missing',
    value => value.works[2].url = null, value => value.works[2].version = null,
    value => value.files = value.files.filter(file => file.path !== 'ro-crate-profile.html')
  ]) {
    const damaged = clone(input); mutate(damaged);
    assert.equal(schemas.researchCrateInputSchema.safeParse(damaged).success, false);
  }
});

test('private paths, credentials, signed locations and unknown fields fail before serialization', () => {
  const {input} = researchCrateFixture();
  for (const mutate of [
    value => value.publication.description = 'Source: /Users/private/project',
    value => value.publication.description = 'file:///private/tmp/project',
    value => value.activities[0].parameters[0].value = 'api_key=secret-value',
    value => value.works[3].delivery.url = 'https://person:password@example.org/article',
    value => value.works[3].delivery.url = 'https://example.org/article?access_token=private',
    value => value.works[3].delivery.url = 'file:///Users/private/article',
    value => value.activities[0].parameters[0].name = 'access_token',
    value => value.activities[0].environment.executable = '/usr/bin/python',
    value => value.publication.workspacePath = '/Users/private/project'
  ]) {
    const damaged = clone(input); mutate(damaged);
    assert.throws(() => api.buildResearchCrate(damaged));
  }
});

test('metadata-only works keep acquisition instructions and cannot smuggle bundled bytes', () => {
  const {input} = researchCrateFixture(), crate = api.buildResearchCrate(input);
  const reference = crate['@graph'].find(node => node['@id'] === '#work-restricted-reference');
  assert.equal(reference['roc:delivery'], 'metadata_only');
  assert.equal(reference.encoding, undefined);
  assert.equal(reference['roc:acquisition'], input.works[3].delivery.instructions);
  reference.encoding = [{'@id': 'paper.pdf'}];
  assert.throws(() => api.validateResearchCrate(crate, input.files), /research_crate_delivery_invalid/u);
  const changed = clone(input); changed.works[3].delivery.paths = ['paper.pdf'];
  assert.throws(() => api.buildResearchCrate(changed));
});

test('closure rejects missing and duplicate files, missing dependencies and unattached entities', () => {
  const {input} = researchCrateFixture();
  const extra = {...input.files[0], path: 'unregistered.pdf'};
  assert.throws(() => api.validateResearchCrate(api.buildResearchCrate(input), [...input.files, extra]), /research_crate_file_missing/u);
  for (const mutate of [
    value => value.files.push(value.files[0]), value => value.works.push(value.works[0]),
    value => value.files.push({...value.files[0], path: 'PAPER.pdf'}),
    value => value.works[0].basedOn.push('missing'), value => value.activities[0].software = 'missing',
    value => value.works[0].delivery.paths.push('missing.pdf')
  ]) {
    const damaged = clone(input); mutate(damaged); assert.throws(() => api.buildResearchCrate(damaged));
  }
  const crate = api.buildResearchCrate(input);
  crate['@graph'].push({'@id': '#unattached', '@type': 'CreativeWork', name: 'Unattached'});
  assert.throws(() => api.validateResearchCrate(crate, input.files), /research_crate_unreachable_entity/u);
  crate['@graph'].pop();
  crate['@graph'].find(node => node['@id'] === '#work-paper').isBasedOn = [{'@id': '#missing'}];
  assert.throws(() => api.validateResearchCrate(crate, input.files), /research_crate_reference_missing/u);
  const colliding = clone(input);
  colliding.works.push({...colliding.works[1], id: 'paper-license'});
  assert.throws(() => api.buildResearchCrate(colliding), /research_crate_duplicate_entity/u);
});

test('profile validation independently refuses absent approvals, roots, license metadata and altered versions', () => {
  const {input} = researchCrateFixture();
  for (const mutate of [
    crate => crate['@context'][0] = 'https://w3id.org/ro/crate/1.1/context',
    crate => delete crate['@graph'].find(node => node['@id'] === './').datePublished,
    crate => crate['@graph'].find(node => node['@id'] === 'ro-crate-profile.html').version = '2',
    crate => delete crate['@graph'].find(node => node['@id'] === '#license').description,
    crate => delete crate['@graph'].find(node => node['@id'] === '#approval-0')['roc:artifactVersion'],
    crate => delete crate['@graph'].find(node => node['@id'] === '#work-software').url,
    crate => crate['@graph'].find(node => node['@id'] === 'manifest.json').sha256 = input.files[0].sha256
  ]) {
    const crate = api.buildResearchCrate(input); mutate(crate); assert.throws(() => api.validateResearchCrate(crate, input.files));
  }
});

test('manifest seals metadata after payload while crate never embeds the manifest or its own digest', () => {
  const {input, hash} = researchCrateFixture(), crate = api.buildResearchCrate(input);
  const bytes = Buffer.from(api.serializeResearchCrate(crate));
  const manifest = [...input.files, {path: 'ro-crate-metadata.json', size: bytes.length, sha256: hash(bytes)}];
  assert.deepEqual(api.validateResearchCrate(crate, manifest), crate);
  assert.equal(crate['@graph'].find(node => node['@id'] === 'manifest.json').sha256, undefined);
  assert.equal(crate['@graph'].find(node => node['@id'] === 'ro-crate-metadata.json').sha256, undefined);
  const damaged = clone(input); damaged.files.push(manifest.at(-1));
  assert.throws(() => api.buildResearchCrate(damaged), /research_crate_generation_order/u);
});

test('closure traverses deep source chains within the declared entity limit without recursive stack overflow', () => {
  const {input} = researchCrateFixture();
  for (let index = 0; index < 3000; index++) {
    input.works.push({...input.works[1], id: `chain-${index}`,
      basedOn: index === 2999 ? [] : [`chain-${index + 1}`]});
  }
  input.works[0].basedOn.push('chain-0');
  const crate = api.buildResearchCrate(input);
  assert.equal(api.validateResearchCrate(crate, input.files)['@graph'].length, crate['@graph'].length);
});

test('offline byte verification reads real files and refuses same-size changes, missing bytes, symlinks and cancellation', async () => {
  const {input, bytes, hash} = researchCrateFixture(), crate = api.buildResearchCrate(input);
  const metadata = Buffer.from(api.serializeResearchCrate(crate));
  const inventory = [...input.files, {path: 'ro-crate-metadata.json', sha256: hash(metadata), size: metadata.length}];
  bytes.set('ro-crate-metadata.json', metadata);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-crate-bytes-')));
  try {
    for (const [path, content] of bytes) {await mkdir(dirname(join(root, path)), {recursive: true}); await writeFile(join(root, path), content);}
    await api.verifyResearchCrateFiles(root, crate, inventory, new AbortController().signal);
    await assert.rejects(api.verifyResearchCrateFiles(root, crate, input.files, new AbortController().signal), /research_crate_metadata_missing/u);
    await assert.rejects(api.verifyResearchCrateFiles(root, crate, [...inventory, inventory.at(-1)],
      new AbortController().signal), /research_crate_duplicate_entity/u);
    const changed = clone(crate); changed['@graph'].find(node => node['@id'] === './').name = 'Altered public title';
    const changedBytes = Buffer.from(api.serializeResearchCrate(changed));
    await writeFile(join(root, 'ro-crate-metadata.json'), changedBytes);
    const changedInventory = inventory.map(file => file.path === 'ro-crate-metadata.json' ?
      {...file, sha256: hash(changedBytes), size: changedBytes.length} : file);
    await assert.rejects(api.verifyResearchCrateFiles(root, crate, changedInventory,
      new AbortController().signal), /research_crate_metadata_changed/u);
    await writeFile(join(root, 'ro-crate-metadata.json'), metadata);
    const paper = bytes.get('paper.pdf'); await writeFile(join(root, 'paper.pdf'), Buffer.alloc(paper.length));
    await assert.rejects(api.verifyResearchCrateFiles(root, crate, inventory, new AbortController().signal), /research_crate_file_changed/u);
    await rm(join(root, 'paper.pdf'));
    await assert.rejects(api.verifyResearchCrateFiles(root, crate, inventory, new AbortController().signal), /ENOENT/u);
    await symlink(join(root, 'code/run.py'), join(root, 'paper.pdf'));
    await assert.rejects(api.verifyResearchCrateFiles(root, crate, inventory, new AbortController().signal), /symlink/u);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(api.verifyResearchCrateFiles(root, crate, inventory, abort.signal), error => error.name === 'AbortError');
  } finally {await rm(root, {recursive: true, force: true});}
});
