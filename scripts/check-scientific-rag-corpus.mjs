import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkScientificRagCorpus } from '../evaluation/lib/scientific-rag-corpus.mjs';
import { ROOT, writeJson } from '../evaluation/lib/common.mjs';

const { values } = parseArgs({
  options: { corpus: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } },
  allowPositionals: false, strict: true
});
if (values.help) {
  console.log('pnpm evaluation:scientific-rag:check [--corpus manifest.json] [--output new-report.json]');
  console.log('Checks PDF bytes, human annotation records, evidence locators and 45-paper/200-query quotas.');
  console.log('Exit 0: corpus ready; exit 2: missing/invalid data. Does not run a scientific baseline.');
} else {
  const report = await checkScientificRagCorpus(resolve(values.corpus
    ?? resolve(ROOT, 'evaluation/corpora/scientific-rag/manifest.json')));
  if (values.output) writeJson(resolve(values.output), report);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.corpusReady ? 0 : 2;
}
