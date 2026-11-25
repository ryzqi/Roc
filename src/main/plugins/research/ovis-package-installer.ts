import {hasUnprovenResearchProcessExit} from './process-exit-state';
import {lstat, mkdir, opendir, readFile, readdir, realpath} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, sep} from 'node:path';
import {release} from 'node:os';
import {z} from 'zod';
import pin from '../../../../resources/research-runtime/python-tools.lock.json';
import wheels from '../../../../resources/ovis-downloads/wheels.lock.json';
import {fileSha256} from '../../../../scripts/research/download-asset';
import {acquireResearchUtility} from './process-runner';
import {runSupervisedResearchProcess, type ProcessSupervisionResult} from './process-supervision';
import {verifyOvisRequirementsFile} from './ovis-downloads';
import type {ManagedPythonRuntime} from './python-runtime-store';

type Input = {runtime: ManagedPythonRuntime; destination: string; wheelhouse: string; requirements: string;
  signal: AbortSignal; projectId: string; onPhase?: (phase: 'creating_runtime' | 'installing_wheels' | 'verifying') => void};
type Installed = {runtime: string; packages: Record<string, string>; operations: ProcessSupervisionResult[]};
const expectedPackages = Object.fromEntries(wheels.wheels.map(wheel => [wheel.name, wheel.version]));
const inside = (root: string, path: string): boolean => {
  const name = relative(root, path);
  return name === '' || (!isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`));
};

async function directory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('research_ovis_package_absolute_path_required');
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error('research_ovis_package_directory_invalid');
  }
}

async function file(path: string, size: number, sha256: string, signal: AbortSignal): Promise<void> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== size ||
      await fileSha256(path, signal) !== sha256) throw new Error('research_ovis_package_integrity_failed');
  const after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs || before.size !== after.size) throw new Error('research_ovis_package_changed');
}

/** uv creates interpreter/cache links; only this attempt and its verified Python
 * base are permitted targets. The ordinary research process policy is unchanged. */
async function audit(root: string, base: string): Promise<void> {
  await directory(root);
  let bytes = 0, entries = 0;
  const visit = async (path: string): Promise<void> => {
    for await (const item of await opendir(path)) {
      if (++entries > 100_000) throw new Error('research_ovis_package_write_limit');
      const child = join(path, item.name);
      let info;
      try {info = await lstat(child);} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error;}
      if (info.isSymbolicLink()) {
        const target = await realpath(child);
        if (!inside(root, target) && !inside(base, target)) throw new Error('research_ovis_package_link_escape');
      } else if (info.isDirectory()) {
        if (!inside(root, await realpath(child))) throw new Error('research_ovis_package_directory_invalid');
        try {await visit(child);} catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          // Only a directory removed by uv is harmless; a dangling descendant
          // in a still-present directory must fail the write audit.
          try {await lstat(child);} catch (missing) {
            if ((missing as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw missing;
          }
          throw error;
        }
      } else if (info.isFile() && info.nlink === 1) {
        bytes += info.size;
        if (info.size > 512 * 1024 ** 2 || bytes > 3 * 1024 ** 3) throw new Error('research_ovis_package_write_limit');
      } else throw new Error('research_ovis_package_file_invalid');
    }
  };
  await visit(root);
}

const metadataProbe = `import importlib.metadata,json,re,sys
packages={}
for d in importlib.metadata.distributions(path=[sys.argv[1]]):
    name=re.sub(r'[-_.]+','-',d.metadata['Name']).lower()
    if name in packages: raise RuntimeError('duplicate distribution')
    packages[name]=d.version
print(json.dumps(dict(sorted(packages.items()))))
`;

/** Installs the exact 67 downloaded wheels into one new empty private directory.
 * The caller supplies a fully verified ManagedPythonRuntime, owns the destination
 * throughout, and retains it if process termination cannot be proven. No arbitrary
 * arguments, dependency resolution, network, user startup hooks or build scripts. */
export async function installOvisPackages(input: Input,
  supervise: typeof runSupervisedResearchProcess = runSupervisedResearchProcess): Promise<Installed> {
  input.signal.throwIfAborted();
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('research_ovis_platform_unsupported');
  if (Number.parseInt(release().split('.')[0], 10) < 24) throw new Error('research_ovis_macos_15_required');
  const {runtime, destination, wheelhouse, requirements, signal} = input;
  const managed = runtime.managedPythonRoot, base = join(managed, pin.python.key);
  if (runtime.version !== pin.python.version || runtime.pythonKey !== pin.python.key || runtime.prefix !== base ||
      runtime.executable !== join(base, pin.python.executable.path) || runtime.uvHash !== pin.uv.binarySha256 ||
      runtime.uv !== join(dirname(managed), 'tools', `uv-${pin.uv.version}`, 'uv')) throw new Error('research_ovis_package_runtime_invalid');
  await Promise.all([directory(destination), directory(wheelhouse), directory(base)]);
  if ((await readdir(destination)).length !== 0 || inside(destination, wheelhouse) || inside(destination, requirements) ||
      inside(base, destination) || inside(destination, base)) throw new Error('research_ovis_package_destination_invalid');
  const validateTools = async (): Promise<void> => {
    await file(runtime.uv, pin.uv.binarySize, pin.uv.binarySha256, signal);
    await file(runtime.executable, pin.python.executable.size, pin.python.executable.sha256, signal);
    await verifyOvisRequirementsFile(requirements);
  };
  await validateTools();
  const names = await readdir(wheelhouse);
  if (names.length !== wheels.wheels.length || names.some(name => !wheels.wheels.some(wheel => wheel.filename === name))) {
    throw new Error('research_ovis_wheelhouse_invalid');
  }
  for (const wheel of wheels.wheels) await file(join(wheelhouse, wheel.filename), wheel.size, wheel.sha256, signal);
  const target = join(destination, 'runtime'), scratch = join(destination, 'scratch'), cache = join(scratch, 'uv');
  await mkdir(scratch, {mode: 0o700}); await mkdir(cache, {mode: 0o700});
  const operations: ProcessSupervisionResult[] = [];
  const profile = (command: string, uvProbe: boolean): string => {
    const reads = [base, destination, wheelhouse].map(path => `(subpath ${JSON.stringify(path)})`);
    reads.push(`(literal ${JSON.stringify(runtime.uv)})`, `(literal ${JSON.stringify(requirements)})`,
      `(literal ${JSON.stringify(managed)})`,
      '(subpath "/usr/lib")', '(subpath "/System/Library")');
    return ['(version 1)', '(deny default)', '(import "system.sb")', '(allow mach-bootstrap)', '(allow syscall*)',
      '(allow process-fork)', `(deny syscall-unix (syscall-number 82 147${uvProbe ? '' : ' 244'}))`,
      `(allow process-exec (literal ${JSON.stringify(command)}) (literal ${JSON.stringify(runtime.executable)}))`,
      '(allow signal (target self) (target children))', '(allow mach-lookup)', '(allow sysctl-read)', '(allow file-read-metadata)',
      `(allow file-read* ${reads.join(' ')})`, `(allow file-map-executable ${reads.join(' ')})`,
      `(allow file-write* (subpath ${JSON.stringify(destination)}))`, '(deny file-write-create (subpath "/cores"))',
      '(allow ipc-posix-shm)', '(allow ipc-posix-sem)'].join('\n');
  };
  const lease = await acquireResearchUtility(input.projectId, signal);
  const run = async (command: string, args: string[], uvProbe: boolean): Promise<ProcessSupervisionResult> => {
    const result = await supervise({command, args, cwd: destination, signal, timeoutMs: 600_000,
      environment: {PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: scratch, UV_CACHE_DIR: cache,
        UV_PYTHON_INSTALL_DIR: managed, UV_PYTHON_DOWNLOADS: 'never', UV_PYTHON_INSTALL_BIN: '0',
        UV_NO_CONFIG: '1', UV_NO_PROGRESS: '1', UV_OFFLINE: '1', UV_KEYRING_PROVIDER: 'disabled'},
      resourceLimits: {mode: 'monitored', cpuTimeMs: 300_000, maxResidentBytes: 2 * 1024 ** 3}, maxOutputBytes: 2 * 1024 ** 2,
      prepareProfile: async () => {await validateTools(); return profile(command, uvProbe);}, auditWrites: () => audit(destination, base)});
    operations.push(result);
    if (result.exitCode !== 0) throw new Error('research_ovis_package_install_failed', {cause: result});
    return result;
  };
  try {
    input.onPhase?.('creating_runtime');
    await run(runtime.uv, ['venv', '--no-project', '--no-config', '--no-python-downloads', '--offline', '--relocatable',
      '--python', pin.python.key, target], true);
    const site = join(target, 'lib/python3.14/site-packages');
    await directory(target); await directory(site);
    if (await realpath(join(target, 'bin/python')) !== runtime.executable || (await readdir(site)).length !== 0) {
      throw new Error('research_ovis_package_venv_invalid');
    }
    input.onPhase?.('installing_wheels');
    await run(runtime.uv, ['pip', 'sync', '--no-config', '--no-python-downloads', '--offline', '--no-index',
      '--find-links', wheelhouse, '--python', join(target, 'bin/python'), '--require-hashes', '--only-binary', ':all:',
      '--link-mode', 'copy', '--strict', requirements], true);
    input.onPhase?.('verifying');
    const result = await run(runtime.executable, ['-I', '-S', '-B', '-X', 'utf8', '-c', metadataProbe, site], false);
    const packages = z.record(z.string(), z.string()).parse(JSON.parse(result.stdout));
    if (Object.keys(packages).length !== wheels.wheels.length || Object.entries(expectedPackages).some(([name, version]) => packages[name] !== version)) {
      throw new Error('research_ovis_package_versions_changed');
    }
    const config = await readFile(join(target, 'pyvenv.cfg'), 'utf8');
    if (!config.includes('version_info = 3.14.10') || !config.includes('include-system-site-packages = false')) {
      throw new Error('research_ovis_package_venv_invalid');
    }
    signal.throwIfAborted();
    return {runtime: target, packages, operations};
  } catch (error) {
    if (hasUnprovenResearchProcessExit(error)) lease.quarantine();
    throw error;
  } finally {lease.release();}
}
