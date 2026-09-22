import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { createPluginCapabilityAdapter } from '../../../../src/main/ipc/plugin-capability-adapter';
import { createResearchPlugin } from '../../../../src/main/plugins/research';
import { juliaExperimentFlags } from '../../../../src/main/plugins/research/experiment-native-probes';
import { researchProjectSchema } from '../../../../src/shared/schemas/research';
import { researchExperimentEnvironmentSchema, researchExperimentExecutionSchema, researchExperimentFileContentSchema, researchExperimentStartSchema,
  type ResearchExperimentRuntime, type ResearchExperimentStart } from '../../../../src/shared/schemas/research-experiments';

const execute = promisify(execFile);
const tools = process.env.ROC_RESEARCH_TOOLCHAIN;
const rRoot = process.env.ROC_RESEARCH_R_HOME;
const rLibrary = process.env.ROC_RESEARCH_R_LIBRARY;
const juliaRoot = process.env.ROC_RESEARCH_JULIA_ROOT;
const juliaDepot = process.env.ROC_RESEARCH_JULIA_DEPOT;
const artifacts = process.env.ROC_RESEARCH_ARTIFACT_ROOT;
let db: Database.Database;
let root: string;
let workspace: string;
let projectId: string;
let plugin: ReturnType<typeof createResearchPlugin>;
let adapter: ReturnType<typeof createPluginCapabilityAdapter>;
let failure: unknown;

beforeEach(async () => {
  if (artifacts !== undefined) { if (!isAbsolute(artifacts)) throw new Error('research_artifact_root_must_be_absolute'); await mkdir(artifacts, { recursive: true }); }
  root = await realpath(await mkdtemp(join(artifacts ?? tmpdir(), 'roc native experiment-')));
  workspace = join(root, 'workspace'); await mkdir(workspace);
  await writeFile(join(workspace, 'data.csv'), 'value\n21\n');
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); applyResearchDatabaseSchema(db);
  plugin = createResearchPlugin({ experimentRoot: join(root, 'runs'), toolchainRoot: tools });
  const capabilities = new CapabilityRegistry();
  for (const capability of plugin.manifest.capabilities) capabilities.declare(plugin.manifest.id, capability);
  await plugin.initialize({ pluginId: plugin.manifest.id, capabilities, database: { getConnection: () => db },
    config: { get: () => null, set: () => {} }, secrets: { get: () => null, set: () => {}, clear: () => {} },
    eventBus: { publish: async () => {}, subscribe: () => () => {} }, logger: { info: () => {}, warn: () => {}, error: () => {} } });
  adapter = createPluginCapabilityAdapter({ invokeCapability: async <TInput, TOutput>(name: string, input: TInput) => {
    try { return await capabilities.invoke<TInput, TOutput>(name, input); } catch (error) { failure = error; throw error; }
  } });
  projectId = (await call('createProject', { title: 'Native experiment', description: 'Actual R and Julia project environments.', workspacePath: workspace }, researchProjectSchema)).id;
});
afterEach(async () => { await plugin.shutdown(); db.close(); if (artifacts === undefined) await rm(root, { recursive: true, force: true }); });

