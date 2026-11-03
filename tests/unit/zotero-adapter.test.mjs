import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as esbuild from 'esbuild';

const unusedAttachmentPicker = async () => assert.fail('Native attachment grants are separately verified');

const unusedAttachmentDocuments = {importPrepared: async () => assert.fail('Attachment document imports are separately verified')};

let directory, api;
const timestamp = '2026-11-03T00:00:00.000Z';
const headers = {'Zotero-API-Version': '3', 'Zotero-Server-ID': 'fixture-instance',
  'Zotero-Schema-Version': '40', 'Last-Modified-Version': '9', 'Total-Results': '1'};
const scope = {serverId: 'fixture-instance', library: {kind: 'user', id: 0}};
const page = {...scope, offset: 0, limit: 20, expectedLibraryVersion: null};
const item = {key: 'ABCD2345', version: 8, data: {key: 'ABCD2345', version: 8, itemType: 'journalArticle',
  title: 'Synthetic local paper', DOI: '10.1234/example', tags: [{tag: 'external-tag'}],
  collections: ['COLL2345'], creators: [{creatorType: 'author', name: 'Synthetic Author'}],
  unknownFutureField: {value: 'retained'}}};
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-zotero-adapter-'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  const outfile = join(directory, 'api.mjs');
  await esbuild.build({stdin: {contents: `
    export {ZoteroAdapter} from './src/main/plugins/research/zotero-adapter';
    export {detectZoteroInstallation} from './src/main/plugins/research/zotero-installation';
    export {zoteroCapabilities, registerZoteroCapabilities} from './src/main/plugins/research/zotero-capabilities';
    export {ipcRegistry} from './src/shared/ipc-registry';
  `,
    resolveDir: process.cwd()}, outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent'});
  api = await import(outfile);
});
after(() => rmSync(directory, {recursive: true, force: true}));
function adapter(body = [item], responseHeaders = headers, status = 200) {
  return new api.ZoteroAdapter(async () => new Response(JSON.stringify(body), {status, headers: responseHeaders}), () => timestamp);
}
const input = () => ({...page, collectionKey: null, since: null});
async function server(t, respond) {
  const calls = [];
  const http = createServer((request, response) => {
    calls.push({path: request.url, method: request.method, headers: request.headers});
    respond(request, response);
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    http.closeAllConnections();
    http.close(resolve);
  }));
  const endpoint = `http://127.0.0.1:${http.address().port}`;
  const fetchImpl = (url, init) => {
    const requested = new URL(url);
    assert.equal(requested.origin, 'http://127.0.0.1:23119');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(new Headers(init.headers).has('Authorization'), false);
    assert.equal(new Headers(init.headers).has('Zotero-API-Key'), false);
    return fetch(endpoint + requested.pathname + requested.search, init);
  };
  return {calls, adapter: new api.ZoteroAdapter(fetchImpl, () => timestamp)};
}

test('probe distinguishes supported instance, disabled API, old client and unreachable transport', async () => {
  assert.deepEqual(await adapter().probe(), {status: 'connected', serverId: scope.serverId,
    apiVersion: 3, schemaVersion: 40, checkedAt: timestamp});
  assert.equal((await adapter({}, headers, 403).probe()).status, 'disabled');
  assert.equal((await adapter({}, {...headers, 'Zotero-API-Version': '4'}).probe()).status, 'unsupported');
  const missing = {...headers}; delete missing['Zotero-Server-ID'];
  assert.equal((await adapter({}, missing).probe()).status, 'unsupported');
  assert.equal((await new api.ZoteroAdapter(async () => {throw new TypeError('offline');}).probe()).status, 'unreachable');
  assert.equal((await adapter({}, {...headers, 'Zotero-Schema-Version': 'unknown'}).probe()).status, 'invalid_response');
});

