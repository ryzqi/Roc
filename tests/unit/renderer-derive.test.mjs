import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

/**
 * Unit tests for the P5 derived projections (`derive-wiki.ts`, `derive-graph.ts`).
 *
 * Gate 5 of P5 is "given the same input the output is stable" and gate 4 is "no
 * data means an empty state, never sample data". Both are only true if these are
 * pure functions, so these tests are the actual acceptance mechanism:
 *
 *   - **stability**: the same input object produces deep-equal output, and node /
 *     page / edge order is a function of the input order (not of a `Map`'s or a
 *     `Set`'s iteration order, which is why the implementations sort explicitly);
 *   - **emptiness**: `{claims: [], evidence: [], libraryItems: []}` produces no
 *     nodes, no pages and no edges — the legacy views rendered mocks in this case.
 */

let wiki;
let graph;

before(async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'roc-derive-'));
  const build = async (entry, name) => {
    const outfile = join(tempDir, name);
    await esbuild.build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'node22',
      logLevel: 'silent'
    });
    return await import(outfile);
  };
  wiki = await build('src/renderer/literature/derive-wiki.ts', 'wiki.mjs');
  graph = await build('src/renderer/literature/derive-graph.ts', 'graph.mjs');
  rmSync(tempDir, { recursive: true, force: true });
});

