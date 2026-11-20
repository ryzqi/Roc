import { lstatSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, writeJson } from '../evaluation/lib/common.mjs';
import { scoreScientificRetrievalRun } from '../evaluation/adapters/scientific-retrieval.mjs';

export function scientificRetrievalScoringArguments(args) {
  const allowed = new Set(['--run', '--manifest', '--bindings', '--context', '--output']), values = new Map();
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (!allowed.has(key) || values.has(key) || !value || value.startsWith('--')) {
      throw new Error('scientific_retrieval_cli_arguments_invalid');
    }
    values.set(key, resolve(value));
  }
  if (!['--run', '--bindings', '--output'].every(k => values.has(k))) {
    throw new Error('scientific_retrieval_cli_arguments_invalid');
  }
  const output = values.get('--output'), runRoot = values.get('--run');
  const manifestPath = values.get('--manifest') ?? `${ROOT}/evaluation/corpora/scientific-rag/manifest.json`;
  for (let current = output;; current = resolve(current, '..')) {
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error('scientific_retrieval_output_link');
    if (current === output && stat) throw new Error('scientific_retrieval_output_exists:EEXIST');
    if (resolve(current, '..') === current) break;
  }
  for (const input of [runRoot, resolve(manifestPath, '..')]) {
    const rel = relative(input, output);
    if (!rel || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      throw new Error('scientific_retrieval_output_overlaps_input');
    }
  }
  return { runRoot, manifestPath, bindingsPath: values.get('--bindings'),
    contextPath: values.get('--context') ?? null, output };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { output, ...options } = scientificRetrievalScoringArguments(process.argv.slice(2));
    const report = await scoreScientificRetrievalRun(options);
    writeJson(output, report);
    console.log(JSON.stringify({ status: report.status, counts: report.counts ?? null,
      scientificBaselineReady: false, output }, null, 2));
    if (report.status === 'blocked') process.exitCode = 2;
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