async function call<T>(method: string, input: unknown, schema: z.ZodType<T>): Promise<T> {
  failure = undefined;
  const result = await adapter.invoke(`research.${method}`, [input]);
  if (!result.ok) throw new Error(`${method}: ${result.error.message}`, { cause: failure });
  return schema.parse(result.data);
}
async function inspect(runtime: ResearchExperimentRuntime) { return await call('inspectExperimentEnvironment', { projectId, runtime }, researchExperimentEnvironmentSchema); }
async function start(runtime: ResearchExperimentRuntime, engine: ResearchExperimentStart['engine'], sourcePath: string, inputPaths = ['data.csv']) {
  const environment = await inspect(runtime);
  return await call('startExperiment', { projectId, requestId: randomUUID(), label: sourcePath, sourcePath, engine, runtime, inputPaths,
    arguments: ['2'], parameters: { scale: '2' }, expectedEnvironmentHash: environment.hash, timeoutMs: 60000, network: 'disabled' }, researchExperimentExecutionSchema);
}
async function finished(id: string) {
  let current = await call('getExperiment', { projectId, runId: id }, researchExperimentExecutionSchema);
  await vi.waitFor(async () => { current = await call('getExperiment', { projectId, runId: id }, researchExperimentExecutionSchema); expect(['preparing', 'running']).not.toContain(current.status); }, { timeout: 90000, interval: 100 });
  await writeFile(join(root, `${id}-result.json`), JSON.stringify(current, null, 2));
  if (current.status === 'failed') {
    const log = await call('readExperimentFile', { projectId, runId: id, area: 'log', path: 'stderr.txt' }, researchExperimentFileContentSchema);
    await writeFile(join(root, `${id}-stderr.txt`), log.content);
  }
  return current;
}
async function prepareR(): Promise<Extract<ResearchExperimentRuntime, { kind: 'renv' }>> {
  if (rRoot === undefined || rLibrary === undefined) throw new Error('r_runtime_required');
  const library = join(workspace, 'library'); await mkdir(library);
  await symlink(join(rLibrary, 'renv'), join(library, 'renv'));
  await execute(join(rRoot, 'bin/exec/R'), ['--vanilla', '--slave', '-e', '.libPaths(c(Sys.getenv("ROC_R_LIBRARY"), .Library), include.site=FALSE); renv::snapshot(project=Sys.getenv("ROC_PROJECT_ROOT"), library=Sys.getenv("ROC_R_LIBRARY"), type="all", prompt=FALSE)'], {
    cwd: workspace, timeout: 60000, env: { PATH: '/usr/bin:/bin', R_HOME: rRoot, DYLD_LIBRARY_PATH: join(rRoot, 'lib'), R_LIBS_USER: library, R_LIBS_SITE: '',
      RENV_PATHS_ROOT: join(root, 'prep-cache'), RENV_CONFIG_AUTOLOADER_ENABLED: 'FALSE', ROC_R_LIBRARY: library, ROC_PROJECT_ROOT: workspace } });
  return { kind: 'renv', rootPath: rRoot, libraryPath: 'library' };
}
async function prepareJulia(localPackage = false): Promise<Extract<ResearchExperimentRuntime, { kind: 'julia' }>> {
  if (juliaRoot === undefined || juliaDepot === undefined) throw new Error('julia_runtime_required');
  if (localPackage) {
    const uuid = randomUUID();
    await mkdir(join(workspace, 'LocalSignal/src'), { recursive: true });
    await writeFile(join(workspace, 'LocalSignal/Project.toml'), `name = "LocalSignal"\nuuid = "${uuid}"\nversion = "0.1.0"\n`);
    await writeFile(join(workspace, 'LocalSignal/src/LocalSignal.jl'), 'module LocalSignal\nconst VALUE = 21\nend\n');
    await writeFile(join(workspace, 'Project.toml'), `[deps]\nLocalSignal = "${uuid}"\n[sources]\nLocalSignal = { path = "LocalSignal" }\n`);
  } else await writeFile(join(workspace, 'Project.toml'), '[deps]\n');
  await execute(join(juliaRoot, 'bin/julia'), [...juliaExperimentFlags, `--project=${workspace}`, '-e', 'using Pkg; Pkg.offline(true); Pkg.resolve()'], {
    cwd: workspace, timeout: 60000, env: { PATH: '/usr/bin:/bin', JULIA_DEPOT_PATH: `${juliaDepot}:${join(juliaRoot, 'share/julia')}`, JULIA_LOAD_PATH: '@:@stdlib', JULIA_PKG_OFFLINE: 'true', JULIA_PKG_PRECOMPILE_AUTO: '0' } });
  return { kind: 'julia', rootPath: juliaRoot, depotPath: juliaDepot };
}

async function verifyCancellation(runtime: ResearchExperimentRuntime, engine: 'r' | 'julia', sourcePath: string): Promise<void> {
  const initial = await start(runtime, engine, sourcePath);
  let pid: number | null = null;
  try {
    await vi.waitFor(async () => {
      const value = Number(await readFile(join(root, 'runs', initial.id, 'output/worker.pid'), 'utf8'));
      expect(value).toBeGreaterThan(0); pid = value;
    }, { timeout: 30000, interval: 100 });
    const cancelled = await call('cancelExperiment', { projectId, runId: initial.id }, researchExperimentExecutionSchema);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.files.some((file) => file.area === 'log')).toBe(true);
    await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })), { timeout: 5000 });
  } finally {
    await call('cancelExperiment', { projectId, runId: initial.id }, researchExperimentExecutionSchema);
    if (pid !== null) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
  }
}