function evidenceRecord(overrides) {
  return {
    id: 'ev-1',
    projectId: 'p1',
    documentId: 'doc-1',
    chunkId: 'chunk-1',
    sourceType: 'literature',
    sourceId: 'lib-1',
    sourceVersion: 'v1',
    title: 'Evidence title',
    locator: 'section 1',
    excerpt: 'An excerpt.',
    contentHash: 'hash-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function claimRecord(overrides) {
  return {
    id: 'cl-1',
    projectId: 'p1',
    artifactId: 'art-1',
    subjectType: 'claim',
    content: '注意力机制在长序列上优于循环网络。',
    status: 'supported',
    evidenceIds: ['ev-1'],
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function libraryItem(id, title, year) {
  const metadata = {
    id: `lit-${id}`,
    source: 'local',
    externalId: id,
    doi: null,
    title,
    authors: ['A. Author'],
    abstract: null,
    publishedYear: year,
    citationCount: null,
    url: null,
    openAccessUrl: null,
    importedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
  return {
    id,
    metadata,
    bibliography: {
      citationKey: id,
      entryType: 'article',
      fields: {},
      preambles: [],
      csl: null,
      title,
      authors: ['A. Author'],
      doi: null,
      publishedYear: year,
      abstract: null,
      url: null
    },
    sources: [],
    projectIds: ['p1'],
    revision: 1,
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

test('empty input produces an empty projection, never sample data', () => {
  const empty = { claims: [], evidence: [], libraryItems: [] };
  const wikiProjection = wiki.deriveWiki(empty);
  assert.deepEqual(wikiProjection.pages, []);
  assert.deepEqual(wikiProjection.timeline, []);
  assert.deepEqual(wikiProjection.backlinks, []);
  assert.deepEqual(wikiProjection.orphanEvidence, []);

  const graphProjection = graph.deriveGraph(empty);
  assert.deepEqual(graphProjection.nodes, []);
  assert.deepEqual(graphProjection.links, []);
  assert.deepEqual(graphProjection.kinds, []);
});

test('deriveWiki is stable for the same input and independent of Map order', () => {
  const input = {
    claims: [
      claimRecord({ id: 'cl-a', content: 'A 主张。', evidenceIds: ['ev-1', 'ev-2'] }),
      claimRecord({ id: 'cl-b', content: 'B 主张。', evidenceIds: ['ev-2'] })
    ],
    evidence: [
      evidenceRecord({ id: 'ev-1', title: 'One', sourceId: 'lib-1' }),
      evidenceRecord({ id: 'ev-2', title: 'Two', sourceId: 'lib-2', chunkId: 'chunk-2' })
    ],
    libraryItems: [libraryItem('lib-1', 'Paper one', 2017), libraryItem('lib-2', 'Paper two', 2020)]
  };
  assert.deepEqual(wiki.deriveWiki(input), wiki.deriveWiki(input));

  const projection = wiki.deriveWiki(input);
  assert.equal(projection.pages.length, 2);
  assert.deepEqual(
    projection.pages.map((page) => page.claimId),
    ['cl-a', 'cl-b'],
    'page order follows the claims order'
  );
  // ev-2 is shared by both claims → exactly one undirected backlink.
  assert.deepEqual(
    projection.backlinks.map((link) => `${link.fromClaimId}->${link.toClaimId}:${link.sharedEvidenceIds.join('|')}`),
    ['cl-a->cl-b:ev-2']
  );
  assert.deepEqual(
    projection.timeline.map((entry) => entry.year),
    [2017, 2020]
  );
  assert.deepEqual(projection.timeline[0].claimIds, ['cl-a']);
  assert.deepEqual(projection.timeline[1].claimIds, ['cl-b']);
});

test('deriveWiki types each page only from real relations', () => {
  const projection = wiki.deriveWiki({
    claims: [claimRecord({ evidenceIds: ['ev-1', 'ev-missing'] })],
    evidence: [evidenceRecord({})],
    libraryItems: [libraryItem('lib-1', 'Paper one', 2017)]
  });
  const page = projection.pages[0];
  assert.equal(page.evidence.length, 1);
  assert.equal(page.hasMissingEvidence, true, 'a cited-but-absent evidence id must be flagged, not invented');
  assert.deepEqual(page.papers, [{ libraryItemId: 'lib-1', title: 'Paper one', year: 2017 }]);
  // The year comes from the paper, never from the claim's timestamps.
  assert.deepEqual(projection.timeline, [{ year: 2017, claimIds: ['cl-1'] }]);
});

test('deriveWiki leaves evidence no claim references in the orphan bucket', () => {
  const projection = wiki.deriveWiki({
    claims: [claimRecord({ evidenceIds: ['ev-1'] })],
    evidence: [evidenceRecord({ id: 'ev-1' }), evidenceRecord({ id: 'ev-9', title: 'Unused' })],
    libraryItems: []
  });
  assert.deepEqual(
    projection.orphanEvidence.map((card) => card.id),
    ['ev-9']
  );
});

test('conceptTitle collapses whitespace and truncates honestly', () => {
  assert.equal(wiki.conceptTitle('  A   long\n\ntitle  '), 'A long title');
  assert.equal(wiki.conceptTitle(''), '（无内容主张）');
  assert.equal(wiki.conceptTitle('   '), '（无内容主张）');
  const long = wiki.conceptTitle('x'.repeat(80), 20);
  assert.equal(long.length, 20);
  assert.equal(long.endsWith('…'), true);
});

test('deriveGraph emits only relation-bearing edges', () => {
  const projection = graph.deriveGraph({
    claims: [claimRecord({ id: 'cl-a', evidenceIds: ['ev-1'] }), claimRecord({ id: 'cl-b', evidenceIds: ['ev-1'] })],
    evidence: [evidenceRecord({ id: 'ev-1', sourceId: 'lib-1' })],
    libraryItems: [libraryItem('lib-1', 'Paper one', 2017)]
  });
  assert.deepEqual(
    projection.nodes.map((node) => node.id).sort(),
    ['claim:cl-a', 'claim:cl-b', 'evidence:ev-1', 'paper:lib-1']
  );
  assert.deepEqual(
    projection.links.map((link) => link.kind).sort(),
    ['cites', 'cites', 'sourced-from']
  );
  assert.deepEqual(projection.kinds, ['paper', 'evidence', 'claim']);

  // Stability: identical input → identical output, including edge order.
  const again = graph.deriveGraph({
    claims: [claimRecord({ id: 'cl-a', evidenceIds: ['ev-1'] }), claimRecord({ id: 'cl-b', evidenceIds: ['ev-1'] })],
    evidence: [evidenceRecord({ id: 'ev-1', sourceId: 'lib-1' })],
    libraryItems: [libraryItem('lib-1', 'Paper one', 2017)]
  });
  assert.deepEqual(projection, again);
});

test('deriveGraph drops links whose evidence or paper is not loaded', () => {
  const projection = graph.deriveGraph({
    claims: [claimRecord({ evidenceIds: ['ev-missing'] })],
    evidence: [],
    libraryItems: []
  });
  assert.deepEqual(
    projection.nodes.map((node) => node.id),
    ['claim:cl-1']
  );
  assert.deepEqual(projection.links, [], 'a dangling claim→evidence edge must not be emitted');
});

test('deriveGraph attaches workspace-file evidence to the indexed file', () => {
  const projection = graph.deriveGraph({
    claims: [],
    evidence: [evidenceRecord({ id: 'ev-2', sourceType: 'file', sourceId: 'file-1' })],
    libraryItems: [],
    indexedFiles: [
      {
        id: 'file-1',
        projectId: 'p1',
        path: 'notes/a.md',
        kind: 'markdown',
        size: 10,
        status: 'ready',
        sourceHash: null,
        indexedHash: null,
        textIndexed: true,
        error: null,
        activeJobId: null,
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]
  });
  assert.deepEqual(
    projection.nodes.map((node) => node.kind),
    ['file', 'evidence']
  );
  assert.deepEqual(
    projection.links.map((link) => link.kind),
    ['sourced-from']
  );
});

test('graphNeighbors returns only connected nodes', () => {
  const projection = graph.deriveGraph({
    claims: [claimRecord({ id: 'cl-a', evidenceIds: ['ev-1'] }), claimRecord({ id: 'cl-b', evidenceIds: [] })],
    evidence: [evidenceRecord({ id: 'ev-1', sourceId: 'lib-1' })],
    libraryItems: [libraryItem('lib-1', 'Paper one', 2017)]
  });
  assert.deepEqual(
    graph.graphNeighbors(projection, { nodeId: 'evidence:ev-1', offset: 0, limit: 50 }).nodes.map((node) => node.id).sort(),
    ['claim:cl-a', 'paper:lib-1']
  );
  assert.deepEqual(graph.graphNeighbors(projection, { nodeId: 'claim:cl-b', offset: 0, limit: 50 }), { nodes: [], total: 0 });
});

test('shared-evidence neighbors deduplicate loaded relations and page in projection order', () => {
  const projection = graph.deriveGraph({
    claims: [
      claimRecord({ id: 'a', evidenceIds: ['ev-2', 'ev-1', 'ev-1', 'absent'] }),
      claimRecord({ id: 'b', evidenceIds: ['ev-1', 'ev-2'] }),
      claimRecord({ id: 'c', evidenceIds: ['ev-2'] }),
      claimRecord({ id: 'd', evidenceIds: ['absent'] })
    ],
    evidence: [evidenceRecord({ id: 'ev-1' }), evidenceRecord({ id: 'ev-2' })], libraryItems: []
  });
  assert.deepEqual(graph.graphNeighborIds(projection, 'claim:a'), ['evidence:ev-1', 'evidence:ev-2', 'claim:b', 'claim:c']);
  const first = graph.graphNeighbors(projection, { nodeId: 'claim:a', offset: 0, limit: 2 });
  const second = graph.graphNeighbors(projection, { nodeId: 'claim:a', offset: 2, limit: 2 });
  assert.equal(first.total, 4); assert.equal(second.total, 4);
  assert.deepEqual(first.nodes.map(n => n.id), ['evidence:ev-1', 'evidence:ev-2']);
  assert.deepEqual(second.nodes.map(n => n.id), ['claim:b', 'claim:c']);
  assert.deepEqual(graph.graphNeighborIds(projection, 'claim:d'), []);
  assert.equal(projection.links.length, 5, 'duplicate evidence IDs create one actual citation');
  assert.deepEqual(graph.graphNeighbors(projection, { nodeId: 'claim:a', offset: 4, limit: 2 }), { nodes: [], total: 4 });
});

test('high-degree projection remains linear and pages every shared neighbor without omissions', () => {
  const count = 10_000;
  const projection = graph.deriveGraph({ libraryItems: [], evidence: [evidenceRecord({})],
    claims: Array.from({ length: count }, (_, i) => claimRecord({ id: `c-${i}` })) });
  assert.equal(projection.nodes.length, count + 1);
  assert.equal(projection.links.length, count);
  const neighbors = graph.graphNeighborIds(projection, 'claim:c-0');
  assert.equal(neighbors.length, count);
  assert.equal(neighbors[0], 'evidence:ev-1');
  assert.equal(neighbors.at(-1), 'claim:c-9999');
  const tail = graph.graphNeighbors(projection, { nodeId: 'claim:c-0', offset: count - 50, limit: 50 });
  assert.equal(tail.total, count); assert.equal(tail.nodes.length, 50);
  assert.deepEqual(tail.nodes.map(n => n.id), neighbors.slice(-50));
});

test('Wiki review distinguishes a declaration, human support, conditions, contradiction and superseded sources', () => {
  const claim = claimRecord({});
  const record = evidenceRecord({});
  const source = {evidence: record, referenceStatus: 'recorded', invalidatedAt: null, sourceLocator: null};
  const relation = {id: 'rel-1', claimId: claim.id, claimVersion: claim.version, evidenceId: record.id,
    kind: 'supports', status: 'proposed', condition: null};
  const snapshot = {claims: [claim], sources: [source], relations: []};
  const input = {claims: [claim], evidence: [record], libraryItems: [], snapshot};
  const page = () => wiki.deriveWiki(input).pages[0];
  assert.equal(page().review, 'unreviewed');
  snapshot.relations = [relation];
  assert.equal(page().review, 'unreviewed');
  relation.status = 'confirmed';
  assert.equal(page().review, 'confirmed');
  relation.kind = 'qualifies'; relation.condition = 'Only for the measured sample';
  assert.equal(page().review, 'qualified');
  relation.kind = 'contradicts';
  assert.equal(page().review, 'contradicted');
  source.referenceStatus = 'superseded'; relation.status = 'invalidated';
  assert.equal(page().review, 'stale');
  assert.equal(page().status, 'supported');
  assert.equal(page().evidence[0].excerpt, record.excerpt);
  assert.equal(page().evidence[0].referenceStatus, 'superseded');
});

test('Wiki includes reviewed endpoints outside legacy evidenceIds and never calls them orphan evidence', () => {
  const claim = claimRecord({});
  const sources = [evidenceRecord({}), evidenceRecord({id: 'extra'})]
    .map(evidence => ({evidence, referenceStatus: 'recorded', invalidatedAt: null, sourceLocator: null}));
  const snapshot = {claims: [claim], sources, relations: [{id: 'rel', claimId: claim.id, claimVersion: 1,
    evidenceId: 'extra', status: 'confirmed', kind: 'contradicts'}]};
  const result = wiki.deriveWiki({claims: [claim], evidence: sources.map(source => source.evidence), libraryItems: [], snapshot});
  assert.deepEqual(result.pages[0].evidence.map(card => card.id), ['ev-1', 'extra']);
  assert.deepEqual(result.orphanEvidence, []);
  assert.equal(result.pages[0].review, 'contradicted');
});

test('Wiki uses source-associated metadata when the library list is empty or unrelated', () => {
  const claim = claimRecord({});
  const record = evidenceRecord({sourceType:'file'});
  const snapshot = {claims:[claim],sources:[],relations:[],
    papers:[{evidenceId:record.id,libraryItemId:'lib-1',title:'Managed PDF',year:2025}]};
  for (const libraryItems of [[], [libraryItem('other','Unrelated',1900)]]) {
    const projection = wiki.deriveWiki({claims:[claim],evidence:[record],libraryItems,snapshot});
    assert.deepEqual(projection.pages[0].papers,[{libraryItemId:'lib-1',title:'Managed PDF',year:2025}]);
    assert.deepEqual(projection.timeline,[{year:2025,claimIds:['cl-1']}]);
  }
  assert.deepEqual(wiki.deriveWiki({claims:[claim],evidence:[record],libraryItems:[libraryItem('lib-1','Coincidence',2000)]}).pages[0].papers,[]);
});
