import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm, symlink, writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';

let directory, app, page, sourceBytes, sourceHash, largeHash, server, otherServer, rendererOrigin, otherOrigin;
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr07-preview-protocol');
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'roc-document-protocol-')));
  await mkdir(artifacts, {recursive: true});
  sourceBytes = await readFile('tests/fixtures/research-workflow/source.pdf');
  sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  await writeFile(join(directory, 'source.pdf'), sourceBytes);
  const large = Buffer.alloc(20 * 1024 * 1024, 0x71); sourceBytes.copy(large);
  largeHash = createHash('sha256').update(large).digest('hex');
  await writeFile(join(directory, 'large.pdf'), large);
  await symlink(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'));
  server=createServer((_request,response)=>response.end('<html><body>Local development renderer</body></html>'));
  otherServer=createServer((_request,response)=>response.end('<html><body>Other origin</body></html>'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await new Promise(resolve=>otherServer.listen(0,'127.0.0.1',resolve));
  rendererOrigin=`http://127.0.0.1:${server.address().port}`;
  otherOrigin=`http://127.0.0.1:${otherServer.address().port}`;
  await writeFile(join(directory, 'protocol-entry.ts'), `
    export * from ${JSON.stringify(join(process.cwd(), 'src/main/pdf-preview-protocol.ts'))};
    export {documentSourceRequest} from ${JSON.stringify(join(process.cwd(), 'src/main/plugins/research/document-source-request.ts'))};
    export {ResearchDocumentService} from ${JSON.stringify(join(process.cwd(), 'src/main/plugins/research/document-service.ts'))};
  `);
  await build({entryPoints: [join(directory, 'protocol-entry.ts')], outfile: join(directory, 'protocol.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent'});
  await writeFile(join(directory, 'index.html'), '<html><body>Document protocol runtime check</body></html>');
  await writeFile(join(directory, 'main.cjs'), `
    const {app,BrowserWindow,protocol}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'user-data'))});
    global.requests=[];global.refuse=false;
    global.original=Buffer.from(${JSON.stringify(sourceBytes.toString('base64'))},'base64');
    const api=require(${JSON.stringify(join(directory, 'protocol.cjs'))});
    global.protocolRequests=[];global.nativeSourceAborts=0;
    const handle=protocol.handle.bind(protocol);
    protocol.handle=(scheme,callback)=>handle(scheme,request=>{
      global.protocolRequests.push({url:request.url,method:request.method,headers:Array.from(request.headers),referrer:request.referrer,initiatorOrigin:request.initiatorOrigin,mode:request.mode});
      return callback(request);
    });
    api.registerPdfPreviewScheme();
    app.whenReady().then(async()=>{
      const repository={
        getProject(id){if(!['p','project:encoded name'].includes(id)) throw new Error('research_project_not_found');return {id};},
        documents:{
          get(id){
            if(!['d','document:encoded name','large'].includes(id)) throw new Error('research_document_not_found');
            return {id,libraryItemId:'library',mediaType:'application/pdf',filename:id==='large'?'large.pdf':'source.pdf',
              sourceHash:id==='large'?${JSON.stringify(largeHash)}:${JSON.stringify(sourceHash)},
              size:id==='large'?${large.length}:global.original.length};
          },
          sourcePath(id){return id==='large'?'large.pdf':'source.pdf';}
        },
        library:{get(){return {projectIds:['p','project:encoded name']};}}
      };
      global.documentService=new api.ResearchDocumentService(repository,{},${JSON.stringify(directory)});
      api.registerPdfPreviewProtocol(()=>({invokeCapability:async(name,input)=>{
        global.requests.push({name,input});
        if(global.refuse) throw new Error('synthetic capability refusal');
        if(name==='research.document.source'){
          api.documentSourceRequest().signal.addEventListener('abort',()=>global.nativeSourceAborts++,{once:true});
          return global.documentService.sourceResponse(input);
        }
        return Response.json({name,input});
      }}),${JSON.stringify(rendererOrigin)});
      await new BrowserWindow({show:false,width:800,height:600}).loadFile(${JSON.stringify(join(directory, 'index.html'))});
    });
  `);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
});
after(async () => {
  await app?.evaluate(async () => {await global.documentService?.shutdown();});
  await app?.close();
  if(server) await new Promise(resolve=>server.close(resolve));
  if(otherServer) await new Promise(resolve=>otherServer.close(resolve));
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
    seam: 'actual Electron protocol, Chromium fetch and production document service/verified FD store; static authorized repository metadata fixture',
    request: requests.at(-1), status: result.status, type: result.type, sourceHash,
    fetchedHash: createHash('sha256').update(Buffer.from(result.bytes)).digest('hex')
  }, null, 2));
});

