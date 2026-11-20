import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from '../evaluation/lib/common.mjs';
import { publicPdfArtifactPath } from '../evaluation/adapters/scientific-public/pdf.mjs';
import { sciegqaCorpusRoot } from '../evaluation/adapters/scientific-public/sciegqa-pdf.mjs';
import { captureScientificContextReads } from '../evaluation/adapters/scientific-context-reads.mjs';

export function scientificContextArguments(args) {
  if (args.length !== 4 || args[0] !== '--run' || args[2] !== '--output'
    || !args[1] || !args[3] || args[1].startsWith('--') || args[3].startsWith('--')) {
    throw new Error('Usage: node scripts/capture-scientific-context-reads.mjs --run SAVED_RUN --output NEW_FILE.json');
  }
  const runRoot = resolve(args[1]), output = resolve(args[3]);
  if (existsSync(output)) throw new Error('scientific_context_output_exists:EEXIST');
  for (let current = output;; current = resolve(current, '..')) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('scientific_context_output_link');
    if (resolve(current, '..') === current) break;
  }
  const inputs = readJson(publicPdfArtifactPath(runRoot, 'inputs.json'));
  const contains = (parent, path) => {
    const rel = relative(resolve(parent), path);
    return !rel || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if ([runRoot, inputs.pdfRoot, inputs.correspondenceRoot, sciegqaCorpusRoot]
    .some(input => contains(input, output))) throw new Error('scientific_context_output_overlaps_input');
  return { runRoot, output };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { runRoot, output } = scientificContextArguments(process.argv.slice(2));
    const report = await captureScientificContextReads(runRoot);
    writeJson(output, report);
    console.log(JSON.stringify({ status: report.status, ...report.counts,
      deterministicObservationHash: report.deterministicObservationHash, scientificBaselineReady: false, output }, null, 2));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
