import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, writeJson } from '../evaluation/lib/common.mjs';
import { evaluateScientificPdfRun } from '../evaluation/adapters/scientific-pdf.mjs';

export function scientificPdfArguments(args) {
  const allowed = new Set(['--run', '--source-root', '--manifest', '--output', '--observe']);
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!allowed.has(flag) || values.has(flag)) throw new Error('scientific_pdf_cli_arguments_invalid');
    if (flag === '--observe') values.set(flag, true);
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('scientific_pdf_cli_value_missing');
      values.set(flag, args[++i]);
    }
  }
  if (!values.has('--run') || !values.has('--source-root') || !values.has('--output')
    || values.has('--observe') && values.has('--manifest')) throw new Error('scientific_pdf_cli_arguments_invalid');
  return { runRoot: resolve(values.get('--run')), sourceRoot: resolve(values.get('--source-root')),
    manifestPath: values.has('--observe') ? null
      : resolve(values.get('--manifest') ?? `${ROOT}/evaluation/corpora/scientific-rag/manifest.json`),
    output: resolve(values.get('--output')) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { output, ...options } = scientificPdfArguments(process.argv.slice(2));
    const report = await evaluateScientificPdfRun(options);
    writeJson(output, report);
    console.log(JSON.stringify({ status: report.status, papers: report.verified?.length ?? 0,
      pages: report.observations?.reduce((n, o) => n + o.pages.length, 0) ?? 0,
      deterministicObservationHash: report.deterministicObservationHash ?? null,
      qualityMetrics: report.qualityMetrics, scientificBaselineReady: false, output }, null, 2));
    if (report.status === 'blocked') process.exitCode = 2;
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
