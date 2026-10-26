import { lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { researchExperimentEnvironmentSchema, type ResearchExperimentEnvironment } from '../../../shared/schemas/research-experiments';
import type { NativeRuntime, NativeTools, PreparedExperimentEnvironment } from './experiment-environment';
import { juliaEnvironmentProbe, juliaExperimentFlags, normalizeNativeEnvironmentReport, rEnvironmentProbe, rExperimentCommand } from './experiment-native-probes';
import { experimentDirectoryEntryLimit, experimentFileCountLimit, experimentFileLimit, experimentOutputTotalLimit } from './experiment-files';
import { rProcessBridgeHash, runRExperimentProcess } from './experiment-native-process';
import { ResearchProcessError, type ResearchProcessRequest, type ResearchProcessResult } from './process-runner';
import { createResearchDirectory, readResearchFile, researchContentHash, researchPath, researchRelativePath } from './research-files';

type ProcessRun = (input: ResearchProcessRequest) => Promise<ResearchProcessResult>;
type NativeEnvironmentInspectionInput = {
  workspace: string;
  runtime: NativeRuntime;
  jobDir: string;
  tools: NativeTools;
  run: ProcessRun;
  signal: AbortSignal;
};
const reportSchema = z.object({
  version: z.string().min(1), platform: z.string().min(1), architecture: z.string().min(1), prefix: z.string().min(1), basePrefix: z.string().min(1),
  packages: z.array(z.object({ name: z.string().min(1), versions: z.array(z.string().min(1)).max(1) }).strict()).max(10000),
  metadataPaths: z.array(z.string().min(1)).max(10000),
  controls: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()).max(1000)
}).strict();

