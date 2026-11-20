import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJson, writeJson} from '../evaluation/lib/common.mjs';
import {publicPdfArtifactPath} from '../evaluation/adapters/scientific-public/pdf.mjs';
import {comparePublicPdfReports} from '../evaluation/adapters/scientific-public/pdf-comparison.mjs';
import {verifyScientificPublicPdfRun} from './verify-scientific-public-pdf.mjs';

export async function compareScientificPublicPdfRuns(firstRoot, secondRoot, output) {
  output = resolve(output);
  if (existsSync(output)) throw new Error('scientific_pdf_comparison_output_exists');
  const attempts = [];
  for (const root of [firstRoot, secondRoot].map(value => resolve(value))) {
    const verified = await verifyScientificPublicPdfRun(root, {persist: false});
    attempts.push({run: readJson(publicPdfArtifactPath(root, 'run.json')),
      inputs: readJson(publicPdfArtifactPath(root, 'inputs.json')), verified});
  }
  const report = comparePublicPdfReports(attempts);
  writeJson(output, report);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5)
    throw new Error('Usage: node scripts/compare-scientific-public-pdf.mjs FIRST_ROOT SECOND_ROOT NEW_REPORT_PATH');
  compareScientificPublicPdfRuns(...process.argv.slice(2)).then(report => console.log(JSON.stringify({
    status: report.status, papers: report.papers, commonParsedPapers: report.commonParsedPapers,
    commonParsedOutputsEqual: report.commonParsedOutputsEqual,
    completeSuccessfulCohortRepeatable: report.completeSuccessfulCohortRepeatable,
    changedPapers: report.changed.map(row => row.paperId)
  }, null, 2))).catch(error => {console.error(error.stack); process.exitCode = 1;});
}
