import { readFileSync } from 'node:fs';
import { importTypeScriptModule } from '../lib/bundle-ts.mjs';

const { auditQualityDataset, loadQualityDatasetPackage } = await importTypeScriptModule(
  'scripts/harness-eval/quality-evaluation/dataset.ts', { platform: 'node' }
);
const args = process.argv.slice(2);
if (args.length !== 0 && args.length !== 2) throw new Error('usage: quality-check.mjs [manifest.json sha256]');
const manifestPath = args[0] ?? 'tests/fixtures/quality-evaluation/manifest.json';
const datasetHash = args[1] ?? readFileSync('tests/fixtures/quality-evaluation/manifest.sha256', 'utf8').trim();
const { dataset } = loadQualityDatasetPackage(manifestPath, datasetHash);
console.log(JSON.stringify({
  ...auditQualityDataset(dataset), executionMode: 'offline-audit', modelCalls: 0, externalCalls: 0
}, null, 2));
