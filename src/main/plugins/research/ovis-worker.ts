import {ovisModelIdentitySchema, type OvisModelIdentity} from '../../../shared/schemas/research-ovis';
import {hasUnprovenResearchProcessExit} from './process-exit-state';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {lstat, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {z} from 'zod';
import {adaptOvisPage, type OvisAdaptedPage, type OvisSourceBinding} from './ovis-document-adapter';
import {runResearchProcess, type ResearchProcessRequest, type ResearchProcessResult} from './process-runner';
import {hashResearchFile} from './research-job';

const exec = promisify(execFile);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const metricSchema = z.object({
  id: z.string(), sha256: hash, width: z.number().int().positive(), height: z.number().int().positive(),
  rawSha256: hash, valid: z.literal(true), errors: z.array(z.string()).length(0),
  generationTokens: z.number().int().positive(), termination: z.object({finishReason: z.literal('stop'),
    eosObserved: z.literal(true), truncated: z.literal(false), errors: z.array(z.string()).length(0)})
});
const reportSchema = z.object({schemaVersion: z.literal(1), status: z.literal('completed'), variant: z.literal('8bit'),
  revision: z.string(), receiptSha256: hash, evaluatorSha256: hash, promptSha256: hash,
  settings: z.object({temperature: z.literal(0), maxTokens: z.literal(16384), enableThinking: z.literal(false),
    minPixels: z.literal(200704), maxPixels: z.literal(8294400), seed: z.literal(0),
    repetitionPenalty: z.literal(1.03), repetitionContextSize: z.literal(20)}).strict(),
  network: z.literal('denied-by-seatbelt'), pagesManifestSha256: hash, pages: z.array(metricSchema)});

// -I -S keeps user site, .pth startup and project modules out of the interpreter.
// JSON stdin is data. Paths never become interpolated Python or shell code.
export const ovisWorkerBootstrap = String.raw`import ctypes, hashlib, json, runpy, sys
from pathlib import Path
request = json.loads(sys.stdin.read())
for name in ("inference", "receipt"):
    with open(request[name], "rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != request[name + "Sha256"]:
            raise RuntimeError("research_ovis_worker_identity_changed")
lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
lib._set_user_dir_suffix.argtypes = [ctypes.c_char_p]
lib._set_user_dir_suffix.restype = ctypes.c_int
if lib._set_user_dir_suffix(request["cacheSuffix"].encode()) != 1:
    raise RuntimeError("research_ovis_metal_cache_unavailable")
sys.path.append(request["packagePath"])
inference = runpy.run_path(request["inference"], run_name="roc_ovis_worker")
inference["require_offline"]()
# Hash every runtime/model entry before importing installed executable packages.
inference["verify_installation"](Path(request["installation"]))
import mlx.core as mx
if not mx.metal.is_available():
    raise RuntimeError("research_ovis_metal_unavailable")
mx.set_default_device(mx.gpu)
mx.set_memory_limit(4 * 1024**3)
mx.set_cache_limit(64 * 1024**2)
sys.argv = [request["inference"], "--installation", request["installation"],
            "--pages", request["pages"], "--output", request["output"], "--offline-worker"]
raise SystemExit(inference["main"]())
`;

export type OvisWorkerInstallation = {
  root: string; pythonBase: string; inferenceScript: string; identity: OvisModelIdentity;
};
export type OvisWorkerInput = {
  installation: OvisWorkerInstallation;
  pages: readonly {imagePath: string; binding: OvisSourceBinding}[];
  admission: ResearchProcessRequest['admission']; timeoutMs: number; signal: AbortSignal;
};
export type OvisWorkerResult = {pages: OvisAdaptedPage[]; process: ResearchProcessResult};

async function regularFile(path: string, maxBytes: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) {
    throw new Error('research_ovis_file_invalid');
  }
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw new Error('research_ovis_file_invalid');
  return bytes;
}
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** One admitted Worker loads once for all document pages; no model service or listening port. */
export async function runOvisDocumentPages(input: OvisWorkerInput,
  run: (request: ResearchProcessRequest) => Promise<ResearchProcessResult> = runResearchProcess
): Promise<OvisWorkerResult> {
  input.signal.throwIfAborted();
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('research_ovis_platform_unsupported');
  if (input.pages.length === 0 || input.pages.length > 500 || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 ||
      new Set(input.pages.map(page => page.binding.frame.page)).size !== input.pages.length ||
      new Set(input.pages.map(page => page.binding.sourceHash)).size !== 1) {
    throw new Error('research_ovis_request_invalid');
  }
  const model = ovisModelIdentitySchema.parse(input.installation.identity);
  const root = await realpath(input.installation.root), pythonBase = await realpath(input.installation.pythonBase);
  const inference = await realpath(input.installation.inferenceScript), receipt = join(root, 'receipt.json');
  if (digest(await regularFile(inference, 1024 * 1024)) !== model.inferenceSha256 ||
      digest(await regularFile(receipt, 16 * 1024 * 1024)) !== model.installationReceiptSha256) {
    throw new Error('research_ovis_worker_identity_changed');
  }
  const pages: Array<{id: string; image: string; sha256: string}> = [];
  for (const [index, page] of input.pages.entries()) {
    input.signal.throwIfAborted();
    if (JSON.stringify(ovisModelIdentitySchema.parse(page.binding.model)) !== JSON.stringify(model)) {
      throw new Error('research_ovis_source_binding_invalid');
    }
    const info = await lstat(page.imagePath), image = await realpath(page.imagePath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 128 * 1024 * 1024 ||
        await hashResearchFile(image) !== page.binding.inputImageSha256) throw new Error('research_ovis_input_changed');
    pages.push({id: `page-${index + 1}`, image, sha256: page.binding.inputImageSha256});
  }
  const cacheRoot = await realpath((await exec('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], {signal: input.signal})).stdout.trim());
  let job: string | undefined, cache: string | undefined, safeToClean = true;
  try {
    job = await mkdtemp('/private/tmp/roc-ovis-document-');
    cache = await mkdtemp(join(cacheRoot, 'roc-ovis-document-'));
    const manifest = join(job, 'pages.json'), output = join(job, 'output');
    const manifestBytes = Buffer.from(JSON.stringify({schemaVersion: 1, pages}));
    await writeFile(manifest, manifestBytes, {flag: 'wx', mode: 0o600});
    const runtime = join(root, 'runtime');
    const wire = {installation: root, inference, inferenceSha256: model.inferenceSha256,
      receipt, receiptSha256: model.installationReceiptSha256, cacheSuffix: basename(cache),
      packagePath: join(runtime, 'lib/python3.14/site-packages'), pages: manifest, output};
    const result = await run({command: join(runtime, 'bin/python'),
      args: ['-I', '-S', '-B', '-X', 'utf8', '-c', ovisWorkerBootstrap], input: JSON.stringify(wire), cwd: job,
      readablePaths: [pythonBase, runtime, receipt, join(root, 'spec'), join(root, 'model-8bit'),
        join(root, 'source/prompts/document_structured.txt'), join(root, 'source/generation_config.json'),
        inference, ...pages.map(page => page.image), '/usr/lib', '/System/Library'],
      writablePaths: [job, cache],
      environment: {PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: job,
        HF_HOME: job, XDG_CACHE_HOME: job, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
        HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false', DO_NOT_TRACK: '1'},
      timeoutMs: input.timeoutMs, terminationGraceMs: 2000, maxOutputBytes: 1024 * 1024,
      resourceLimits: {mode: 'monitored', cpuTimeMs: input.timeoutMs, maxResidentBytes: 6 * 1024 ** 3},
      admission: input.admission, signal: input.signal, allowGpuAcceleration: true,
      metalCompilerCachePath: cache, networkAccess: 'none',
      writeLimits: [
        {path: job, maxFileBytes: 16 * 1024 ** 2, maxTotalBytes: Math.min(512, 16 + pages.length * 8) * 1024 ** 2,
          maxFiles: 10 + pages.length * 4, maxEntries: 50 + pages.length * 4},
        {path: cache, maxFileBytes: 64 * 1024 ** 2, maxTotalBytes: 128 * 1024 ** 2, maxFiles: 500, maxEntries: 1000}
      ]});
    input.signal.throwIfAborted();
    if (result.exitCode !== 0) throw new Error('research_ovis_worker_failed');
    const report = reportSchema.parse(JSON.parse((await regularFile(join(output, 'report.json'), 16 * 1024 ** 2)).toString('utf8')));
    if (report.revision !== model.revision || report.receiptSha256 !== model.installationReceiptSha256 ||
        report.evaluatorSha256 !== model.inferenceSha256 || report.promptSha256 !== model.promptSha256 ||
        report.pagesManifestSha256 !== digest(manifestBytes) || report.pages.length !== pages.length) {
      throw new Error('research_ovis_worker_report_invalid');
    }
    const adapted: OvisAdaptedPage[] = [];
    for (const [index, expected] of pages.entries()) {
      input.signal.throwIfAborted();
      const page = report.pages[index], binding = input.pages[index].binding;
      if (page.id !== expected.id || page.sha256 !== expected.sha256 || await hashResearchFile(expected.image) !== expected.sha256) {
        throw new Error('research_ovis_worker_report_invalid');
      }
      const raw = await regularFile(join(output, `${expected.id}.raw.txt`), 4 * 1024 ** 2);
      const tokens = JSON.parse((await regularFile(join(output, `${expected.id}.tokens.json`), 256 * 1024)).toString('utf8'));
      adapted.push(adaptOvisPage(raw, {protocolVersion: 1, sourceHash: binding.sourceHash,
        inputImageSha256: expected.sha256, page: binding.frame.page, width: page.width, height: page.height,
        model, rawSha256: page.rawSha256, generation: {finishReason: page.termination.finishReason,
          generationTokens: page.generationTokens, tokenIds: tokens}}, binding));
    }
    return {pages: adapted, process: result};
  } catch (error) {
    if (hasUnprovenResearchProcessExit(error)) safeToClean = false;
    throw error;
  } finally {
    if (safeToClean) {
      const cleanups = await Promise.allSettled([job, cache].filter((path): path is string => path !== undefined)
        .map(path => rm(path, {recursive: true, force: true})));
      const errors = cleanups.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'research_ovis_cleanup_failed');
    }
  }
}
