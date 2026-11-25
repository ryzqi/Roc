import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat, mkdtemp, readFile, readdir, realpath, rm} from 'node:fs/promises';
import {basename, isAbsolute, join, relative, sep} from 'node:path';
import {release} from 'node:os';
import {z} from 'zod';
import sourceLock from '../../../../resources/ovis-ocr/manifest.json';
import runtimeLock from '../../../../resources/research-runtime/python-tools.lock.json';
import {fileSha256} from '../../../../scripts/research/download-asset';
import {runResearchProcess, type ResearchProcessResult} from './process-runner';
import type {ManagedPythonRuntime} from './python-runtime-store';

const exec = promisify(execFile);
const converterSha256 = '44e5a306b8016b347e9952e7fb04bcd1d170b45ba888a26638859afe3873edc5';
const manifestSha256 = '941eb8d1e63a3356809aa1273940230956e22effaed96c6318e6002071b9fc43';
const conversionSchema = z.object({status: z.literal('converted-unvalidated'), inferenceValidated: z.literal(false),
  quantization: z.object({bits: z.literal(8), group_size: z.literal(64), mode: z.literal('affine'), method: z.literal('rtn')}).strict(),
  visionDtype: z.literal('bfloat16'), visionTensors: z.literal(153), quantizedLanguageModules: z.literal(187),
  totalTensors: z.literal(847)}).strict();
const unprovenExitCodes = new Set(['research_process_kill_failed', 'research_process_supervision_failed',
  'research_process_completion_failed']);

const bootstrap = String.raw`import ctypes, hashlib, json, runpy, sys
request = json.loads(sys.stdin.read())
for name in ('converter', 'manifest'):
    with open(request[name], 'rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != request[name + 'Sha256']:
            raise RuntimeError('research_ovis_conversion_spec_changed')
lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
lib._set_user_dir_suffix.argtypes = [ctypes.c_char_p]
lib._set_user_dir_suffix.restype = ctypes.c_int
if lib._set_user_dir_suffix(request['cacheSuffix'].encode()) != 1:
    raise RuntimeError('research_ovis_metal_cache_unavailable')
sys.path.append(request['packages'])
import mlx.core as mx
if not mx.metal.is_available():
    raise RuntimeError('research_ovis_metal_unavailable')
mx.set_default_device(mx.gpu)
mx.set_memory_limit(4 * 1024**3)
mx.set_cache_limit(64 * 1024**2)
sys.argv = [request['converter'], '--source', request['source'], '--output', request['output'], '--manifest', request['manifest']]
runpy.run_path(request['converter'], run_name='__main__')
`;

async function directory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('research_ovis_conversion_absolute_path_required');
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error('research_ovis_conversion_directory_invalid');
  }
}

async function verifyFile(path: string, sha256: string, signal: AbortSignal, size?: number): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || size !== undefined && info.size !== size ||
      await fileSha256(path, signal) !== sha256) throw new Error('research_ovis_conversion_input_changed');
}

