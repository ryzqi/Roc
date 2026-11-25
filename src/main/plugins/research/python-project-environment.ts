import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureNativeCode } from './experiment-native-code';
import { discoverPythonEnvironmentControls } from './experiment-python-controls';
import { inspectPythonExperimentEnvironment, pythonExperimentFlags, type InspectedPythonEnvironment } from './experiment-python-probe';
import { runPythonInstallerProcess } from './python-installer-process';
import { pythonProjectValidation, readPythonProjectFiles } from './python-project-declarations';
import { defaultProjectPythonVersion, ResearchPythonRuntimeStore, type ManagedPythonRuntime } from './python-runtime-store';
import { ResearchProcessError, runResearchProcess } from './process-runner';
import { readResearchFile, researchContentHash } from './research-files';

type Input = { workspace: string; projectId: string; rootPath: string; signal: AbortSignal; onPhase: (phase: string) => void;
  previousCodeHash?: string };
type Dependencies = { store?: ResearchPythonRuntimeStore; run?: typeof runPythonInstallerProcess };
type CreatedFile = { path: string; ino: number; dev: number; hash: string };
const declarations = ['pyproject.toml', '.python-version'] as const;

async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function sameDeclarations(workspace: string, expected: readonly Buffer[]): Promise<void> {
  for (const [index, path] of declarations.entries()) {
    if (!(await readResearchFile(workspace, path, 4 * 1024 ** 2)).equals(expected[index]!)) {
      throw new Error('research_python_project_changed');
    }
  }
}

/** uv's own isolated interpreter query loads site; exclude hooks before giving it a venv. */
async function preflightVenv(venv: string, runtime: ManagedPythonRuntime, signal: AbortSignal): Promise<string> {
  const info = await lstat(venv);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(venv) !== venv) throw new Error('research_python_venv_invalid');
  const controls = await discoverPythonEnvironmentControls(join(venv, 'bin/python'), signal);
  if (controls.prefix !== venv || controls.basePrefix !== runtime.prefix || controls.executable !== runtime.executable) {
    throw new Error('research_python_venv_runtime_mismatch');
  }
  // This also rejects links outside the declared venv/runtime code roots.
  const code = await captureNativeCode(controls.codeRoots, signal);
  for (const directory of [controls.packagePath, join(runtime.prefix, 'lib/python3.14'), join(runtime.prefix, 'lib/python3.14/site-packages')]) {
    for (const name of await readdir(directory)) {
      signal.throwIfAborted();
      if (/\.(?:pth|egg-link|egg|egg-info)$/iu.test(name) || /^(?:sitecustomize|usercustomize)(?:\.|$)/iu.test(name)) {
        throw new Error('research_python_startup_hook_unsupported');
      }
    }
  }
  return code.hash;
}