export async function inspectNativeExperimentEnvironment({ workspace, runtime, jobDir, tools, run, signal }: NativeEnvironmentInspectionInput): Promise<PreparedExperimentEnvironment> {
  const root = await realpath(runtime.rootPath);
  const executable = await researchPath(root, runtime.kind === 'renv' ? 'bin/exec/R' : 'bin/julia');
  const beforeExecutable = researchContentHash(await readResearchFile(root, relative(root, executable), 64 * 1024 * 1024));
  const readablePaths = [tools.root, root];
  const environment: NodeJS.ProcessEnv = { ...tools.environment };
  const lockFiles: ResearchExperimentEnvironment['lockFiles'] = [];
  let prefix: string;
  if (runtime.kind === 'renv') {
    prefix = await researchPath(workspace, runtime.libraryPath);
    const prefixInfo = await lstat(prefix);
    if (!prefixInfo.isDirectory()) throw new Error('research_experiment_library_required');
    readablePaths.push(prefix, ...await rPackageRoots(prefix, signal));
    for (const path of ['renv.lock', 'renv/settings.json']) {
      if (path !== 'renv.lock' && !await exists(join(workspace, path))) continue;
      const bytes = await readResearchFile(workspace, path, 16 * 1024 * 1024);
      lockFiles.push({ path, sha256: researchContentHash(bytes), size: bytes.length });
    }
    Object.assign(environment, { R_HOME: root, R_LIBS: prefix, R_LIBS_USER: prefix, R_LIBS_SITE: 'NULL', RENV_PATHS_ROOT: await createResearchDirectory(jobDir, 'renv-cache'),
      RENV_CONFIG_CACHE_ENABLED: 'FALSE', RENV_CONFIG_AUTOLOADER_ENABLED: 'FALSE', RENV_CONFIG_AUTO_SNAPSHOT: 'FALSE' });
  } else {
    prefix = await realpath(runtime.depotPath);
    const prefixInfo = await lstat(prefix);
    if (!prefixInfo.isDirectory()) throw new Error('research_experiment_depot_required');
    for (const path of ['packages', 'artifacts', 'compiled', 'scratchspaces']) if (await exists(join(prefix, path))) readablePaths.push(await researchPath(prefix, path));
    Object.assign(environment, { JULIA_DEPOT_PATH: `${await createResearchDirectory(jobDir, 'julia-depot')}:${prefix}:${join(root, 'share/julia')}`, JULIA_LOAD_PATH: '@:@stdlib',
      JULIA_PKG_OFFLINE: 'true', JULIA_PKG_PRECOMPILE_AUTO: '0', JULIA_HISTORY: join(jobDir, 'julia-history') });
  }
  const probe = await mkdtemp(join(jobDir, `${runtime.kind}-probe-`));
  try {
    const reportPath = join(probe, runtime.kind === 'renv' ? 'environment.csv' : 'environment.json');
    const command = runtime.kind === 'renv'
      ? rExperimentCommand(root, executable, ['--vanilla', '--slave', '-e', rEnvironmentProbe])
      : { command: executable, args: [...juliaExperimentFlags, `--project=${workspace}`, '-e', juliaEnvironmentProbe] };
    const request: ResearchProcessRequest = { ...command, cwd: workspace, readablePaths: [...readablePaths, workspace], writablePaths: [jobDir],
      additionalExecutables: [executable], environment: { ...environment, ROC_PROJECT_ROOT: workspace, ROC_R_LIBRARY: prefix, ROC_JULIA_DEPOT: prefix, ROC_ENVIRONMENT_REPORT: reportPath },
      writeLimits: [{ path: jobDir, maxFileBytes: experimentFileLimit, maxTotalBytes: experimentOutputTotalLimit,
        maxFiles: experimentFileCountLimit, maxEntries: experimentDirectoryEntryLimit }],
      timeoutMs: 60000, signal, allowGpuAcceleration: false, networkAccess: 'none', allowPosixSpawn: false };
    const result = runtime.kind === 'renv' ? await runRExperimentProcess(request, run) : await run(request);
    if (result.exitCode !== 0) throw new ResearchProcessError(nativeError(result.stderr), result.stdout, result.stderr);
    const bytes = await readResearchFile(probe, runtime.kind === 'renv' ? 'environment.csv' : 'environment.json', 4 * 1024 * 1024);
    let report;
    try { report = reportSchema.parse(normalizeNativeEnvironmentReport(runtime.kind, bytes.toString('utf8'))); }
    catch {
      throw new ResearchProcessError('research_experiment_environment_report_invalid', bytes.toString('utf8'));
    }
    if (await realpath(report.prefix) !== prefix || await realpath(report.basePrefix) !== root) throw new Error('research_experiment_runtime_changed');
    if (runtime.kind === 'julia') {
      for (const file of report.controls) {
        const path = researchRelativePath(relative(workspace, file.path));
        const bytes = await readResearchFile(workspace, path, 16 * 1024 * 1024);
        if (researchContentHash(bytes) !== file.sha256) throw new Error('research_experiment_environment_changed');
        lockFiles.push({ path, size: bytes.length, sha256: file.sha256 });
      }
    }
    const metadata = [];
    let metadataBytes = 0;
    for (const path of report.metadataPaths) {
      signal.throwIfAborted();
      const actual = await realpath(path);
      const scope = [...readablePaths, workspace].find((directory) => descendant(directory, actual));
      if (scope === undefined) throw new Error('research_experiment_metadata_outside_scope');
      const content = await readResearchFile(scope, researchRelativePath(relative(scope, actual)), 16 * 1024 * 1024);
      metadataBytes += content.length;
      if (metadataBytes > 64 * 1024 * 1024) throw new Error('research_experiment_metadata_limit');
      metadata.push({ path: actual, sha256: researchContentHash(content) });
    }
    for (const file of lockFiles) if (researchContentHash(await readResearchFile(workspace, file.path, 16 * 1024 * 1024)) !== file.sha256) throw new Error('research_experiment_environment_changed');
    if (researchContentHash(await readResearchFile(root, relative(root, executable), 64 * 1024 * 1024)) !== beforeExecutable) throw new Error('research_experiment_runtime_changed');
    signal.throwIfAborted();
    const packages = report.packages.map((entry) => ({ name: entry.name, version: entry.versions.length === 0 ? null : entry.versions[0] }))
      .sort((left, right) => left.name.localeCompare(right.name) || String(left.version).localeCompare(String(right.version)));
    metadata.sort((left, right) => left.path.localeCompare(right.path));
    lockFiles.sort((left, right) => left.path.localeCompare(right.path));
    const value = { runtime, executable, prefix, basePrefix: root, version: report.version, platform: report.platform, architecture: report.architecture,
      toolchainHash: tools.hash, metadataHash: researchContentHash(JSON.stringify({ executable: beforeExecutable, metadata, bridge: runtime.kind === 'renv' ? rProcessBridgeHash() : null })), packages, lockFiles };
    const snapshot = researchExperimentEnvironmentSchema.parse({ ...value, hash: researchContentHash(JSON.stringify(value)) });
    return { snapshot, readablePaths: [...new Set(readablePaths)], environment, typescriptRuntime: null };
  } finally { await rm(probe, { recursive: true, force: true }); }
}

async function rPackageRoots(library: string, signal: AbortSignal): Promise<string[]> {
  const roots: string[] = [];
  let metadataBytes = 0;
  const entries = await readdir(library, { withFileTypes: true });
  if (entries.length > 10000) throw new Error('research_experiment_metadata_limit');
  for (const entry of entries) {
    signal.throwIfAborted();
    if (!/^[A-Za-z][A-Za-z0-9.]*$/u.test(entry.name) || !entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const root = await realpath(join(library, entry.name));
    if (!await exists(join(root, 'DESCRIPTION'))) continue;
    const description = (await readResearchFile(root, 'DESCRIPTION', 1024 * 1024)).toString('utf8');
    metadataBytes += Buffer.byteLength(description);
    if (metadataBytes > 64 * 1024 * 1024) throw new Error('research_experiment_metadata_limit');
    if (/^Package:\s*([^\r\n]+)$/mu.exec(description)?.[1].trim() !== entry.name) throw new Error('research_experiment_package_metadata_invalid');
    roots.push(root);
  }
  return roots;
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function descendant(root: string, path: string): boolean { const value = relative(root, path); return value !== '' && value !== '..' && !value.startsWith('../') && !isAbsolute(value); }
function nativeError(stderr: string): string {
  return /research_experiment_(?:renv_required|lock_invalid|lock_required|runtime_version_mismatch|environment_outdated|packages_missing|environment_changed|absolute_dependency_path|package_metadata_missing|metadata_limit)/u.exec(stderr)?.[0] ?? 'research_experiment_environment_probe_failed';
}