test('actual HTTP pages bind instance, explicit limit and library scope; raw fields and byte hash survive', async t => {
  const body = JSON.stringify([item]);
  const fixture = await server(t, (_request, response) => {
    response.writeHead(200, {...headers, 'Total-Results': '2'});
    response.end(body);
  });
  const result = await fixture.adapter.items({...input(), limit: 1, collectionKey: 'COLL2345', since: 5,
    library: {kind: 'group', id: 42}, expectedLibraryVersion: 9});
  assert.deepEqual(result.records, [item]);
  assert.equal(result.responseHash, createHash('sha256').update(body).digest('hex'));
  assert.equal(result.nextOffset, 1);
  assert.equal(result.libraryVersion, 9);
  assert.deepEqual(result.library, {kind: 'group', id: 42});
  const call = fixture.calls[0];
  const url = new URL(call.path, 'http://127.0.0.1');
  assert.equal(url.pathname, '/api/groups/42/collections/COLL2345/items');
  assert.equal(url.searchParams.get('limit'), '1');
  assert.equal(url.searchParams.get('start'), '0');
  assert.equal(url.searchParams.get('since'), '5');
  assert.equal(call.headers['zotero-server-id'], scope.serverId);
  await fixture.adapter.shutdown();
});

test('group versions stay synced metadata; collections retain parent and local library version', async () => {
  const group = {id: 42, version: 999, data: {id: 42, name: 'Synthetic Group'}};
  const groupHeaders = {...headers}; delete groupHeaders['Last-Modified-Version'];
  const groups = await adapter([group], groupHeaders).groups({serverId: scope.serverId});
  assert.equal(groups.records[0].version, 999);
  assert.equal('libraryVersion' in groups, false);
  const collection = {key: 'COLL2345', version: 7, data: {key: 'COLL2345', version: 7,
    name: 'Synthetic Collection', parentCollection: false}};
  const result = await adapter([collection]).collections(page);
  assert.deepEqual(result.records, [collection]);
  assert.equal(result.libraryVersion, 9);
});

test('instance changes and local version changes reject whole page; no cached fallback', async () => {
  await assert.rejects(adapter([], headers, 412).items(input()), /zotero_server_changed/u);
  await assert.rejects(adapter([item], {...headers, 'Zotero-Server-ID': 'other-instance'}).items(input()), /zotero_server_changed/u);
  await assert.rejects(adapter().items({...input(), expectedLibraryVersion: 10}), /zotero_library_version_changed/u);
  await assert.rejects(adapter([{...item, version: 10, data: {...item.data, version: 10}}]).items(input()), /zotero_response_invalid/u);
});

test('missing counts, incomplete pages, duplicate keys, malformed envelopes and path injection fail before success', async () => {
  const missing = {...headers}; delete missing['Total-Results'];
  await assert.rejects(adapter([item], missing).items(input()), /zotero_response_invalid/u);
  await assert.rejects(adapter([], headers).items(input()), /zotero_page_incomplete/u);
  await assert.rejects(adapter([item, item], {...headers, 'Total-Results': '2'}).items(input()), /zotero_page_duplicate/u);
  await assert.rejects(adapter([{...item, data: {...item.data, key: 'OTHER234'}}]).items(input()), /zotero_response_invalid/u);
  await assert.rejects(adapter().items({...input(), collectionKey: '../file'}));
  await assert.rejects(adapter().items({...input(), library: {kind: 'group', id: 'http://outside'}}));
  const empty = await adapter([], {...headers, 'Total-Results': '0'}).items(input());
  assert.equal(empty.nextOffset, null);
});

