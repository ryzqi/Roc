import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';

let directory, app, page, sourceBytes, sourceHash;
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr07-preview-protocol');
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-document-protocol-'));
  await mkdir(artifacts, {recursive: true});
  sourceBytes = await readFile('tests/fixtures/research-workflow/source.pdf');
  sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  await build({entryPoints: ['src/main/pdf-preview-protocol.ts'], outfile: join(directory, 'protocol.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent'});
  await writeFile(join(directory, 'index.html'), '<html><body>Document protocol runtime check</body></html>');
  await writeFile(join(directory, 'main.cjs'), `
    const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'user-data'))});
    global.requests=[];global.refuse=false;
    global.original=Buffer.from(${JSON.stringify(sourceBytes.toString('base64'))},'base64');
    const api=require(${JSON.stringify(join(directory, 'protocol.cjs'))});
    api.registerPdfPreviewScheme();
    app.whenReady().then(async()=>{
      api.registerPdfPreviewProtocol(()=>({invokeCapability:async(name,input)=>{
        global.requests.push({name,input});
        if(global.refuse) throw new Error('synthetic capability refusal');
        if(name==='research.document.source') return new Response(new Uint8Array(global.original),{
          headers:{'content-type':'application/pdf','cache-control':'no-store','x-content-type-options':'nosniff'}});
        return Response.json({name,input});
      }}));
      await new BrowserWindow({show:false,width:800,height:600}).loadFile(${JSON.stringify(join(directory, 'index.html'))});
    });
  `);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
});
after(async () => {
  await app?.close();
  if (directory) await rm(directory, {recursive: true, force: true});
});

test('actual Electron protocol serves the frozen original PDF to Chromium with explicit project and hash routing', async () => {
  const projectId = 'project:encoded name', documentId = 'document:encoded name';
  const url = `roc-preview://research/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/source/${sourceHash}`;
  const result = await page.evaluate(async url => {
    const response = await fetch(url);
    return {status: response.status, type: response.headers.get('content-type'), cache: response.headers.get('cache-control'),
      nosniff: response.headers.get('x-content-type-options'), bytes: Array.from(new Uint8Array(await response.arrayBuffer()))};
  }, url);
  assert.equal(result.status, 200); assert.equal(result.type, 'application/pdf');
  assert.equal(result.cache, 'no-store'); assert.equal(result.nosniff, 'nosniff');
  assert.deepEqual(Buffer.from(result.bytes), sourceBytes);
  const requests = await app.evaluate(() => global.requests);
  assert.deepEqual(requests.at(-1), {name: 'research.document.source', input: {projectId, documentId, sourceHash}});
  await writeFile(join(artifacts, 'original-byte-routing.json'), JSON.stringify({
    runtime: await app.evaluate(() => ({electron: process.versions.electron, chromium: process.versions.chrome})),
    seam: 'actual Electron protocol and Chromium fetch; injected capability PDF response; actual repository checked in native P0',
    request: requests.at(-1), status: result.status, type: result.type, sourceHash,
    fetchedHash: createHash('sha256').update(Buffer.from(result.bytes)).digest('hex')
  }, null, 2));
});

test('actual protocol binds exact asset parse identities and drops unscoped document URLs', async () => {
  const digest = 'a'.repeat(64);
  const url = `roc-preview://research/projects/p/documents/d/parses/parse%3Aversion/asset%3Afigure/${digest}.png`;
  const result = await page.evaluate(async url => (await fetch(url)).json(), url);
  assert.deepEqual(result, {name: 'research.document.asset',
    input: {projectId: 'p', documentId: 'd', parseId: 'parse:version', assetId: 'asset:figure', sha256: digest}});
  const before = await app.evaluate(() => global.requests.length);
  for (const path of [`/documents/d/source/${sourceHash}`, `/documents/d/parses/parse/asset/${digest}.png`,
    `/projects/p/documents/d/source/not-a-hash`]) {
    assert.equal(await page.evaluate(async url => (await fetch(url)).status, `roc-preview://research${path}`), 404);
  }
  assert.equal(await app.evaluate(() => global.requests.length), before);
});

test('capability failures become failed protocol responses and never successful PDF bytes', async () => {
  await app.evaluate(() => {global.refuse = true;});
  const result = await page.evaluate(async url => {
    const response = await fetch(url); return {status: response.status, body: await response.text()};
  }, `roc-preview://research/projects/p/documents/d/source/${sourceHash}`);
  assert.equal(result.status, 404); assert.equal(result.body, 'Preview unavailable');
});
