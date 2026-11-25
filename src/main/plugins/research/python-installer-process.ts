import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import pin from '../../../../resources/research-runtime/python-tools.lock.json';
import { acquireResearchUtility } from './process-runner';
import { ResearchProcessError, runSupervisedResearchProcess, type ProcessSupervisionResult } from './process-supervision';

/** Main-process-only inputs, assembled from validated project declarations and pinned tools.
 * The caller validates managed runtime inventory and existing venv controls/code
 * before entry: uv's fixed -I -B interpreter query imports site (there is no -S).
 * Renderer/agent payloads must never supply command, args, paths or environment.
 */
export type PythonInstallerProcessRequest = {
  command: string;
  args: readonly string[];
  cwd: string;
  readablePaths: readonly string[];
  writablePaths: readonly string[];
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  projectId: string;
  network: 'registry' | 'none';
  timeoutMs?: number;
  pythonExecutable?: string;
  managedPythonRoot: string;
};

const writeBudget = { maxFileBytes: 512 * 1024 ** 2, maxTotalBytes: 8 * 1024 ** 3, maxFiles: 150_000, maxEntries: 200_000 };
type InstallerWriteBudget = typeof writeBudget;
type InstallerOperation = 'version' | 'install' | 'venv' | 'lock' | 'sync' | 'probe';
const registry = 'https://pypi.org/simple';