describe('native experiment request boundaries', () => {
  it('rejects mismatched engines, unsafe library paths and incomplete native runtime selections', () => {
    const input = { projectId, requestId: 'request', label: 'R run', engine: 'r', runtime: { kind: 'renv', rootPath: '/runtime', libraryPath: 'library' }, sourcePath: 'run.R', inputPaths: [],
      arguments: [], parameters: {}, expectedEnvironmentHash: 'a'.repeat(64), timeoutMs: 1000, network: 'disabled' };
    expect(researchExperimentStartSchema.safeParse(input).success).toBe(true);
    expect(researchExperimentStartSchema.safeParse({ ...input, runtime: { kind: 'bundled-python' } }).success).toBe(false);
    expect(researchExperimentStartSchema.safeParse({ ...input, runtime: { kind: 'renv', rootPath: '/runtime', libraryPath: '../outside' } }).success).toBe(false);
    expect(researchExperimentStartSchema.safeParse({ ...input, engine: 'julia', sourcePath: 'run.jl', runtime: { kind: 'julia', rootPath: '/runtime' } }).success).toBe(false);
  });
});

describe.skipIf(tools === undefined || rRoot === undefined || rLibrary === undefined)('actual R and renv experiments', () => {
  it('uses the locked project library, arguments and frozen inputs without loading startup profiles', async () => {
    const runtime = await prepareR();
    await writeFile(join(workspace, '.Rprofile'), 'stop("project startup must not run")\n');
    await writeFile(join(workspace, 'run.R'), 'stopifnot(requireNamespace("renv", quietly=TRUE))\nvalue <- read.csv("data.csv")$value * as.numeric(commandArgs(trailingOnly=TRUE)[1])\nwrite.csv(data.frame(value=value), file.path(Sys.getenv("ROC_OUTPUT_DIR"), "result.csv"), row.names=FALSE)\ncat("Measured value", value, "\\n")\n');
    const originalLock = await readFile(join(workspace, 'renv.lock'), 'utf8');
    const initial = await start(runtime, 'r', 'run.R', ['data.csv', '.Rprofile']);
    const result = await finished(initial.id);
    expect(result).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(result.environment?.packages).toEqual(expect.arrayContaining([{ name: 'renv', version: '1.2.4' }]));
    expect((await call('readExperimentFile', { projectId, runId: initial.id, area: 'output', path: 'result.csv' }, researchExperimentFileContentSchema)).content).toContain('42');
    expect(await readFile(join(workspace, 'renv.lock'), 'utf8')).toBe(originalLock);
  }, 120000);

  it('rejects both runtime and package versions which disagree with renv.lock', async () => {
    const runtime = await prepareR();
    const lock = JSON.parse(await readFile(join(workspace, 'renv.lock'), 'utf8'));
    await writeFile(join(workspace, 'renv.lock'), JSON.stringify({ ...lock, R: { ...lock.R, Version: '0.0.0' } }));
    await expect(inspect(runtime)).rejects.toMatchObject({ cause: { code: 'research_experiment_runtime_version_mismatch' } });
    lock.Packages.renv.Version = '0.0.0';
    await writeFile(join(workspace, 'renv.lock'), JSON.stringify(lock));
    await expect(inspect(runtime)).rejects.toMatchObject({ cause: { code: 'research_experiment_environment_outdated' } });
  }, 120000);

  it('cancels an actual R process and retains its diagnostics', async () => {
    const runtime = await prepareR();
    await writeFile(join(workspace, 'cancel.R'), 'writeLines(as.character(Sys.getpid()), file.path(Sys.getenv("ROC_OUTPUT_DIR"), "worker.pid"))\nrepeat Sys.sleep(1)\n');
    await verifyCancellation(runtime, 'r', 'cancel.R');
  }, 120000);

  it('uses the same library selection during preflight and execution when R has a site library', async () => {
    if (rRoot === undefined) throw new Error('r_runtime_required');
    const runtime = await prepareR();
    const copyRoot = await realpath(await mkdtemp(join(tmpdir(), 'roc-r-library-selection-')));
    try {
      const copied = join(copyRoot, 'R');
      await cp(rRoot, copied, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true, force: false, errorOnExist: true });
      await mkdir(join(copied, 'site-library'), { recursive: true });
      await writeFile(join(workspace, 'libraries.R'), 'writeLines(.libPaths(), file.path(Sys.getenv("ROC_OUTPUT_DIR"), "libraries.txt"))\n');
      const initial = await start({ ...runtime, rootPath: copied }, 'r', 'libraries.R');
      expect(await finished(initial.id)).toMatchObject({ status: 'completed' });
      const result = await call('readExperimentFile', { projectId, runId: initial.id, area: 'output', path: 'libraries.txt' }, researchExperimentFileContentSchema);
      expect(result.content.split('\n').filter(Boolean)).toEqual([join(workspace, 'library'), join(copied, 'library')]);
    } finally { await rm(copyRoot, { recursive: true, force: true }); }
  }, 120000);
});

