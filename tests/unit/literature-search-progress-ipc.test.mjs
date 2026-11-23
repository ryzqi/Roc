import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
const built = await build({stdin: {contents: `
  export {registerPluginCapabilityIpc} from './src/main/ipc/plugin-capability-adapter';
  export {literatureContext} from './src/main/services/literature-context';
  export {literatureSearchToolSchema,literatureSearchInputSchema,literatureSearchProgressSchema} from './src/shared/schemas/literature-import';
`, resolveDir: process.cwd(), loader: 'ts'}, bundle: true, platform: 'node', format: 'esm', write: false,
logLevel: 'silent', external: ['electron']});
const {registerPluginCapabilityIpc, literatureContext, literatureSearchToolSchema, literatureSearchInputSchema,
  literatureSearchProgressSchema} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const progress = {requestId: 'same-request', projectId: 'p', completedSources: 1, totalSources: 1,
  source: {source: 'crossref', status: 'empty', returnedCount: 0, errorCode: null, retryAfterMs: null}, records: []};

test('search progress goes only to its invoking sender, even for concurrent requests with the same requestId', async () => {
  const handlers = new Map(), calls = [];
  registerPluginCapabilityIpc((channel, handler) => handlers.set(channel, handler), {
    async invokeCapability(name, input) {
      const context = literatureContext();
      await Promise.resolve();
      calls.push({name, owner: context.owner, projectId: context.projectId, hasProgress: context.onSearchProgress !== undefined});
      context.onSearchProgress?.({...progress, requestId: input.requestId, projectId: context.projectId});
      return {};
    }
  });
  const makeSender = id => ({id, destroyed: false, events: [], isDestroyed() {return this.destroyed;},
    send(channel, value) {this.events.push({channel, value});}});
  const first = makeSender(7), second = makeSender(8);
  const search = handlers.get('roc:research:literature-search');
  await Promise.all([search({sender: first}, {query: 'one', requestId: 'same-request', projectId: 'p-one'}),
    search({sender: second}, {query: 'two', requestId: 'same-request', projectId: 'p-two'})]);
  assert.deepEqual(calls.map(call => [call.owner, call.projectId]), [['window:7', 'p-one'], ['window:8', 'p-two']]);
  assert.deepEqual(first.events.map(event => [event.channel, event.value.projectId]), [['roc:research:literature-search-progress', 'p-one']]);
  assert.deepEqual(second.events.map(event => event.value.projectId), ['p-two']);
  first.destroyed = true;
  await search({sender: first}, {query: 'closed', requestId: 'same-request', projectId: 'p-one'});
  assert.equal(first.events.length, 1);
  await handlers.get('roc:research:literature-read-search')({sender: second}, {searchId: 's', projectId: 'p-two'});
  assert.equal(calls.at(-1).hasProgress, false);
  assert.throws(() => literatureContext(), /literature_execution_context_required/u);
});

test('only the UI input allows bounded pagination and correlation; progress has no importable or owner fields', () => {
  const ui = {query: 'query', pageSize: 30, requestId: 'request'};
  assert.equal(literatureSearchInputSchema.safeParse(ui).success, true);
  assert.equal(literatureSearchToolSchema.safeParse(ui).success, false);
  for (const bad of [{pageSize: 0}, {pageSize: 31}, {requestId: ''}, {requestId: 'x'.repeat(201)}, {owner: 'window:7'}]) {
    assert.equal(literatureSearchInputSchema.safeParse({...ui, ...bad}).success, false);
  }
  assert.equal(literatureSearchProgressSchema.safeParse(progress).success, true);
  for (const bad of [{completedSources: 2}, {searchId: 'fake-search'}, {owner: 'window:7'}, {records: Array(31).fill({})}]) {
    assert.equal(literatureSearchProgressSchema.safeParse({...progress, ...bad}).success, false);
  }
});
