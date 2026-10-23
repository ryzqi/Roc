import { lstat, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { researchExperimentEnvironmentSchema, type ResearchExperimentEnvironment, type ResearchExperimentRuntime } from '../../../shared/schemas/research-experiments';
import { assertResearchDescendant, createResearchDirectory, readResearchFile, researchContentHash, researchRelativePath } from './research-files';
import { inspectPythonEnvironment } from './experiment-python';
import { runResearchProcess, ResearchProcessError, type ResearchProcessRequest } from './process-runner';
import type { ResearchToolchain } from './toolchain';
import { inspectNativeExperimentEnvironment } from './experiment-native-environment';

/**
 * 实验环境探测的输出是**子进程**给的，不是本地写入的列：`JSON.parse` 在这里失败是常态
 * （解释器起不来、被信号杀掉、输出被截断），所以必须给领域码而不是让 `SyntaxError`
 * 变成「Roc 内部错误」。
 */
function decodeExperimentReport(stdout: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('research_experiment_report_invalid');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('research_experiment_report_invalid');
  }
  return parsed as Record<string, unknown>;
}

const pythonReportSchema = researchExperimentEnvironmentSchema.omit({ runtime: true, toolchainHash: true, metadataHash: true, lockFiles: true, hash: true })
  .extend({ metadataPaths: z.array(z.string().min(1)).max(10000) });
export type PreparedExperimentEnvironment = {
  snapshot: ResearchExperimentEnvironment; readablePaths: string[]; environment: NodeJS.ProcessEnv; python: string;
};

export class ResearchExperimentEnvironmentService {
  constructor(private readonly tools: Pick<ResearchToolchain, 'experimentRuntime'>,
    private readonly run: (input: ResearchProcessRequest) => ReturnType<typeof runResearchProcess> = runResearchProcess) {}

  async inspect(root: string, runtime: ResearchExperimentRuntime, jobDir: string, signal: AbortSignal): Promise<PreparedExperimentEnvironment> {
    signal.throwIfAborted();
    const tools = await this.tools.experimentRuntime(jobDir);
    if (runtime.kind === 'renv' || runtime.kind === 'julia') return await inspectNativeExperimentEnvironment(root, runtime, jobDir, tools, this.run, signal);
    const config = await createResearchDirectory(jobDir, 'config');
    const environment = { ...tools.environment, XDG_CONFIG_HOME: config, UV_CACHE_DIR: join(jobDir, 'cache/uv'),
      UV_PYTHON_DOWNLOADS: 'never', UV_OFFLINE: '1', UV_NO_PROGRESS: '1', UV_NO_MANAGED_PYTHON: '1' };
    let executable = tools.python;
    const readablePaths = [tools.root];
    const lockFiles: ResearchExperimentEnvironment['lockFiles'] = [];
    let environmentRoot = await realpath(dirname(dirname(executable)));
    const basePython = await realpath(tools.python);
    let venvConfig: Buffer | null = null;
    if (runtime.kind === 'uv') {
      for (const path of ['pyproject.toml', 'uv.lock', 'uv.toml', '.python-version']) {
        try { await lstat(join(root, path)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !['pyproject.toml', 'uv.lock'].includes(path)) continue; throw error; }
        const bytes = await readResearchFile(root, path, 16 * 1024 * 1024);
        lockFiles.push({ path, size: bytes.length, sha256: researchContentHash(bytes) });
      }
      environmentRoot = await realpath(join(root, '.venv'));
      executable = join(environmentRoot, 'bin/python');
      if (await realpath(executable) !== basePython) throw new Error('research_experiment_bundled_python_required');
      venvConfig = await readResearchFile(environmentRoot, 'pyvenv.cfg', 65536);
      if (!/^include-system-site-packages\s*=\s*false\s*$/mu.test(venvConfig.toString('utf8'))) throw new Error('research_experiment_isolated_environment_required');
      readablePaths.push(environmentRoot);
    }
    const probeRoot = await mkdtemp(join(jobDir, 'python-probe-'));
    let result;
    try {
      const probeEnvironment = (await this.tools.experimentRuntime(probeRoot)).environment;
      result = await this.run({ command: executable, args: ['-I', '-B', '-c', inspectPythonEnvironment],
        cwd: probeRoot, readablePaths, writablePaths: [probeRoot], environment: probeEnvironment, timeoutMs: 30000, signal, allowGpuAcceleration: false, networkAccess: 'none', allowPosixSpawn: false });
    } finally { await rm(probeRoot, { recursive: true, force: true }); }
    if (result.exitCode !== 0) throw new ResearchProcessError('research_experiment_environment_probe_failed', result.stdout, result.stderr);
    const { metadataPaths, ...report } = pythonReportSchema.parse(decodeExperimentReport(result.stdout));
    if (await realpath(report.prefix) !== environmentRoot || await realpath(report.basePrefix) !== dirname(dirname(basePython))
        || await realpath(report.executable) !== basePython || report.version !== tools.pythonVersion) throw new Error('research_experiment_python_environment_invalid');
    let metadataHash = tools.hash;
    if (runtime.kind === 'uv') {
      if (venvConfig === null) throw new Error('research_experiment_python_environment_invalid');
      const checkRoot = await mkdtemp(join(jobDir, 'uv-check-'));
      try {
        const copied = await copyEnvironmentMetadata(environmentRoot, checkRoot, metadataPaths, tools.pythonVersion, basePython, venvConfig, signal);
        metadataHash = copied.hash;
        const checkEnvironment = (await this.tools.experimentRuntime(checkRoot)).environment;
        const checked = await this.run({ command: tools.uv,
          args: ['sync', '--project', root, '--locked', '--check', '--offline', '--no-python-downloads', '--no-build', '--python', join(checkRoot, 'bin/python')],
          cwd: root, readablePaths: [tools.root, root], writablePaths: [checkRoot], additionalExecutables: [basePython],
          environment: { ...checkEnvironment, XDG_CONFIG_HOME: await createResearchDirectory(checkRoot, 'config'), UV_PROJECT_ENVIRONMENT: checkRoot, UV_CACHE_DIR: join(checkRoot, 'cache/uv') },
          timeoutMs: 60000, signal, allowGpuAcceleration: false, networkAccess: 'none', allowPosixSpawn: true });
        if (checked.exitCode !== 0) throw new ResearchProcessError('research_experiment_environment_outdated', checked.stdout, checked.stderr);
        for (const file of copied.files) if (researchContentHash(await readResearchFile(environmentRoot, file.path, 16 * 1024 * 1024)) !== file.sha256) throw new Error('research_experiment_environment_changed');
      } finally { await rm(checkRoot, { recursive: true, force: true }); }
    }
    for (const file of lockFiles) {
      if (researchContentHash(await readResearchFile(root, file.path, 16 * 1024 * 1024)) !== file.sha256) throw new Error('research_experiment_environment_changed');
    }
    signal.throwIfAborted();
    const value = { ...report, runtime, toolchainHash: tools.hash, metadataHash, lockFiles };
    const snapshot = researchExperimentEnvironmentSchema.parse({ ...value, hash: researchContentHash(JSON.stringify(value)) });
    return { snapshot, readablePaths, environment, python: tools.python };
  }
}

