import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api;
before(async () => {api = await importTypeScriptModule('scripts/research/download-asset.ts', {platform: 'node'});});
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
async function scene(handler) {
  const root = await mkdtemp('/private/tmp/roc-download-lifecycle-');
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {root, target: join(root, 'asset'), url: `http://127.0.0.1:${server.address().port}/asset`,
    close: async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, {recursive: true, force: true});}};
}

test('a failed range joins every worker before the caller can clean its files', async () => {
  const waiting = deferred(), first = deferred(), second = deferred();
  let delays = 0;
  const f = await scene((request, response) => {
    const range = request.headers.range.replace('=', ' ');
    response.writeHead(206, {'Content-Range': `${range}/2`}); response.end();
  });
  let settled = false;
  try {
    const result = api.downloadRanges({url: f.url, size: 2, etag: null}, f.target, {chunkSize: 1, workers: 2, attempts: 2,
      delay: () => {const gate = ++delays === 1 ? first : second; if (delays === 2) waiting.resolve(); return gate.promise;}
    }).then(() => {settled = true; return null;}, error => {settled = true; return error;});
    await waiting.promise;
    first.resolve();
    // Let the first worker exhaust its attempts while the second still owns work.
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(settled, false, 'returned with a pending download worker');
    second.resolve();
    assert.match((await result).message, /research_download_chunk_incomplete/);
  } finally {first.resolve(); second.resolve(); await f.close();}
});

test('verified downloads report bounded byte progress and cancellation never assembles a target', async () => {
  const content = Buffer.from('an independently hashed download');
  const f = await scene((request, response) => {
    const [,start,end] = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range);
    response.writeHead(206, {'Content-Range': `bytes ${start}-${end}/${content.length}`});
    response.end(content.subarray(Number(start), Number(end) + 1));
  });
  try {
    const progress = [];
    await api.downloadVerified(f.url, createHash('sha256').update(content).digest('hex'), f.target,
      {expectedSize: content.length, onProgress: value => progress.push(value)});
    assert.deepEqual(await readFile(f.target), content);
    assert.deepEqual(progress.at(-1), {bytesDone: content.length, bytesTotal: content.length});
    assert.ok(progress.every((p,i) => p.bytesDone <= content.length && (!i || p.bytesDone >= progress[i - 1].bytesDone)));
    const controller = new AbortController(), cancelled = join(f.root, 'cancelled');
    await assert.rejects(api.downloadRanges({url: f.url, size: content.length, etag: null}, cancelled,
      {signal: controller.signal, chunkSize: 4, workers: 2, onProgress: () => controller.abort()}), /research_download_cancelled/);
    await nextTurn();
    await assert.rejects(readFile(cancelled), {code: 'ENOENT'});
  } finally {await f.close();}
});
