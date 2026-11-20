import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {prepareFulltextFixture, runFulltextAcceptance, discoverFulltextElectron, fulltextMarkers, fulltextToolNames} from '../../scripts/verify-agent-literature-fulltext.mjs';

test('synthetic native fulltext acquisition uses actual download, parser, SQLite, indexes and Wiki workers', {timeout: 90_000}, async () => {
  const report = await runFulltextAcceptance({native: true});
  assert.equal(report.transport, process.versions.electron ? 'electron-node' : 'node-direct');
  assert.equal(report.runtime.electron, process.versions.electron ?? null);
  assert.equal(report.checks.length, 7);
  assert.equal(report.automaticWiki, true);
  assert.equal(report.status, 'Verified passing');
  for (const name of [fulltextToolNames.search, fulltextToolNames.add, fulltextToolNames.get, fulltextToolNames.progress]) assert(report.toolCalls.includes(name));
});

test('missing embedding configuration blocks index and resumes without another download or parse', {timeout: 60_000}, async () => {
  const fixture = await prepareFulltextFixture({configureEmbedding: false});
  try {
    await fixture.start();
    const search = await fixture.invoke(fulltextToolNames.search, {query: 'Synthetic secure agents', sources: ['openalex'], limit: 4, maxPages: 1, yearFrom: 2024, yearTo: 2026});
    const candidate = search.candidates.find(item => item.record.doi === '10.5555/roc-fulltext-1');
    assert(candidate);
    const imported = await fixture.invoke(fulltextToolNames.add, {requestId: 'p5-missing-embedding',
      entries: [{kind: 'candidate', searchId: search.searchId, candidateId: candidate.candidateId}]});
    assert.equal(imported.statusScope, 'metadata_import');
    await assert.rejects(fixture.invoke(fulltextToolNames.progress, {projectId: 'forged'}));
    const waitFor = async predicate => {
      const deadline = Date.now() + 25_000;
      let value;
      do {
        const progress = await fixture.invoke(fulltextToolNames.progress, {operationId: imported.acquisitionBatchId});
        value = {...await fixture.invoke('fixture.inspect'), jobs: progress.jobs};
        if (predicate(value)) return value;
        await delay(40);
      } while (Date.now() < deadline);
      assert.fail(`acquisition did not reach expected state: ${JSON.stringify(value.jobs)}`);
    };
    const blocked = await waitFor(value => value.jobs.length === 1 && value.jobs[0].status === 'blocked');
    assert.equal(blocked.jobs[0].stage, 'index');
    assert.equal(blocked.documents[0].document.status, 'ready');
    assert.equal(blocked.documents[0].allLeafVectors, false);
    const parseId = blocked.documents[0].document.currentParseId;
    await fixture.invoke('fixture.enableEmbedding');
    const ready = await waitFor(value => value.documents[0]?.allLeafVectors && ['wiki'].includes(value.jobs[0]?.stage));
    assert.equal(ready.documents[0].document.currentParseId, parseId);
    assert.equal(ready.counters.downloads, 1); assert.equal(ready.counters.parses, 1);
    assert((await fixture.invoke('fixture.searchBody', {marker: fulltextMarkers[0]})).hits.some(hit => hit.content.includes(fulltextMarkers[0])));
    assert.deepEqual(ready.unexpectedRequests, []);
  } finally {
    const root = fixture.root;
    await fixture.close();
    await assert.rejects(access(root), {code: 'ENOENT'});
  }
});

test('Electron preflight never reports a missing package binary as a passed runtime', async () => {
  const result = await discoverFulltextElectron({});
  assert.equal(typeof result.available, 'boolean');
  if (!result.available) assert.equal(result.executablePath, null);
  else await access(result.executablePath);
});
