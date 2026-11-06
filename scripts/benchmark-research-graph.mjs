import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cpus, totalmem, platform, arch } from 'node:os';
import { importTypeScriptModule } from './lib/bundle-ts.mjs';
import { graphPerformanceFixture } from './lib/research-graph-performance-fixture.mjs';

const source = 'src/renderer/literature/derive-graph.ts';
const { deriveGraph, graphNeighbors, graphNeighborIds, GRAPH_PAGE_SIZE } = await importTypeScriptModule(source, { platform: 'neutral' });
const hash = value => createHash('sha256').update(value).digest('hex');
const protocol = { scales: [100, 300, 1000, 10_000, 50_000], samples: 5, pageSize: 50,
  recipe: 'All claims share one loaded evidence; unloaded source; same-process samples; no force layout.',
  targets: { deriveP95Ms: 2500, expandedPageP95Ms: 100, cachedPageP95Ms: 10 },
  percentile: 'Nearest rank over five samples; descriptive engineering measurements, not a statistical guarantee.' };
const report = { contractVersion: 1, protocol, protocolSha256: hash(JSON.stringify(protocol)),
  sourceSha256: hash(readFileSync(source)), fixtureSha256: hash(readFileSync('scripts/lib/research-graph-performance-fixture.mjs')),
  hardware: { cpu: cpus()[0].model, memoryBytes: totalmem(), node: process.version, platform: platform(), arch: arch() }, rows: [] };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
for (const count of protocol.scales) {
  const input = graphPerformanceFixture(count);
  const samples = [];
  for (let i = 0; i < protocol.samples; i++) {
    const start = performance.now(); const graph = deriveGraph(input); const deriveMs = performance.now() - start;
    const neighborStart = performance.now();
    const first = graphNeighbors(graph, { nodeId: 'claim:c-0', offset: 0, limit: GRAPH_PAGE_SIZE });
    const expandedPageMs = performance.now() - neighborStart;
    const ids = graphNeighborIds(graph, 'claim:c-0');
    const pageStart = performance.now();
    const last = ids.slice(count - GRAPH_PAGE_SIZE).map(id => graph.nodeById.get(id));
    const cachedPageMs = performance.now() - pageStart;
    assert.equal(graph.links.length, count); assert.equal(graph.nodes.length, count + 1);
    assert.equal(first.total, count); assert.equal(first.nodes.length, 50);
    assert.equal(first.nodes[0].id, 'evidence:shared'); assert.equal(last.length, 50);
    assert.equal(last.at(-1).id, `claim:c-${count - 1}`);
    assert.equal(new Set(ids).size, count); assert.equal(ids.includes('claim:c-0'), false);
    samples.push({ deriveMs, expandedPageMs, cachedPageMs, nodes: graph.nodes.length, links: graph.links.length, rssBytes: process.memoryUsage().rss });
  }
  const summary = { deriveP95Ms: p95(samples.map(s => s.deriveMs)), expandedPageP95Ms: p95(samples.map(s => s.expandedPageMs)),
    cachedPageP95Ms: p95(samples.map(s => s.cachedPageMs)), peakRssBytes: Math.max(...samples.map(s => s.rssBytes)) };
  for (const [key, target] of Object.entries(protocol.targets)) assert.ok(summary[key] <= target, `${count} ${key}: ${summary[key]} > ${target}`);
  report.rows.push({ claims: count, corpusSha256: hash(JSON.stringify(input)), samples, summary });
  console.log(JSON.stringify({ claims: count, ...summary }));
}
const output = resolve(process.argv[2] ?? '.artifacts/research-optimization/graph-current.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