test('actual Chromium sends HEAD/Range and receives exact 206/416 metadata from verified descriptors', async () => {
  const url = `roc-preview://research/projects/p/documents/d/source/${sourceHash}`;
  const result = await page.evaluate(async url => {
    const head = await fetch(url, {method: 'HEAD'}), session = head.headers.get('x-roc-preview-session');
    const source = new URL(url); source.searchParams.set('session', session);
    const range = await fetch(source, {headers: {range: 'bytes=0-15'}});
    // Releasing the lease intentionally cancels its streams; finish reading it first.
    const bytes = Array.from(new Uint8Array(await range.arrayBuffer()));
    const invalid = await fetch(source, {headers: {range: 'bytes=0-1,3-4'}});
    source.searchParams.set('release', '1');
    const release = await fetch(source, {method: 'HEAD'});
    source.searchParams.delete('release');
    const expired = await fetch(source, {headers: {range: 'bytes=0-15'}});
    return {head: head.status, size: Number(head.headers.get('content-length')), accept: head.headers.get('accept-ranges'),
      status: range.status, contentRange: range.headers.get('content-range'), bytes,
      invalid: invalid.status, invalidRange: invalid.headers.get('content-range'), release: release.status, expired: expired.status};
  }, url);
  assert.equal(result.head, 200); assert.equal(result.size, sourceBytes.length); assert.equal(result.accept, 'bytes');
  assert.equal(result.status, 206); assert.equal(result.contentRange, `bytes 0-15/${sourceBytes.length}`);
  assert.deepEqual(Buffer.from(result.bytes), sourceBytes.subarray(0, 16));
  assert.equal(result.invalid, 416); assert.equal(result.invalidRange, `bytes */${sourceBytes.length}`);
  assert.equal(result.release, 204); assert.equal(result.expired, 410);
  const requests = await app.evaluate(() => global.protocolRequests);
  assert.ok(requests.some(row => row.method === 'HEAD'));
  assert.ok(requests.some(row => row.headers.some(([name, value]) => name === 'range' && value === 'bytes=0-15')));
});

test('actual Chromium abort interrupts source consumption and releases native streams and descriptors', async () => {
  const before = await app.evaluate(() => global.nativeSourceAborts);
  const result = await page.evaluate(async url => {
    const controller = new AbortController(), response = await fetch(url, {signal: controller.signal});
    const reader = response.body.getReader(), first = await reader.read();
    controller.abort();
    let aborted = false;
    try {await reader.read();} catch (error) {aborted = error.name === 'AbortError';}
    return {aborted, first: first.value.length};
  }, `roc-preview://research/projects/p/documents/large/source/${largeHash}`);
  assert.equal(result.aborted, true); assert.ok(result.first > 0);
  const deadline = Date.now() + 3000;
  let metrics;
  do {
    metrics = await app.evaluate(() => global.documentService.sourceMetrics());
    if (metrics.sessions === 0 && metrics.streams === 0) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.equal(metrics.sessions, 0); assert.equal(metrics.streams, 0); assert.equal(metrics.snapshotBytes, 0);
  await writeFile(join(artifacts, 'native-abort.json'), JSON.stringify({metrics, result,
    nativeRequestSignalAbortEvents: await app.evaluate(() => global.nativeSourceAborts) - before,
    runtime: await app.evaluate(() => ({electron: process.versions.electron, chromium: process.versions.chrome}))}, null, 2));
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

test('configured development renderer can fetch original bytes while another initiator is refused even without a referrer',async()=>{
  await app.evaluate(()=>{global.refuse=false;});
  await page.goto(rendererOrigin);
  const url=`roc-preview://research/projects/p/documents/d/source/${sourceHash}`;
  const response=await page.evaluate(async url=>{
    const response=await fetch(url);
    return {status:response.status,origin:response.headers.get('access-control-allow-origin'),bytes:Array.from(new Uint8Array(await response.arrayBuffer()))};
  },url);
  assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(response.bytes),sourceBytes);
  await page.goto(otherOrigin);
  const before=await app.evaluate(()=>global.requests.length);
  const foreign=await page.evaluate(async url=>(await fetch(url,{referrerPolicy:'no-referrer'})).status,url);
  await writeFile(join(artifacts,'origin-requests.json'),JSON.stringify(await app.evaluate(()=>global.protocolRequests),null,2));
  assert.equal(foreign,403);assert.equal(await app.evaluate(()=>global.requests.length),before);
  assert.equal(response.origin,rendererOrigin);
});

test('opaque iframe cannot invoke preview capabilities while a main-process request can read the original',async()=>{
  await page.goto(rendererOrigin);
  const url=`roc-preview://research/projects/p/documents/d/source/${sourceHash}`;
  const before=await app.evaluate(()=>global.requests.length);
  const opaque=await page.evaluate(url=>new Promise(resolve=>{
    const frame=document.createElement('iframe');
    frame.sandbox='allow-scripts';
    const receive=event=>{
      if(event.source!==frame.contentWindow) return;
      window.removeEventListener('message',receive);frame.remove();resolve(event.data);
    };
    window.addEventListener('message',receive);
    frame.srcdoc=`<script>fetch(${JSON.stringify(url)},{referrerPolicy:'no-referrer'}).then(response=>parent.postMessage(response.status,'*'))<\/script>`;
    document.body.append(frame);
  }),url);
  assert.equal(opaque,403);assert.equal(await app.evaluate(()=>global.requests.length),before);
  const native=await app.evaluate(async({net},url)=>{
    const response=await net.fetch(url);
    return {status:response.status,bytes:Array.from(new Uint8Array(await response.arrayBuffer()))};
  },url);
  assert.equal(native.status,200);assert.deepEqual(Buffer.from(native.bytes),sourceBytes);
});
