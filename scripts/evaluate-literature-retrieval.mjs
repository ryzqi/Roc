import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const prepare = args[0] === '--prepare';
if (args.length !== (prepare ? 3 : 2)) throw new Error('Usage: pnpm research:retrieval-eval [--prepare] <input.json> <new-output.json>');
const [inputPath, outputPath] = args.slice(prepare ? 1 : 0).map(value => resolve(value));
const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const relevantPaths = [
  'scripts/evaluate-literature-retrieval.mjs', 'pnpm-lock.yaml',
  'src/main/plugins/research/literature-retrieval-evaluation.ts',
  'src/main/plugins/research/literature-fusion.ts', 'src/main/plugins/research/literature-identity-graph.ts',
  'src/main/plugins/research/literature-identity.ts', 'src/shared/schemas'
];
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...relevantPaths], {cwd: root, encoding: 'utf8'}).trim();
const commit = dirty.length === 0 ? execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim() : null;
const temporaryRoot = join(root, '.runtime/tmp');
mkdirSync(temporaryRoot, {recursive: true});
const directory = mkdtempSync(join(temporaryRoot, 'retrieval-eval-'));
function publish(value) {
  const outputDirectory = mkdtempSync(join(dirname(outputPath), '.roc-retrieval-report-'));
  try {
    const staged = join(outputDirectory, 'report.json');
    writeFileSync(staged, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    linkSync(staged, outputPath);
  } finally {
    rmSync(outputDirectory, {recursive: true, force: true});
  }
}
try {
  const outfile = join(directory, 'evaluator.mjs');
  await esbuild.build({stdin: {contents: "export {evaluateLiteratureRetrieval, prepareLiteratureJudgmentPacket} from './src/main/plugins/research/literature-retrieval-evaluation';",
    resolveDir: root}, outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent'});
  const bundleHash = createHash('sha256').update(readFileSync(outfile)).digest('hex');
  const {evaluateLiteratureRetrieval, prepareLiteratureJudgmentPacket} = await import(pathToFileURL(outfile).href);
  if (prepare) {
    const packet = prepareLiteratureJudgmentPacket(input);
    publish(packet);
    console.log(JSON.stringify({corpusId: packet.corpusId, kind: packet.kind, queries: packet.queries.length, outputPath}));
  } else {
    const report = evaluateLiteratureRetrieval(input, commit, bundleHash);
    publish(report);
    console.log(JSON.stringify({corpusId: report.corpusId, annotationAssurance: report.annotationAssurance,
      sampleStatus: report.sampleStatus, queries: report.queryCount, topics: report.topicCount, outputPath}));
  }
} finally {
  rmSync(directory, {recursive: true, force: true});
}
