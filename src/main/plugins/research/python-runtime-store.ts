import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import pin from '../../../../resources/research-runtime/python-tools.lock.json';
import { downloadVerified, fileSha256 } from '../../../../scripts/research/download-asset';
import { extractToolArchive } from '../../../../scripts/research/archive-utils';
import { researchContentHash } from './research-files';
import { runPythonInstallerProcess } from './python-installer-process';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const entrySchema = z.discriminatedUnion('type', [
  z.strictObject({ path: z.string(), type: z.literal('file'), size: z.number().int().nonnegative(), sha256: digest, mode: z.number().int() }),
  z.strictObject({ path: z.string(), type: z.literal('directory'), mode: z.number().int() }),
  z.strictObject({ path: z.string(), type: z.literal('symlink'), target: z.string() })
]);
const receiptSchema = z.strictObject({ schemaVersion: z.literal(2), specHash: digest,
  prefix: z.string(), version: z.literal('3.14.10'), build: z.literal('20261110'),
  entries: z.array(entrySchema).min(1).max(100_000) });
const specHash = researchContentHash(JSON.stringify(pin));
const prepareQueues = new Map<string, Promise<void>>();

export const defaultProjectPythonVersion = pin.defaultPythonVersion;
export type ManagedPythonRuntime = {
  root: string; uv: string; uvHash: string; version: string; pythonKey: string; executable: string;
  prefix: string; managedPythonRoot: string; cache: string; jobs: string; receiptHash: string;
};
export type PythonRuntimePhase = 'downloading_runtime' | 'verifying';
type ProcessRun = typeof runPythonInstallerProcess;
const receiptName = `python-${pin.python.version}.json`;
const attemptIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function cleanupUnproven(error: unknown): boolean {
  return error instanceof Error && 'code' in error && ['research_process_kill_failed',
    'research_process_supervision_failed', 'research_process_completion_failed'].includes(String(error.code));
}

function runtimeLayout(root: string): Omit<ManagedPythonRuntime, 'receiptHash'> {
  const managedPythonRoot = join(root, 'python'), prefix = join(managedPythonRoot, pin.python.key);
  return { root, uv: join(root, 'tools', `uv-${pin.uv.version}`, 'uv'), uvHash: pin.uv.binarySha256,
    version: pin.python.version, pythonKey: pin.python.key, executable: join(prefix, pin.python.executable.path),
    prefix, managedPythonRoot, cache: join(root, 'cache'), jobs: join(root, 'jobs') };
}

