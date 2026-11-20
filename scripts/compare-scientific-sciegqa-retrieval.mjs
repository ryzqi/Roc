import {isAbsolute, relative, resolve, sep} from 'node:path';
import {writeJson} from '../evaluation/lib/common.mjs';
import {compareSciegqaRetrievalRuns} from '../evaluation/adapters/scientific-public/sciegqa-retrieval-comparison.mjs';

if (process.argv.length !== 5) throw new Error('Usage: node scripts/compare-scientific-sciegqa-retrieval.mjs FIRST_RUN SECOND_RUN NEW_REPORT_PATH');
const [first, second, output] = process.argv.slice(2).map(path => resolve(path));
try {
  if ([first, second].some(root => {
    const rel = relative(root, output);
    return !rel || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  })) throw new Error('scientific_sciegqa_comparison_output_overlaps_run');
  const report = await compareSciegqaRetrievalRuns(first, second);
  writeJson(output, report);
  console.log(JSON.stringify({status: report.status, changedQuestionIds: report.changedQuestionIds,
    indexEqual: report.indexEqual, fixedInputObservationsRepeatable: report.fixedInputObservationsRepeatable}, null, 2));
} catch (error) {console.error(error.stack); process.exitCode = 1;}
