import {readFileSync, writeFileSync} from 'node:fs';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';

if (process.argv.length !== 4) throw new Error('Usage: pnpm research:acquisition-eval <evidence.json> <new-report.json>');
const {evaluateLiteratureAcquisition} = await importTypeScriptModule('src/main/plugins/research/literature-acquisition-evaluation.ts', {platform: 'node'});
const report = evaluateLiteratureAcquisition(JSON.parse(readFileSync(process.argv[2], 'utf8')));
writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
console.log(JSON.stringify({corpusId: report.corpusId, ...report.allPapers}));
