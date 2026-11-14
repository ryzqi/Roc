import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { evaluateLocalRetrieval, sha256 } from './index.mjs';
if (process.argv.length !== 4) throw new Error('usage: node evaluation/adapters/frozen-retrieval/check.mjs <frozen-corpus.json> <report.json>');
const input = resolve(process.argv[2]), output = resolve(process.argv[3]);
if (input === output) throw new Error('report_must_not_overwrite_corpus');
const bytes = readFileSync(input);
const report = { ...await evaluateLocalRetrieval(JSON.parse(bytes)), inputSha256: sha256(bytes) };
mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ corpusId: report.corpusId, queries: new Set(report.rows.map(r => r.queryId)).size,
  evaluationMode: report.evaluationMode, evaluationPurpose: report.evaluationPurpose, acceptance: report.acceptance, output }));
