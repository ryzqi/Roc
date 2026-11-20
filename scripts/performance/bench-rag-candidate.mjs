import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeReport, saveReport, sha256, summarizeRows } from './report-lib.mjs';

const output = process.argv[2] ?? '.artifacts/mac-performance/rag-before.json';
const rawPath = resolve('.artifacts/mac-performance/retrieval-raw-' + Date.now() + '.json');
mkdirSync(resolve('.artifacts/mac-performance'), { recursive: true });
const child = spawn(process.execPath, ['scripts/benchmark-research-retrieval.mjs', rawPath], { stdio: 'inherit', shell: false });
const exit = await new Promise((done, reject) => { child.on('error', reject); child.on('exit', done); });
if (exit !== 0) throw new Error(`rag_benchmark_failed:${exit}`);
const bytes = readFileSync(rawPath), raw = JSON.parse(bytes);
const report = makeReport('rag-candidate', { recipe: raw.recipe, corpus: raw.scales.map(scale => scale.sourceSha256) },
  ['src/main/plugins/research/knowledge-repository.ts']);
report.raw = { path: rawPath, sha256: sha256(bytes) };
report.host.sqlite = raw.scales[0].sqliteVersion;
report.scenarios = raw.scales.flatMap(scale => scale.rows.map(row => ({
  id: `${scale.chunkCount}/${row.projectId ?? 'all'}/${row.query}/${row.cache}`,
  summary: summarizeRows(row.samples), samples: row.samples, targetExceeded: row.targetExceeded,
  correctnessSha256: sha256(JSON.stringify(row.samples.map(sample => [sample.rankingInputHash, sample.hitsSha256])))
})));
report.limitations.push(raw.cacheMeaning, raw.vectorMeaning, 'Frozen supplied vectors establish engineering ranking/throughput, not live model quality.');
console.log(saveReport(output, report));