describe.skipIf(tools === undefined || juliaRoot === undefined || juliaDepot === undefined)('actual Julia experiments', () => {
  it('runs with the frozen project and records its locked environment', async () => {
    const runtime = await prepareJulia();
    await writeFile(join(workspace, 'run.jl'), 'value = parse(Int, split(strip(read("data.csv", String)), "\\n")[2]) * parse(Int, ARGS[1])\nwrite(joinpath(ENV["ROC_OUTPUT_DIR"], "result.txt"), string(value))\nprintln("Measured value ", value)\n');
    const originalLock = await readFile(join(workspace, 'Manifest.toml'), 'utf8');
    const initial = await start(runtime, 'julia', 'run.jl');
    const result = await finished(initial.id);
    expect(result).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(result.environment?.lockFiles.map((file) => file.path)).toEqual(['Manifest.toml', 'Project.toml']);
    expect((await call('readExperimentFile', { projectId, runId: initial.id, area: 'output', path: 'result.txt' }, researchExperimentFileContentSchema)).content).toBe('42');
    expect(await readFile(join(workspace, 'Manifest.toml'), 'utf8')).toBe(originalLock);
  }, 180000);

  it('rejects a stale project manifest without resolving or rewriting it', async () => {
    const runtime = await prepareJulia();
    const originalLock = await readFile(join(workspace, 'Manifest.toml'), 'utf8');
    await writeFile(join(workspace, 'Project.toml'), '[deps]\nTOML = "fa267f1f-6049-4f14-aa54-33bafae1ed76"\n');
    await expect(inspect(runtime)).rejects.toMatchObject({ cause: { code: 'research_experiment_environment_outdated' } });
    expect(await readFile(join(workspace, 'Manifest.toml'), 'utf8')).toBe(originalLock);
  }, 120000);

  it('loads a local package from frozen inputs and records its actual project version', async () => {
    const runtime = await prepareJulia(true);
    await writeFile(join(workspace, 'run.jl'), 'using LocalSignal\n@assert startswith(pathof(LocalSignal), ENV["ROC_INPUT_DIR"])\nwrite(joinpath(ENV["ROC_OUTPUT_DIR"], "result.txt"), string(LocalSignal.VALUE * parse(Int, ARGS[1])))\n');
    const initial = await start(runtime, 'julia', 'run.jl', ['data.csv', 'LocalSignal/Project.toml', 'LocalSignal/src/LocalSignal.jl']);
    const result = await finished(initial.id);
    expect(result).toMatchObject({ status: 'completed', environment: { packages: [{ name: 'LocalSignal', version: '0.1.0' }] } });
    expect((await call('readExperimentFile', { projectId, runId: initial.id, area: 'output', path: 'result.txt' }, researchExperimentFileContentSchema)).content).toBe('42');
  }, 180000);

  it('freezes the preferred Julia configuration filenames instead of silently selecting lower-priority files', async () => {
    const runtime = await prepareJulia(true);
    await writeFile(join(workspace, 'LocalPreferences.toml'), '[LocalSignal]\nscale = 7\n');
    await writeFile(join(workspace, 'JuliaLocalPreferences.toml'), '[LocalSignal]\nscale = 42\n');
    await writeFile(join(workspace, 'Artifacts.toml'), '');
    await writeFile(join(workspace, 'JuliaArtifacts.toml'), '');
    await writeFile(join(workspace, 'preferences.jl'), 'using LocalSignal\npreferences = Base.get_preferences(Base.PkgId(LocalSignal).uuid)\nwrite(joinpath(ENV["ROC_OUTPUT_DIR"], "preferences.txt"), string(preferences["scale"]))\n');
    const initial = await start(runtime, 'julia', 'preferences.jl', ['data.csv', 'LocalSignal/Project.toml', 'LocalSignal/src/LocalSignal.jl']);
    const result = await finished(initial.id);
    expect(result.status).toBe('completed');
    expect(result.environment?.lockFiles.map((file) => file.path)).toEqual(expect.arrayContaining(['JuliaLocalPreferences.toml', 'LocalPreferences.toml', 'JuliaArtifacts.toml', 'Artifacts.toml']));
    const preferences = await call('readExperimentFile', { projectId, runId: initial.id, area: 'output', path: 'preferences.txt' }, researchExperimentFileContentSchema);
    expect(preferences.content).toBe('42');
  }, 180000);

  it('cancels an actual Julia process and retains its diagnostics', async () => {
    const runtime = await prepareJulia();
    await writeFile(join(workspace, 'cancel.jl'), 'write(joinpath(ENV["ROC_OUTPUT_DIR"], "worker.pid"), string(getpid()))\nwhile true\n sleep(1)\nend\n');
    await verifyCancellation(runtime, 'julia', 'cancel.jl');
  }, 120000);
});