test('actual HTTP redirect is not followed, and plain file references never grant filesystem access', async t => {
  const fixture = await server(t, (_request, response) => {
    response.writeHead(302, {...headers, Location: 'http://127.0.0.1:1/outside'});
    response.end();
  });
  await assert.rejects(fixture.adapter.items(input()), /zotero_http_302/u);
  assert.equal(fixture.calls.length, 1);
  const ref = new api.ZoteroAdapter(async () => new Response('file:///tmp/not-created%20reference.pdf', {headers}));
  assert.equal(await ref.attachmentPath(scope, item.key), '/tmp/not-created reference.pdf');
  for (const url of ['https://example.org/file', 'file://other-host/tmp/file', 'file:///tmp/file?query=1']) {
    const invalid = new api.ZoteroAdapter(async () => new Response(url, {headers}));
    await assert.rejects(invalid.attachmentPath(scope, item.key), /zotero_attachment_url_invalid/u);
  }
});

test('caller cancellation and shutdown drain a real pending response and prohibit late reads', async t => {
  let started;
  const received = new Promise(resolve => {started = resolve;});
  const fixture = await server(t, (_request, response) => {
    response.writeHead(200, headers);
    response.write('[');
    started();
  });
  const controller = new AbortController();
  const pending = fixture.adapter.items(input(), controller.signal);
  const refusal = assert.rejects(pending, /zotero_cancelled/u);
  await received;
  controller.abort();
  await refusal;
  await fixture.adapter.shutdown();
  await assert.rejects(fixture.adapter.items(input()), /zotero_closed/u);
  const stopped = adapter();
  await stopped.shutdown();
  await assert.rejects(stopped.probe(), /zotero_closed/u);
});

test('response size cap rejects complete oversized bytes instead of truncating to valid-looking data', async () => {
  const oversized = new api.ZoteroAdapter(async () => new Response('x'.repeat(8 * 1024 * 1024 + 1), {headers}));
  await assert.rejects(oversized.items(input()), /zotero_response_too_large/u);
});

test('shutdown cancels an active HTTP body and waits for its refusal', async t => {
  let started;
  const received = new Promise(resolve => {started = resolve;});
  const fixture = await server(t, (_request, response) => {
    response.writeHead(200, headers);
    response.write('[');
    started();
  });
  const refusal = assert.rejects(fixture.adapter.items(input()), /zotero_cancelled/u);
  await received;
  await fixture.adapter.shutdown();
  await refusal;
  assert.equal(fixture.calls.length, 1);
});

test('registered read-only capability and generated IPC contracts expose actual pages and errors', async () => {
  const handlers = new Map();
  const imports = {previewZotero: () => assert.fail('preview is verified by the owned import fixture'),
    readZoteroPreview: () => assert.fail('preview is verified by the owned import fixture'),
    readZoteroSources: () => assert.fail('source provenance is verified by the import fixture')};
  api.registerZoteroCapabilities({pluginId: 'fixture', capabilities: {register(_owner, descriptor, handler) {
    handlers.set(descriptor.name, handler);
  }}}, adapter(), imports, unusedAttachmentPicker, unusedAttachmentDocuments);
  assert.deepEqual([...handlers.keys()].sort(), ['research.zotero.attachmentGrant', 'research.zotero.attachmentGrantRead',
    'research.zotero.attachmentImport', 'research.zotero.attachmentImportCancel', 'research.zotero.attachmentImportRead',
    'research.zotero.attachmentInspect', 'research.zotero.attachmentRead',
    'research.zotero.collections', 'research.zotero.getPreview',
    'research.zotero.groups', 'research.zotero.items', 'research.zotero.preview', 'research.zotero.probe', 'research.zotero.review',
    'research.zotero.sourceObserve', 'research.zotero.sourceState', 'research.zotero.sources', 'research.zotero.status',
    'research.zotero.syncAcknowledge', 'research.zotero.syncControl', 'research.zotero.syncFind', 'research.zotero.syncPage',
    'research.zotero.syncRead', 'research.zotero.syncReadPage', 'research.zotero.syncStart']);
  assert.equal((await handlers.get('research.zotero.probe')({})).status, 'connected');
  const status = await handlers.get('research.zotero.status')({});
  assert.equal(status.connection.status, 'connected');
  assert.equal(['found', 'not_found'].includes(status.installation.status), true);
  assert.deepEqual((await handlers.get('research.zotero.items')(input())).records, [item]);
  api.registerZoteroCapabilities({pluginId: 'fixture', capabilities: {register(_owner, descriptor, handler) {
    handlers.set(descriptor.name, handler);
  }}}, adapter([], headers, 412), imports, unusedAttachmentPicker, unusedAttachmentDocuments);
  await assert.rejects(handlers.get('research.zotero.items')(input()), error =>
    error.code === 'zotero_server_changed' && error.retryable === false);
  for (const descriptor of api.zoteroCapabilities) {
    assert.equal(api.ipcRegistry.requests.some(entry => entry.capabilityName === descriptor.name), true);
  }
});

