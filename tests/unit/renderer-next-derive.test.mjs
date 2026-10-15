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
  wiki = await build('src/renderer-next/literature/derive-wiki.ts', 'wiki.mjs');
  graph = await build('src/renderer-next/literature/derive-graph.ts', 'graph.mjs');
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
    ['cites', 'cites', 'shares-evidence', 'sourced-from']
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
    graph.graphNeighbors(projection, 'evidence:ev-1').map((node) => node.id).sort(),
    ['claim:cl-a', 'paper:lib-1']
  );
  assert.deepEqual(graph.graphNeighbors(projection, 'claim:cl-b'), []);
});
