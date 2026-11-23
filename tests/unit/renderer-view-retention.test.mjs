import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

let retainedViewsAfterNavigation, viewHostFor;
before(async () => {
  const result = await build({entryPoints: ['src/renderer/app/view-retention.ts'], bundle: true,
    platform: 'node', format: 'esm', write: false, logLevel: 'silent'});
  ({retainedViewsAfterNavigation, viewHostFor} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`));
});

test('leaving readonly overview releases it while every visited draft/session host remains', () => {
  let retained = ['overview'];
  for (const target of ['writing', 'runs', 'library']) retained = retainedViewsAfterNavigation(retained, target);
  assert.deepEqual(retained, ['writing', 'runs', 'library']);
  assert.deepEqual(retainedViewsAfterNavigation(retained, 'overview'), ['writing', 'runs', 'library', 'overview']);
  assert.deepEqual(retainedViewsAfterNavigation([...retained, 'overview'], 'writing'), retained);
});

test('shared literature destinations replace one host entry without evicting its state owner', () => {
  let retained = ['writing', 'discover'];
  for (const target of ['knowledge', 'library', 'discover']) {
    retained = retainedViewsAfterNavigation(retained, target);
    assert.deepEqual(retained, ['writing', target]);
    assert.deepEqual(retained.map(viewHostFor), ['writing', 'library']);
  }
});

test('repeated navigation retains at most three pinned hosts plus the active readonly host', () => {
  let retained = [];
  for (let index = 0; index < 20; index++) {
    for (const target of ['overview', 'discover', 'writing', 'knowledge', 'runs', 'library']) {
      retained = retainedViewsAfterNavigation(retained, target);
      const hosts = retained.map(viewHostFor);
      assert.equal(new Set(hosts).size, hosts.length);
      assert.ok(hosts.includes(viewHostFor(target)));
      assert.ok(hosts.length <= (target === 'overview' ? 4 : 3));
      assert.equal(hosts.includes('overview'), target === 'overview');
    }
  }
});