/** The service holds the workspace write lease throughout this operation. */
export async function prepareProjectPythonEnvironment(input: Input, dependencies: Dependencies = {}): Promise<{
  inspected: InspectedPythonEnvironment; runtime: ManagedPythonRuntime;
}> {
  const { signal, projectId, onPhase } = input;
  signal.throwIfAborted();
  onPhase('validating');
  const workspace = await realpath(input.workspace), identity = await lstat(workspace);
  if (!identity.isDirectory()) throw new Error('research_workspace_directory_required');
  const assertWorkspace = async (): Promise<void> => {
    signal.throwIfAborted();
    const current = await lstat(workspace);
    if (await realpath(input.workspace) !== workspace || current.ino !== identity.ino || current.dev !== identity.dev) {
      throw new Error('research_python_workspace_changed');
    }
  };
  const created: CreatedFile[] = [];
  let job: string | undefined, ownedVenv: { ino: number; dev: number } | undefined, completed = false, safeToClean = true;
  const venv = join(workspace, '.venv');
  const createFile = async (path: string, bytes: Buffer): Promise<void> => {
    await assertWorkspace();
    await writeFile(join(workspace, path), bytes, { flag: 'wx', mode: 0o600 });
    const stat = await lstat(join(workspace, path));
    created.push({ path, ino: stat.ino, dev: stat.dev, hash: researchContentHash(bytes) });
  };
  try {
    if (!(await present(join(workspace, 'pyproject.toml')))) {
      await createFile('pyproject.toml', Buffer.from('[project]\nname = "roc-research-project"\nversion = "0.1.0"\nrequires-python = ">=3.14,<3.15"\ndependencies = []\n'));
    }
    if (!(await present(join(workspace, '.python-version')))) await createFile('.python-version', Buffer.from(`${defaultProjectPythonVersion}\n`));
    const initial = await Promise.all(declarations.map(path => readResearchFile(workspace, path, path === '.python-version' ? 128 : 4 * 1024 ** 2)));
    const version = initial[1]!.toString('utf8').trim();
    if (!/^3\.14\.(?:0|[1-9][0-9]*)$/u.test(version)) throw new Error('research_python_project_pin_invalid');
    const hadLock = await present(join(workspace, 'uv.lock'));
    const existingLock = hadLock ? await readResearchFile(workspace, 'uv.lock', 4 * 1024 ** 2) : null;
    const store = dependencies.store ?? new ResearchPythonRuntimeStore(input.rootPath);
    const runtime = await store.prepare(version, projectId, signal, onPhase);
    await assertWorkspace();
    const existed = await present(venv);
    let expectedCodeHash: string | undefined;
    if (existed) {
      const codeHash = await preflightVenv(venv, runtime, signal);
      if (input.previousCodeHash !== undefined && codeHash !== input.previousCodeHash) throw new Error('research_python_environment_changed');
      expectedCodeHash = codeHash;
    }
    job = await mkdtemp(join(runtime.jobs, 'project-'));
    const scratch = join(job, 'scratch'), staging = join(job, 'project');
    await mkdir(scratch); await mkdir(staging);
    for (const [index, path] of declarations.entries()) await writeFile(join(staging, path), initial[index]!, { flag: 'wx', mode: 0o600 });
    if (existingLock !== null) await writeFile(join(staging, 'uv.lock'), existingLock, { flag: 'wx', mode: 0o600 });
    const environment = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: scratch, UV_CACHE_DIR: runtime.cache,
      UV_PYTHON_INSTALL_DIR: runtime.managedPythonRoot, UV_PYTHON_INSTALL_BIN: '0' };
    const run = dependencies.run ?? runPythonInstallerProcess;
    const command = async (args: string[], cwd: string, writablePaths: string[], network: 'registry' | 'none', python = false): Promise<void> => {
      await assertWorkspace();
      if (JSON.stringify(await store.prepare(version, projectId, signal)) !== JSON.stringify(runtime)) throw new Error('research_python_runtime_changed');
      if (!python && args[0] === 'sync') {
        const codeHash = await preflightVenv(venv, runtime, signal);
        if (expectedCodeHash !== undefined && codeHash !== expectedCodeHash) throw new Error('research_python_environment_changed');
      }
      const result = await run({ command: python ? runtime.executable : runtime.uv, args, cwd,
        readablePaths: [runtime.managedPythonRoot, job!, ...(cwd === workspace
          ? [...declarations, 'uv.lock', '.venv'].map(path => join(workspace, path)) : [])], writablePaths,
        environment, signal, projectId, network, managedPythonRoot: runtime.managedPythonRoot, pythonExecutable: runtime.executable });
      // A synchronization may install some wheels before reporting a cache miss.
      // Bind its resulting code before a controlled retry; checks never rebind it.
      if (!python && args[0] === 'sync' && !args.includes('--check')) expectedCodeHash = await preflightVenv(venv, runtime, signal);
      if (result.exitCode !== 0) {
        const code = /research_python_[a-z_]+/u.exec(result.stderr)?.[0] ?? 'research_python_preparation_process_failed';
        throw new ResearchProcessError(code, result.stdout, result.stderr, result.resourceUsage);
      }
      await assertWorkspace();
      await sameDeclarations(workspace, initial);
    };
    const validate = async (lock: boolean): Promise<void> => command([...pythonExperimentFlags, '-c',
      `${pythonProjectValidation}\nimport sys\nproject_declarations(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)`,
      join(staging, 'pyproject.toml'), ...(lock ? [join(staging, 'uv.lock')] : [])], staging, [scratch], 'none', true);
    const tryOffline = async (args: string[], cwd: string, writablePaths: string[]): Promise<boolean> => {
      try { await command([...args, '--offline'], cwd, writablePaths, 'none'); return true; }
      catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof ResearchProcessError) || error.code !== 'research_python_preparation_process_failed') throw error;
        return false;
      }
    };
    await validate(hadLock);
    const common = ['--python', runtime.pythonKey, '--no-build', '--no-config', '--no-python-downloads'];
    if (!hadLock) {
      onPhase('resolving');
      const lock = ['lock', ...common, '--project', staging], writes = [staging, runtime.cache, scratch];
      if (!await tryOffline(lock, staging, writes)) await command(lock, staging, writes, 'registry');
      await validate(true);
      const lockBytes = await readResearchFile(staging, 'uv.lock', 4 * 1024 ** 2);
      await sameDeclarations(workspace, initial);
      await createFile('uv.lock', lockBytes);
    }
    const frozen = await readPythonProjectFiles(workspace);
    if (existingLock !== null && frozen.files.find(file => file.path === 'uv.lock')?.sha256 !== researchContentHash(existingLock)) {
      throw new Error('research_python_lock_changed');
    }
    if (existed) {
      const codeHash = await preflightVenv(venv, runtime, signal);
      if (input.previousCodeHash !== undefined && codeHash !== input.previousCodeHash) throw new Error('research_python_environment_changed');
    } else {
      onPhase('creating_venv');
      await assertWorkspace();
      await mkdir(venv, { mode: 0o700 });
      ownedVenv = await lstat(venv);
      await command(['venv', '--no-project', '--no-config', '--no-python-downloads', '--python', runtime.pythonKey, venv],
        workspace, [venv, runtime.cache, scratch], 'none');
      expectedCodeHash = await preflightVenv(venv, runtime, signal);
    }
    const sync = ['sync', ...common, '--project', workspace, '--locked', '--no-install-project', '--no-install-workspace', '--no-default-groups', '--link-mode', 'copy'];
    // Reuse and repairs from a complete download cache require no network grant.
    const writes = [venv, runtime.cache, scratch];
    // A pre-existing venv with no Roc receipt is not trusted just because its
    // distribution metadata satisfies uv. Restore its wheels from the lock.
    const restore = existed && input.previousCodeHash === undefined;
    const checked = !restore && await tryOffline([...sync, '--check'], workspace, writes);
    if (!checked) {
      onPhase('syncing');
      await preflightVenv(venv, runtime, signal);
      const synchronize = restore ? [...sync, '--reinstall'] : sync;
      if (!await tryOffline(synchronize, workspace, writes)) await command(synchronize, workspace, writes, 'registry');
    }
    onPhase('verifying');
    await preflightVenv(venv, runtime, signal);
    await command([...sync, '--offline', '--check'], workspace, [venv, runtime.cache, scratch], 'none');
    const inspected = await inspectPythonExperimentEnvironment({ workspace, selectedExecutable: join(venv, 'bin/python'),
      jobDir: scratch, signal, admission: { projectId, priority: 'user' }, onProbe: () => {}, run: runResearchProcess });
    if (inspected.code.hash !== expectedCodeHash) throw new Error('research_python_environment_changed');
    await assertWorkspace();
    if (JSON.stringify(await store.prepare(version, projectId, signal)) !== JSON.stringify(runtime)) throw new Error('research_python_runtime_changed');
    if (JSON.stringify(await readPythonProjectFiles(workspace)) !== JSON.stringify(frozen)) throw new Error('research_python_project_changed');
    completed = true;
    return { inspected, runtime };
  } catch (error) {
    if (error instanceof ResearchProcessError && ['research_process_kill_failed',
      'research_process_supervision_failed', 'research_process_completion_failed'].includes(error.code)) safeToClean = false;
    throw error;
  } finally {
    // An unresolved process tree may still be using these files. Preserve the
    // attempt for diagnosis; cancellation with proven cleanup still reclaims it.
    if (job !== undefined && safeToClean) await rm(job, { recursive: true, force: true });
    if (!completed && safeToClean) {
      if (ownedVenv !== undefined) {
        const current = await lstat(venv).catch(() => null);
        if (current?.ino === ownedVenv.ino && current.dev === ownedVenv.dev && current.isDirectory()) await rm(venv, { recursive: true });
      }
      for (const file of created.reverse()) {
        const path = join(workspace, file.path), current = await lstat(path).catch(() => null);
        if (current?.ino === file.ino && current.dev === file.dev && current.isFile() && !current.isSymbolicLink()
          && researchContentHash(await readFile(path)) === file.hash) await rm(path);
      }
    }
  }
}