function inside(root: string, path: string): boolean {
  const name = relative(root, path);
  return name === '' || (!isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`));
}

async function directory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('research_python_installer_absolute_path_required');
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('research_python_installer_directory_invalid');
  return await realpath(path);
}

async function assertEmptyVenv(cwd: string): Promise<void> {
  const path = join(cwd, '.venv');
  await directory(path);
  for await (const _entry of await opendir(path)) {
    // uv may replace an existing venv even without --clear. Only the caller's
    // newly and exclusively created empty directory is a valid creation target.
    throw new Error('research_python_installer_venv_not_empty');
  }
}

async function verifyExecutable(path: string, expectedPath: string, expected: { size: number; sha256: string }): Promise<string> {
  if (!isAbsolute(path) || await realpath(path) !== expectedPath) throw new Error('research_python_installer_executable_invalid');
  const before = await lstat(expectedPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== expected.size || (before.mode & 0o111) === 0) {
    throw new Error('research_python_installer_executable_invalid');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(expectedPath)) hash.update(chunk);
  const after = await lstat(expectedPath);
  if (hash.digest('hex') !== expected.sha256 || before.ino !== after.ino || before.dev !== after.dev
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('research_python_installer_executable_changed');
  return expectedPath;
}

/** The installer allows venv/cache links only into its explicit managed or writable roots. */
async function assertInstallerWriteLimits(paths: readonly string[], managedPythonRoot: string, budget: InstallerWriteBudget = writeBudget): Promise<void> {
  const roots = await Promise.all(paths.map(directory));
  const managed = await directory(managedPythonRoot);
  const targets = [managed, ...roots];
  for (const root of roots) {
    const stack = [root];
    let entries = 0, files = 0, bytes = 0;
    while (stack.length > 0) {
      const current = stack.pop()!;
      try {
        if (!inside(root, await realpath(current)) || !(await lstat(current)).isDirectory()) {
          throw new Error('research_python_installer_write_directory_changed');
        }
        for await (const entry of await opendir(current)) {
          if (++entries > budget.maxEntries) throw new Error('research_python_installer_write_entry_limit');
          const path = join(current, entry.name);
          let info;
          try { info = await lstat(path); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
          if (info.isSymbolicLink()) {
            const target = await realpath(path);
            if (!targets.some(allowed => inside(allowed, target))) throw new Error('research_python_installer_write_symlink_escape');
          } else if (info.isDirectory()) stack.push(path);
          else if (info.isFile()) {
            files += 1;
            bytes += info.size;
            if (info.nlink !== 1 || !Number.isSafeInteger(bytes) || files > budget.maxFiles
              || info.size > budget.maxFileBytes || bytes > budget.maxTotalBytes) throw new Error('research_python_installer_write_limit');
          } else throw new Error('research_python_installer_write_entry_invalid');
        }
      } catch (error) {
        // uv atomically publishes/removes extracted directories during a scan.
        // Only a disappeared directory is harmless; dangling links still fail.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || current === root) throw error;
        try { await lstat(current); }
        catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') continue; throw missing; }
        throw error;
      }
    }
  }
}

function parseOptions(args: readonly string[], booleans: readonly string[], values: readonly string[]): { flags: Set<string>; options: Map<string, string>; positional: string[] } {
  const flags = new Set<string>(), options = new Map<string, string>(), positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (booleans.includes(arg) && !flags.has(arg)) flags.add(arg);
    else if (values.includes(arg) && !options.has(arg) && args[index + 1] !== undefined && !args[index + 1]!.startsWith('-')) {
      options.set(arg, args[++index]!);
    } else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error('research_python_installer_arguments_invalid');
  }
  return { flags, options, positional };
}

function requiredFlags(flags: Set<string>, required: readonly string[]): void {
  if (!required.every(flag => flags.has(flag))) throw new Error('research_python_installer_arguments_invalid');
}

async function validateArguments(request: PythonInstallerProcessRequest, command: string, managed: string, cache: string, cwd: string,
  python: string | undefined): Promise<{ operation: InstallerOperation; args: string[] }> {
  const args = [...request.args];
  if (args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('research_python_installer_arguments_invalid');
  if (command === python) {
    if (request.network !== 'none' || args.slice(0, 6).join('\0') !== ['-I', '-S', '-B', '-X', 'utf8', '-c'].join('\0')
      || !args[6] || args[6].length > 1024 ** 2) throw new Error('research_python_installer_probe_invalid');
    return { operation: 'probe', args };
  }
  if (args.length === 1 && args[0] === '--version') {
    if (request.network !== 'none') throw new Error('research_python_installer_network_invalid');
    return { operation: 'version', args };
  }
  if (args[0] === 'python' && args[1] === 'install') {
    const { flags, options, positional } = parseOptions(args.slice(2), ['--no-bin', '--no-config', '--offline'], ['--install-dir', '--python-downloads-json-url']);
    requiredFlags(flags, ['--no-bin', '--no-config', '--offline']);
    const source = options.get('--python-downloads-json-url');
    if (request.network !== 'none' || positional.length !== 1 || positional[0] !== pin.python.key
      || options.get('--install-dir') !== managed || !source || !source.startsWith('file:')) throw new Error('research_python_installer_arguments_invalid');
    const sourcePath = await realpath(fileURLToPath(source));
    if (!inside(join(dirname(managed), 'jobs'), sourcePath)) throw new Error('research_python_installer_download_source_invalid');
    return { operation: 'install', args };
  }
  if (args[0] === 'venv') {
    const { flags, options, positional } = parseOptions(args.slice(1), ['--no-project', '--no-config', '--no-python-downloads', '--offline'], ['--python', '--cache-dir']);
    requiredFlags(flags, ['--no-project', '--no-config', '--no-python-downloads']);
    if (request.network !== 'none' || python === undefined || options.get('--python') !== pin.python.key || positional.length !== 1
      || positional[0] !== join(cwd, '.venv') || (options.has('--cache-dir') && options.get('--cache-dir') !== cache)) {
      throw new Error('research_python_installer_arguments_invalid');
    }
    return { operation: 'venv', args };
  }
  if (args[0] !== 'lock' && args[0] !== 'sync') throw new Error('research_python_installer_operation_invalid');
  const operation = args[0];
  const common = ['--no-build', '--no-config', '--no-python-downloads'];
  const sync = ['--locked', '--no-install-project', '--no-install-workspace', '--no-default-groups'];
  const { flags, options, positional } = parseOptions(args.slice(1), [...common, ...(operation === 'sync' ? [...sync, '--check'] : []), '--offline'],
    ['--python', '--project', '--cache-dir', '--default-index', '--keyring-provider', ...(operation === 'sync' ? ['--link-mode'] : [])]);
  requiredFlags(flags, [...common, ...(operation === 'sync' ? sync : [])]);
  if (positional.length !== 0 || python === undefined || options.get('--python') !== pin.python.key || options.get('--project') !== cwd
    || (options.has('--cache-dir') && options.get('--cache-dir') !== cache)
    || (options.has('--default-index') && options.get('--default-index') !== registry)
    || (options.has('--keyring-provider') && options.get('--keyring-provider') !== 'disabled')
    || (operation === 'sync' && options.get('--link-mode') !== 'copy')
    || (flags.has('--offline') !== (request.network === 'none')) || (flags.has('--check') && !flags.has('--offline'))) {
    throw new Error('research_python_installer_arguments_invalid');
  }
  if (operation === 'lock' && !inside(join(dirname(managed), 'jobs'), cwd)) throw new Error('research_python_installer_lock_directory_invalid');
  // Seatbelt controls network availability, not domains. Registry URLs and dependency
  // sources are separately validated by the project service; uv's index is fixed here.
  if (!options.has('--default-index')) args.push('--default-index', registry);
  if (!options.has('--keyring-provider')) args.push('--keyring-provider', 'disabled');
  return { operation, args };
}

async function installerProfile(command: string, python: string | undefined, readable: readonly string[], writable: readonly string[], network: 'registry' | 'none', operation: InstallerOperation): Promise<string> {
  const filter = async (path: string): Promise<string> => {
    if (!isAbsolute(path)) throw new Error('research_python_installer_absolute_path_required');
    const resolved = await realpath(path);
    return `(${(await stat(resolved)).isDirectory() ? 'subpath' : 'literal'} ${JSON.stringify(resolved)})`;
  };
  const reads = await Promise.all([...new Set(['/usr/lib', '/System/Library', command, ...(python === undefined ? [] : [python]), ...readable])].map(filter));
  const writes = await Promise.all(writable.map(filter));
  const executables = [...new Set([command, ...(python === undefined ? [] : [python])])].map(path => `(literal ${JSON.stringify(path)})`);
  return [
    '(version 1)', '(deny default)', '(import "system.sb")',
    '(allow mach-bootstrap)', '(allow syscall*)', '(allow process-fork)',
    // Only pinned uv's interpreter discovery needs posix_spawn. Probes and all
    // ordinary experiment processes still deny it; no user code runs via uv.
    operation === 'venv' || operation === 'lock' || operation === 'sync'
      ? '(deny syscall-unix (syscall-number 82 147))' : '(deny syscall-unix (syscall-number 82 147 244))',
    `(allow process-exec ${executables.join(' ')})`, '(allow signal (target self) (target children))',
    '(allow mach-lookup)', '(allow sysctl-read)', '(allow file-read-metadata)',
    `(allow file-read* ${[...reads, ...writes].join(' ')})`, `(allow file-map-executable ${reads.join(' ')})`,
    ...(writes.length === 0 ? [] : [`(allow file-write* ${writes.join(' ')})`]),
    '(deny file-write-create (subpath "/cores"))', '(allow ipc-posix-shm)', '(allow ipc-posix-sem)',
    ...(network === 'registry' ? ['(allow network-outbound)'] : [])
  ].join('\n');
}

export async function runPythonInstallerProcess(request: PythonInstallerProcessRequest): Promise<ProcessSupervisionResult> {
  if (request.network !== 'none' && request.network !== 'registry') throw new Error('research_python_installer_network_invalid');
  if (request.signal?.aborted) throw new ResearchProcessError('research_process_cancelled');
  const managed = await directory(request.managedPythonRoot), root = dirname(managed), cwd = await directory(request.cwd);
  if (request.managedPythonRoot !== managed) throw new Error('research_python_installer_directory_invalid');
  const cache = await directory(join(root, 'cache'));
  const expectedPython = join(managed, pin.python.key, pin.python.executable.path);
  const python = request.pythonExecutable === undefined ? undefined : await verifyExecutable(request.pythonExecutable, expectedPython, pin.python.executable);
  const command = request.command === request.pythonExecutable && python !== undefined ? python
    : await verifyExecutable(request.command, join(root, 'tools', `uv-${pin.uv.version}`, 'uv'), { size: pin.uv.binarySize, sha256: pin.uv.binarySha256 });
  const { operation, args } = await validateArguments(request, command, managed, cache, cwd, python);
  if (operation === 'venv') await assertEmptyVenv(cwd);
  const writable = await Promise.all(request.writablePaths.map(directory));
  if (new Set(writable).size !== writable.length || writable.some(path =>
    !inside(join(root, 'jobs'), path) && path !== cache && !(path === managed && operation === 'install')
      && !(path === join(cwd, '.venv') && (operation === 'venv' || operation === 'sync')))) {
    throw new Error('research_python_installer_write_path_invalid');
  }
  const allowedEnvironment = new Set(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_PYTHON_INSTALL_BIN', 'UV_PYTHON_DOWNLOADS']);
  if (Object.keys(request.environment).some(key => !allowedEnvironment.has(key)) || request.environment.PATH !== '/usr/bin:/bin'
    || request.environment.LANG !== 'en_US.UTF-8' || (request.environment.LC_ALL !== undefined && request.environment.LC_ALL !== 'en_US.UTF-8')
    || request.environment.UV_CACHE_DIR !== cache || request.environment.UV_PYTHON_INSTALL_DIR !== managed
    || request.environment.UV_PYTHON_INSTALL_BIN !== '0'
    || (request.environment.UV_PYTHON_DOWNLOADS !== undefined && request.environment.UV_PYTHON_DOWNLOADS !== 'never')
    || !request.environment.TMPDIR || !writable.some(path => inside(path, request.environment.TMPDIR!))) {
    throw new Error('research_python_installer_environment_invalid');
  }
  const temporary = await directory(request.environment.TMPDIR);
  if (!writable.some(path => inside(path, temporary))) throw new Error('research_python_installer_environment_invalid');
  const environment: NodeJS.ProcessEnv = { ...request.environment, TMPDIR: temporary, UV_NO_CONFIG: '1', UV_NO_PROGRESS: '1', UV_KEYRING_PROVIDER: 'disabled',
    ...(operation === 'install' ? {} : { UV_PYTHON_DOWNLOADS: 'never' }) };
  const signal = request.signal ?? new AbortController().signal;
  const lease = await acquireResearchUtility(request.projectId, signal);
  try {
    return await runSupervisedResearchProcess({ command, args, cwd, environment, signal, timeoutMs: request.timeoutMs ?? 600_000,
      resourceLimits: { mode: 'monitored', cpuTimeMs: 300_000, maxResidentBytes: 2 * 1024 ** 3 }, maxOutputBytes: 4 * 1024 ** 2,
      prepareProfile: async () => {
        if (operation === 'venv') await assertEmptyVenv(cwd);
        // Admission can wait behind another task. Recheck executable bytes after
        // that wait, immediately before the supervisor launches pinned code.
        await verifyExecutable(command, command, operation === 'probe' ? pin.python.executable
          : { size: pin.uv.binarySize, sha256: pin.uv.binarySha256 });
        if (python !== undefined && python !== command) await verifyExecutable(python, expectedPython, pin.python.executable);
        return await installerProfile(command, python, request.readablePaths, writable, request.network, operation);
      },
      auditWrites: () => assertInstallerWriteLimits(writable, managed) });
  } catch (error) {
    if (error instanceof ResearchProcessError && (error.code === 'research_process_kill_failed' || error.code === 'research_process_supervision_failed')) lease.quarantine();
    throw error;
  } finally {
    lease.release();
  }
}
