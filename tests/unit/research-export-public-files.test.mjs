import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, realpath, writeFile, readFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const options = {platform: 'node', external: ['zod', 'yazl'], tempDir: join(process.cwd(), '.runtime/tmp')};
const api = await importTypeScriptModule('src/main/plugins/research/export-public-files.ts', options);
const files = await importTypeScriptModule('src/main/plugins/research/export-files.ts', options);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-public-files-')));
  await mkdir(join(root, 'bundle'));
  try {await run(root, new files.ResearchExportFiles(join(root, 'bundle')));}
  finally {await rm(root, {recursive: true, force: true});}
}

test('file projection preserves original byte identity separately from canonical and public JSON hashes', async () => {
  await fixture(async (root, writer) => {
    const value = {verification: 'stored_receipt', workspacePath: '/Users/private/project', result: -2};
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    await writeFile(join(root, 'receipt.json'), bytes);
    const source = {path: 'receipt.json', size: bytes.length, sha256: hash(bytes)};
    await api.writePublicExportFileProjection(writer, root, {...source, area: 'log'}, 'receipt.public.json', 'json');
    const receipt = JSON.parse(await readFile(join(writer.root, 'receipt.public.json'), 'utf8'));
    assert.deepEqual(receipt.originalFile, source);
    assert.equal(receipt.projection.originalSha256, hash(JSON.stringify(value)));
    assert.notEqual(receipt.originalFile.sha256, receipt.projection.originalSha256);
    assert.equal(receipt.projection.projectionSha256, hash(JSON.stringify(receipt.projection.value)));
    assert.deepEqual(receipt.projection.value, {verification: 'private_source_receipt', result: -2});
    assert.equal(JSON.stringify(receipt).includes('/Users/private'), false);
    assert.equal(receipt.projection.omittedFields.find(field => field.pointer === '/verification').reason, 'verification_claim');
    await writeFile(join(root, 'receipt.json'), bytes.toString().replace('-2', '-3'));
    await assert.rejects(api.writePublicExportFileProjection(writer, root, source, 'changed.public.json', 'json'),
      /research_export_snapshot_changed/u);
    assert.equal(writer.list().length, 1);
  });
});

test('log projection declares private text omission and refuses malformed encoding or JSON', async () => {
  await fixture(async (root, writer) => {
    for (const [path, bytes, encoding] of [
      ['log.txt', Buffer.from('Working directory /Users/private/project'), 'text'],
      ['invalid.json', Buffer.from('{'), 'json'],
      ['invalid-utf8.txt', Buffer.from([0xff, 0xfe]), 'text']
    ]) {
      await writeFile(join(root, path), bytes);
      const source = {path, size: bytes.length, sha256: hash(bytes)};
      if (path !== 'log.txt') {
        await assert.rejects(api.writePublicExportFileProjection(writer, root, source, `${path}.public.json`, encoding));
      } else {
        await api.writePublicExportFileProjection(writer, root, source, `${path}.public.json`, encoding);
        const receipt = JSON.parse(await readFile(join(writer.root, `${path}.public.json`), 'utf8'));
        assert.equal(receipt.projection.value, null);
        assert.equal(receipt.projection.omittedFields[0].reason, 'native_path');
        assert.equal(receipt.originalFile.sha256, hash(bytes));
      }
    }
    assert.equal(writer.list().length, 1);
  });
});

test('original binary bytes remain unchanged and recognized private original text refuses delivery', async () => {
  await fixture(async (root, writer) => {
    const binary = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0, 0x0a]),
      Buffer.from('=/3'), Buffer.from([0xff]), Buffer.from('/'), Buffer.from([0xfe])]);
    await writeFile(join(root, 'plot.png'), binary);
    await api.copyPublicExportFile(writer, root, {path: 'plot.png', size: binary.length, sha256: hash(binary)}, 'plot.png');
    assert.deepEqual(await readFile(join(writer.root, 'plot.png')), binary);
    for (const [path, text] of [['private.csv', 'Read /Users/private/study.csv'], ['private.mts', 'authorization: Bearer fixture-token']]) {
      await writeFile(join(root, path), text);
      await assert.rejects(api.copyPublicExportFile(writer, root,
        {path, size: Buffer.byteLength(text), sha256: hash(text)}, path), /research_export_private_file/u);
    }
    assert.equal(writer.list().length, 1);
  });
});