async function copyEnvironmentMetadata(source: string, target: string, paths: string[], version: string, python: string, venvConfig: Buffer, signal: AbortSignal): Promise<{ hash: string; files: Array<{ path: string; sha256: string }> }> {
  const match = /^(\d+)\.(\d+)\.\d+/u.exec(version);
  if (match === null) throw new Error('research_experiment_python_version_invalid');
  const site = await createResearchDirectory(target, `lib/python${match[1]}.${match[2]}/site-packages`);
  await createResearchDirectory(target, 'bin');
  await symlink(python, join(target, 'bin/python'));
  await writeFile(join(target, 'pyvenv.cfg'), `home = ${dirname(python)}\ninclude-system-site-packages = false\nversion = ${version}\n`, { flag: 'wx', mode: 0o400 });
  const files = [{ path: 'pyvenv.cfg', sha256: researchContentHash(venvConfig) }];
  const names = new Set<string>();
  let bytes = 0;
  async function copyFile(path: string, destination: string): Promise<void> {
    signal.throwIfAborted();
    const content = await readResearchFile(source, path, 16 * 1024 * 1024);
    bytes += content.length;
    if (bytes > 64 * 1024 * 1024 || files.length >= 20000) throw new Error('research_experiment_metadata_limit');
    await writeFile(destination, content, { flag: 'wx', mode: 0o400 });
    files.push({ path, sha256: researchContentHash(content) });
  }
  async function visit(relativePath: string, destination: string): Promise<void> {
    for (const entry of await readdir(join(source, relativePath), { withFileTypes: true })) {
      const path = researchRelativePath(`${relativePath}/${entry.name}`);
      if (entry.isDirectory()) {
        await createResearchDirectory(destination, entry.name);
        await visit(path, join(destination, entry.name));
      } else if (entry.isFile()) await copyFile(path, join(destination, entry.name));
      else throw new Error('research_experiment_metadata_invalid');
    }
  }
  for (const path of paths) {
    signal.throwIfAborted();
    const actual = await realpath(path);
    assertResearchDescendant(source, actual);
    const info = await lstat(path);
    const name = basename(path);
    if (info.isSymbolicLink() || !/\.(dist-info|egg-info)$/u.test(name) || names.has(name.toLowerCase())) throw new Error('research_experiment_metadata_invalid');
    names.add(name.toLowerCase());
    const relativePath = researchRelativePath(actual.slice(source.length + 1));
    if (info.isDirectory()) { await createResearchDirectory(site, name); await visit(relativePath, join(site, name)); }
    else if (info.isFile()) await copyFile(relativePath, join(site, name));
    else throw new Error('research_experiment_metadata_invalid');
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { hash: researchContentHash(JSON.stringify(files)), files };
}