async function verifySource(root: string, signal: AbortSignal): Promise<void> {
  const expected = new Map(sourceLock.model.files.map(file => [file.path, file]));
  const seen = new Set<string>();
  const directories = new Set<string>();
  for (const name of expected.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  const visit = async (path: string): Promise<void> => {
    await directory(path);
    for (const name of await readdir(path)) {
      signal.throwIfAborted();
      const child = join(path, name), key = relative(root, child).split(sep).join('/');
      if (directories.has(key)) await visit(child);
      else {
        const file = expected.get(key);
        if (!file) throw new Error('research_ovis_conversion_source_invalid');
        await verifyFile(child, file.sha256, signal, file.size); seen.add(key);
      }
    }
  };
  await visit(root);
  if (seen.size !== expected.size) throw new Error('research_ovis_conversion_source_invalid');
}

export type OvisConversionInput = {
  /** Fresh hash-locked installation, exclusively owned by the preparation transaction. */
  packagesRoot: string; runtime: ManagedPythonRuntime; source: string; specification: string;
  /** New empty canonical directory. Caller owns publication and cleanup. */
  destination: string; projectId: string; signal: AbortSignal;
};
export type OvisConversionResult = {model: string; conversion: z.infer<typeof conversionSchema>; process: ResearchProcessResult};

/** Execute the frozen converter without network, project startup hooks or ordinary experiment permission changes. */
export async function convertOvisModel(input: OvisConversionInput,
  run: typeof runResearchProcess = runResearchProcess): Promise<OvisConversionResult> {
  input.signal.throwIfAborted();
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || Number.parseInt(release(), 10) < 24) {
    throw new Error('research_ovis_conversion_platform_unsupported');
  }
  const {runtime, source, specification, destination, signal} = input;
  await Promise.all([directory(source), directory(specification), directory(destination), directory(input.packagesRoot), directory(runtime.prefix)]);
  if ((await readdir(destination)).length) throw new Error('research_ovis_conversion_destination_not_empty');
  const contains = (parent: string, child: string): boolean => {
    const name = relative(parent, child);
    return name === '' || !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`);
  };
  if ([runtime.prefix, input.packagesRoot, source, specification].some(path => contains(path, destination) || contains(destination, path))) {
    throw new Error('research_ovis_conversion_overlapping_paths');
  }
  if (runtime.version !== runtimeLock.python.version || runtime.pythonKey !== runtimeLock.python.key ||
      runtime.executable !== join(runtime.prefix, runtimeLock.python.executable.path)) {
    throw new Error('research_ovis_conversion_runtime_invalid');
  }
  await verifyFile(runtime.executable, runtimeLock.python.executable.sha256, signal, runtimeLock.python.executable.size);
  const converter = join(specification, 'convert.py'), manifest = join(specification, 'manifest.json');
  await verifyFile(converter, converterSha256, signal); await verifyFile(manifest, manifestSha256, signal);
  await verifySource(source, signal);
  const packages = join(input.packagesRoot, 'lib/python3.14/site-packages');
  await directory(packages);
  const cacheRoot = await realpath((await exec('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], {signal})).stdout.trim());
  const cache = await mkdtemp(join(cacheRoot, 'roc-ovis-convert-'));
  let safeToClean = true;
  try {
    const output = join(destination, 'model-8bit');
    const result = await run({command: runtime.executable, args: ['-I', '-S', '-B', '-X', 'utf8', '-c', bootstrap],
      input: JSON.stringify({source, output, converter, converterSha256, manifest, manifestSha256, packages, cacheSuffix: basename(cache)}),
      cwd: destination, readablePaths: [runtime.prefix, input.packagesRoot, source, converter, manifest, '/usr/lib', '/System/Library'],
      writablePaths: [destination, cache], environment: {PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: destination,
        XDG_CACHE_HOME: destination, HF_HOME: destination, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
        HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', TOKENIZERS_PARALLELISM: 'false'},
      timeoutMs: 600_000, terminationGraceMs: 2000, maxOutputBytes: 2 * 1024 ** 2, signal,
      resourceLimits: {mode: 'monitored', cpuTimeMs: 600_000, maxResidentBytes: 6 * 1024 ** 3},
      admission: {projectId: input.projectId, priority: 'user', resourceClass: 'parse'}, allowGpuAcceleration: true,
      metalCompilerCachePath: cache, networkAccess: 'none', writeLimits: [
        {path: destination, maxFileBytes: 2 * 1024 ** 3, maxTotalBytes: 3 * 1024 ** 3, maxFiles: 256, maxEntries: 512},
        {path: cache, maxFileBytes: 64 * 1024 ** 2, maxTotalBytes: 128 * 1024 ** 2, maxFiles: 500, maxEntries: 1000}
      ]});
    signal.throwIfAborted();
    if (result.exitCode !== 0) throw new Error('research_ovis_conversion_failed', {cause: result});
    await directory(output);
    const report = join(output, 'conversion-check.json'), info = await lstat(report);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) throw new Error('research_ovis_conversion_report_invalid');
    const conversion = conversionSchema.parse(JSON.parse(await readFile(report, 'utf8')));
    await verifySource(source, signal);
    return {model: output, conversion, process: result};
  } catch (error) {
    if (error instanceof Error && 'code' in error && unprovenExitCodes.has(String(error.code))) safeToClean = false;
    throw error;
  } finally {if (safeToClean) await rm(cache, {recursive: true});}
}