async function verifyUv(uv: string): Promise<void> {
  const stat = await lstat(uv);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== pin.uv.binarySize
    || await fileSha256(uv) !== pin.uv.binarySha256) throw new Error('research_python_uv_integrity_failed');
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function inside(root: string, path: string): boolean {
  const name = relative(root, path);
  return name === '' || (!isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`));
}

async function directory(path: string, canonical = true): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path), actual = await realpath(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (canonical && actual !== path)) {
    throw new Error('research_python_runtime_directory_invalid');
  }
  return actual;
}

async function cancellableWait(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try { await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}

/** Every executable/library byte is checked again before a managed runtime is reused. */
async function inventory(root: string, signal: AbortSignal): Promise<z.infer<typeof entrySchema>[]> {
  const entries: z.infer<typeof entrySchema>[] = [];
  let bytes = 0;
  const visit = async (path: string): Promise<void> => {
    signal.throwIfAborted();
    if (entries.length >= 100_000) throw new Error('research_python_runtime_inventory_limit');
    const stat = await lstat(path), name = relative(root, path).split(sep).join('/');
    if (stat.isSymbolicLink()) {
      if (!inside(root, await realpath(path))) throw new Error('research_python_runtime_symlink_escape');
      entries.push({ path: name, type: 'symlink', target: await readlink(path) });
    } else if (stat.isDirectory()) {
      entries.push({ path: name, type: 'directory', mode: stat.mode & 0o777 });
      for (const child of (await readdir(path)).sort()) await visit(join(path, child));
    } else if (stat.isFile() && stat.nlink === 1) {
      bytes += stat.size;
      if (bytes > 1024 ** 3) throw new Error('research_python_runtime_inventory_limit');
      const hash = await fileSha256(path), after = await lstat(path);
      if (stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) {
        throw new Error('research_python_runtime_changed');
      }
      entries.push({ path: name, type: 'file', size: stat.size, sha256: hash, mode: stat.mode & 0o777 });
    } else throw new Error('research_python_runtime_file_invalid');
  };
  await visit(root);
  return entries;
}

/** Only this store's pinned uv and CPython are installed; no PATH/global uv state is used. */
export class ResearchPythonRuntimeStore {
  constructor(private readonly rootPath: string, private readonly run: ProcessRun = runPythonInstallerProcess,
    private readonly download: typeof downloadVerified = downloadVerified) {}

  async prepare(version: string, projectId: string, signal: AbortSignal,
    phase: (phase: PythonRuntimePhase) => void = () => {}): Promise<ManagedPythonRuntime> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('research_python_runtime_platform_unsupported');
    if (version !== pin.python.version) throw new Error('research_python_runtime_version_unavailable');
    if (!isAbsolute(this.rootPath)) throw new Error('research_python_runtime_absolute_root_required');
    signal.throwIfAborted();
    const root = await directory(this.rootPath, false);
    // Cancellation of one project never cancels a runtime acquisition belonging to another.
    const previous = prepareQueues.get(root) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => gate);
    prepareQueues.set(root, queued);
    void queued.finally(() => { if (prepareQueues.get(root) === queued) prepareQueues.delete(root); });
    try {
      await cancellableWait(previous, signal);
      signal.throwIfAborted();
      return await this.prepareExclusive(root, projectId, signal, phase);
    } finally {
      release();
    }
  }

  private async prepareExclusive(root: string, projectId: string, signal: AbortSignal,
    phase: (phase: PythonRuntimePhase) => void): Promise<ManagedPythonRuntime> {
    const publishedPath = join(root, receiptName);
    const verify = async (attempt: string): Promise<ManagedPythonRuntime> => {
      phase('verifying');
      const value = runtimeLayout(attempt), { uv, prefix, executable } = value;
      const receiptPath = join(attempt, receiptName);
      for (const path of [attempt, value.managedPythonRoot, prefix, value.cache, value.jobs,
        join(attempt, 'tools'), join(attempt, 'tools', `uv-${pin.uv.version}`)]) {
        if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) {
          throw new Error('research_python_runtime_directory_invalid');
        }
      }
      await verifyUv(uv);
      const receiptInfo = await lstat(receiptPath), prefixInfo = await lstat(prefix);
      if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink() || receiptInfo.nlink !== 1
        || receiptInfo.size > 16 * 1024 ** 2 || !prefixInfo.isDirectory() || prefixInfo.isSymbolicLink()) {
        throw new Error('research_python_runtime_receipt_invalid');
      }
      const receiptBytes = await readFile(receiptPath);
      if (receiptBytes.length > 16 * 1024 ** 2) throw new Error('research_python_runtime_receipt_invalid');
      const receipt = receiptSchema.parse(JSON.parse(receiptBytes.toString('utf8')));
      if (receipt.specHash !== specHash || receipt.prefix !== prefix
        || await fileSha256(executable) !== pin.python.executable.sha256
        || JSON.stringify(await inventory(prefix, signal)) !== JSON.stringify(receipt.entries)) {
        throw new Error('research_python_runtime_integrity_failed');
      }
      signal.throwIfAborted();
      return { ...value, receiptHash: researchContentHash(receiptBytes) };
    };
    const published = async (): Promise<ManagedPythonRuntime> => {
      if (!(await lstat(publishedPath)).isSymbolicLink()) throw new Error('research_python_runtime_receipt_invalid');
      const target = await readlink(publishedPath), parts = target.split('/');
      if (parts.length !== 3 || parts[0] !== 'attempts' || !attemptIdPattern.test(parts[1]!) || parts[2] !== receiptName) {
        throw new Error('research_python_runtime_receipt_invalid');
      }
      const verified = await verify(join(root, 'attempts', parts[1]!));
      if (await readlink(publishedPath) !== target) throw new Error('research_python_runtime_changed');
      return verified;
    };
    if (await exists(publishedPath)) return await published();
    const attempts = await directory(join(root, 'attempts'));
    const attemptId = randomUUID(), attempt = join(attempts, attemptId);
    await mkdir(attempt, { mode: 0o700 });
    const identity = await lstat(attempt);
    let retained = false;
    try {
      await writeFile(join(attempt, 'owner.json'), `${JSON.stringify({ schemaVersion: 1, attemptId,
        pid: process.pid, createdAt: new Date().toISOString(), specHash })}\n`, { flag: 'wx', mode: 0o600 });
      await this.install(attempt, projectId, signal, phase);
      const verified = await verify(attempt);
      signal.throwIfAborted();
      // Creation is atomic and never replaces a concurrent publisher. The Python
      // prefix remains at its original absolute path, including after host death.
      try { await symlink(`attempts/${attemptId}/${receiptName}`, publishedPath); retained = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return await published();
      }
      return verified;
    } catch (error) {
      // Uncertain process cleanup is not permission to remove a possibly live tree.
      if (cleanupUnproven(error)) retained = true;
      throw error;
    } finally {
      if (!retained) {
        const current = await lstat(attempt).catch(() => null);
        if (current?.isDirectory() && current.ino === identity.ino && current.dev === identity.dev
          && await realpath(attempt) === attempt) await rm(attempt, { recursive: true });
      }
    }
  }

  private async install(root: string, projectId: string, signal: AbortSignal,
    phase: (phase: PythonRuntimePhase) => void): Promise<void> {
    const { managedPythonRoot, cache, jobs, uv, prefix, executable } = runtimeLayout(root);
    for (const path of [managedPythonRoot, cache, jobs, join(root, 'tools')]) await directory(path);
    const uvRoot = join(root, 'tools', `uv-${pin.uv.version}`), receiptPath = join(root, receiptName);
    let job: string | undefined, jobIdentity: { ino: number; dev: number } | undefined, safeToClean = true;
    try {
      if (await exists(prefix)) throw new Error('research_python_runtime_unverified_directory');
      job = await mkdtemp(join(jobs, 'runtime-'));
      jobIdentity = await lstat(job);
      const jobPath = job;
      const scratch = await directory(join(job, 'scratch'));
      const environment = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: scratch,
        UV_CACHE_DIR: cache, UV_PYTHON_INSTALL_DIR: managedPythonRoot, UV_PYTHON_INSTALL_BIN: '0' };
      const command = async (args: string[], readablePaths: string[], writablePaths: string[]): Promise<string> => {
        await verifyUv(uv);
        const result = await this.run({ command: uv, args, cwd: jobPath, readablePaths, writablePaths,
          environment, signal, projectId, network: 'none', managedPythonRoot, timeoutMs: 120_000 });
        if (result.exitCode !== 0) throw new Error('research_python_runtime_install_failed');
        return result.stdout.trim();
      };
      if (!(await exists(uv))) {
        if (await exists(uvRoot)) throw new Error('research_python_uv_unverified_directory');
        phase('downloading_runtime');
        const archive = join(job, 'uv.tar.gz'), extracted = join(job, 'uv-extracted');
        await this.download(pin.uv.url, pin.uv.sha256, archive, { expectedSize: pin.uv.size, signal });
        signal.throwIfAborted();
        await extractToolArchive(archive, extracted);
        const binary = join(extracted, pin.uv.member);
        if (await fileSha256(binary) !== pin.uv.binarySha256) throw new Error('research_python_uv_integrity_failed');
        await mkdir(uvRoot, { mode: 0o700 });
        await copyFile(binary, uv, constants.COPYFILE_EXCL); await chmod(uv, 0o500); await verifyUv(uv);
      }
      const uvVersion = await command(['--version'], [uvRoot], [scratch]);
      if (!uvVersion.startsWith(`uv ${pin.uv.version} (`)) throw new Error('research_python_uv_version_mismatch');
      phase('downloading_runtime');
      const metadata = Object.values(pin.python.downloads)[0];
      const archive = join(job, 'python.tar.gz');
      await this.download(metadata.url, metadata.sha256, archive, { expectedSize: pin.python.size, signal });
      const downloadFile = join(job, 'downloads.json');
      const downloads = Object.fromEntries(Object.entries(pin.python.downloads)
        .map(([key, value]) => [key, { ...value, url: pathToFileURL(archive).href }]));
      await writeFile(downloadFile, JSON.stringify(downloads), { flag: 'wx', mode: 0o600 });
      signal.throwIfAborted();
      // uv patches sysconfig with absolute paths: this is the final prefix.
      // install_name_tool is deliberately outside the installer's exec allowlist.
      await command(['python', 'install', pin.python.key, '--python-downloads-json-url', pathToFileURL(downloadFile).href,
        '--install-dir', managedPythonRoot, '--no-bin', '--no-config', '--offline'], [job, uvRoot], [managedPythonRoot, cache, scratch]);
      if ((await lstat(executable)).size !== pin.python.executable.size
        || await fileSha256(executable) !== pin.python.executable.sha256
        || (await readFile(join(prefix, 'BUILD'), 'utf8')).trim() !== metadata.build) {
        throw new Error('research_python_runtime_integrity_failed');
      }
      phase('verifying');
      const entries = await inventory(prefix, signal);
      const probe = await this.run({ command: executable,
        args: ['-I', '-S', '-B', '-X', 'utf8', '-c',
          'import json,sys,platform;print(json.dumps([sys.implementation.name,platform.python_version(),sys.platform,platform.machine(),sys.prefix,sys.base_prefix]))'],
        cwd: job, readablePaths: [prefix, job], writablePaths: [scratch], environment, signal, projectId,
        network: 'none', managedPythonRoot, pythonExecutable: executable, timeoutMs: 30_000 });
      if (probe.exitCode !== 0 || JSON.stringify(JSON.parse(probe.stdout)) !==
        JSON.stringify(['cpython', pin.python.version, 'darwin', 'arm64', prefix, prefix])
        || JSON.stringify(await inventory(prefix, signal)) !== JSON.stringify(entries)) {
        throw new Error('research_python_runtime_probe_failed');
      }
      const receipt = receiptSchema.parse({ schemaVersion: 2, specHash, prefix, version: pin.python.version,
        build: metadata.build, entries });
      signal.throwIfAborted();
      const receiptText = `${JSON.stringify(receipt)}\n`;
      await writeFile(receiptPath, receiptText, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      safeToClean = !cleanupUnproven(error);
      throw error;
    } finally {
      if (job !== undefined && jobIdentity !== undefined && safeToClean) {
        const current = await lstat(job).catch(() => null);
        if (current?.isDirectory() && current.ino === jobIdentity.ino && current.dev === jobIdentity.dev
          && await realpath(job) === job) await rm(job, { recursive: true });
      }
    }
  }
}
