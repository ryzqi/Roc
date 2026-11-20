import {join, resolve} from 'node:path';
import {verifySciegqaPdfRun} from '../evaluation/adapters/scientific-public/sciegqa-pdf.mjs';
import {writeJson} from '../evaluation/lib/common.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-scientific-sciegqa-pdf.mjs RUN_ROOT');
const root = resolve(process.argv[2]);
try {
  const report = await verifySciegqaPdfRun(root);
  writeJson(join(root, 'verified-pdf.json'), report);
  console.log(JSON.stringify({root: report.root, papers: report.papers, failedPapers: report.failedPapers,
    verifiedPages: report.verifiedPages, performance: report.performance,
    deterministicOutputHash: report.deterministicOutputHash}, null, 2));
} catch (error) {console.error(error.stack); process.exitCode = 1;}
