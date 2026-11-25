/** Exercise the real pinned source and wheel transports, retaining only evidence. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';

const {values} = parseArgs({options: {output: {type: 'string'}}, strict: true});
if (!values.output) throw new Error('--output required');
const output = resolve(values.output);
await mkdir(output);
const {ovisDownloadAssets, withOvisDownloads, verifyOvisRequirementsFile} =
  await importTypeScriptModule('src/main/plugins/research/ovis-downloads.ts', {platform: 'node'});
await verifyOvisRequirementsFile(resolve('resources/ovis-ocr/requirements.lock'));
const assets = ovisDownloadAssets().filter(asset => asset.path === 'source/prompts/document_structured.txt' ||
  asset.path.startsWith('wheels/annotated_doc-') || asset.path.startsWith('wheels/mlx_metal-'));
assert.equal(assets.length, 3);
const parent = await mkdtemp('/private/tmp/roc-ovis-network-check-');
const report = {status: 'running', scope: 'Three real immutable downloads, including a native Metal wheel; no installation or quality claim',
  assets, progressEvents: 0, receivedBytes: 0, downloadedFiles: [], ownedDirectoriesRemoved: false,
  sourceSha256: createHash('sha256').update(await readFile('src/main/plugins/research/ovis-downloads.ts')).digest('hex')};
try {
  await withOvisDownloads({parent, assets, signal: AbortSignal.timeout(600000), onProgress: event => {
    report.progressEvents++; report.receivedBytes = event.bytesDone;
  }}, async bundle => {
    for (const asset of bundle.assets) {
      const bytes = await readFile(join(bundle.root, asset.path));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      assert.equal(sha256, asset.sha256);
      report.downloadedFiles.push({path: asset.path, bytes: bytes.length, sha256});
    }
  });
  assert.deepEqual(await readdir(parent), []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1;
} finally {
  await rm(parent, {recursive: true}); report.ownedDirectoriesRemoved = true;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify(report));
}