test('single object inspection binds instance, exact item and object version, retaining trash and authenticated404', async () => {
  const request = input();
  const scope = {serverId: request.serverId, library: request.library};
  const row = structuredClone(item);
  row.data.deleted = true;
  const calls = [];
  const single = new api.ZoteroAdapter(async (url, init) => {
    calls.push({url, init});
    return Response.json(row, {headers: {...headers, 'Last-Modified-Version': String(row.version)}});
  });
  const observed = await single.inspectObject({serverId: scope.serverId, library: scope.library}, item.key);
  assert.equal(observed.status, 'trashed');
  assert.equal(observed.objectVersion, item.version);
  assert.equal('libraryVersion' in observed, false);
  assert.deepEqual(observed.item, row);
  assert.equal(calls[0].init.method, 'GET');
  assert.match(new URL(calls[0].url).pathname, new RegExp('/items/'+item.key+'$','u'));
  assert.equal(new URL(calls[0].url).searchParams.get('include'), 'data');
  const missing = new api.ZoteroAdapter(async () => new Response('Not found', {status: 404, headers}));
  assert.equal((await missing.inspectObject(scope, item.key)).status, 'not_found');
  const foreign = new api.ZoteroAdapter(async () => new Response('Not found', {status: 404, headers: {...headers, 'Zotero-Server-ID': 'foreign'}}));
  await assert.rejects(foreign.inspectObject(scope, item.key), /zotero_server_changed/u);
  const invalid = new api.ZoteroAdapter(async () => new Response('Not found', {status: 404}));
  await assert.rejects(invalid.inspectObject(scope, item.key), /zotero_api_unsupported/u);
  await assert.rejects(single.inspectObject(scope, '../escape'));
  assert.equal(calls.length, 1);
  const wrongVersion = new api.ZoteroAdapter(async () => Response.json(row, {headers: {...headers, 'Last-Modified-Version': String(row.version+1)}}));
  await assert.rejects(wrongVersion.inspectObject(scope, item.key), /zotero_response_invalid/u);
  await single.shutdown(); await missing.shutdown(); await foreign.shutdown(); await invalid.shutdown(); await wrongVersion.shutdown();
});

test('installation detection checks application executables without inferring state from transport', async () => {
  const system = {location: 'system', path: join(directory, 'system/Zotero.app')};
  const user = {location: 'user', path: join(directory, 'user/Zotero.app')};
  assert.deepEqual(await api.detectZoteroInstallation([system, user]), {status: 'not_found'});
  mkdirSync(join(system.path, 'Contents/MacOS/zotero'), {recursive: true});
  assert.deepEqual(await api.detectZoteroInstallation([system]), {status: 'not_found'});
  mkdirSync(join(user.path, 'Contents/MacOS'), {recursive: true});
  writeFileSync(join(user.path, 'Contents/MacOS/zotero'), 'synthetic executable fixture');
  assert.deepEqual(await api.detectZoteroInstallation([system, user]), {status: 'found', location: 'user'});
  const loop = join(directory, 'loop');
  symlinkSync(loop, loop);
  await assert.rejects(api.detectZoteroInstallation([{location: 'system', path: loop}]), /zotero_installation_unreadable/u);
});
