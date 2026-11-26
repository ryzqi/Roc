/** Functional production route check: optional direct HF install, real parse, provenance and cleanup. No comparison. */
import assert from 'node:assert/strict';
import {copyFile, mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';

const {values} = parseArgs({options: {models: {type: 'string'}, python: {type: 'string'}, source: {type: 'string'},
  output: {type: 'string'}, install: {type: 'boolean', default: false}}, strict: true});
for (const key of ['models', 'python', 'source', 'output']) if (!values[key]) throw new Error(`--${key} required`);
const output = resolve(values.output); await mkdir(dirname(output), {recursive: true}); await mkdir(output);
const load = name => importTypeScriptModule(`src/main/plugins/research/${name}.ts`,
  {platform: 'node', external: ['paddleocr', 'onnxruntime-node', '@napi-rs/canvas', 'pdfjs-dist', 'utif'], tempDir: '.runtime/tmp'});
const {ResearchToolchain} = await load('toolchain');
const {hasUnprovenResearchProcessExit} = await load('process-exit-state');
const {collectDocumentContent} = await load('document-files');
const sourcePath = await realpath(values.source);
const tools = new ResearchToolchain(null, resolve(values.models),
  {pythonRoot: resolve(values.python), specification: await realpath('resources/ovis-ocr')});
const report = {status: 'running', scope: 'Direct Hugging Face 8-bit production installation and one-page parse; no reference comparison',
  source: sourcePath, temporaryRemoved: false};
let work, preserve = false, timer;
try {
  if (values.install) {
    timer = setInterval(() => tools.modelsStatus().then(status => console.log(JSON.stringify(status.job)))
      .catch(error => console.log(error.message)), 15000);
    await tools.downloadModels('complete'); clearInterval(timer); timer = null;
  }
  const status = await tools.selectModels('complete');
  assert.equal(status.ready, true);
  report.models = status; report.parserIdentity = await tools.identity();
  work = await realpath(await mkdtemp('/private/tmp/roc-ovis-production-'));
  const frozenSource = join(work, basename(sourcePath)); await copyFile(sourcePath, frozenSource);
  const parsed = await tools.parseDocument({projectRoot: work, sourcePath: frozenSource,
    outputDir: join(work, 'parsed'), jobDir: work, options: {tier: 'complete', device: 'cpu', pageRange: '1'},
    admission: {projectId: 'ovis-production-check', priority: 'user'}, signal: new AbortController().signal});
  assert.equal(parsed.engine, 'ovisocr3-mlx');
  const collected = await collectDocumentContent(work, join(work, 'parsed'), parsed);
  report.result = parsed; report.content = {blocks: collected.data.content.blocks.length};
  const identity = await tools.identity(); assert.equal(identity, report.parserIdentity);
  report.status = 'passed';
} catch (error) {
  preserve = hasUnprovenResearchProcessExit(error);
  report.status = 'failed'; report.error = String(error.stack ?? error); process.exitCode = 1;
} finally {
  if (timer) clearInterval(timer);
  if (work && !preserve) {await rm(work, {recursive: true}); report.temporaryRemoved = true;}
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({status: report.status, error: report.error, output}));
}
