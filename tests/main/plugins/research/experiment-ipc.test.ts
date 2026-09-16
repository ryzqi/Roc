import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { createPluginCapabilityAdapter } from '../../../../src/main/ipc/plugin-capability-adapter';
import { createResearchPlugin } from '../../../../src/main/plugins/research';
import { ResearchExperimentEnvironmentService } from '../../../../src/main/plugins/research/experiment-environment';
import { ResearchToolchain } from '../../../../src/main/plugins/research/toolchain';
import { runResearchProcess } from '../../../../src/main/plugins/research/process-runner';
import { researchProjectSchema } from '../../../../src/shared/schemas/research';
import { researchExperimentEnvironmentSchema, researchExperimentExecutionSchema, researchExperimentFileContentSchema, type ResearchExperimentRuntime } from '../../../../src/shared/schemas/research-experiments';

const tools = process.env.ROC_RESEARCH_TOOLCHAIN;
const artifacts = process.env.ROC_RESEARCH_ARTIFACT_ROOT;
const execute = promisify(execFile);
let db: Database.Database;
let root: string;
let workspace: string;
let projectId: string;
let plugin: ReturnType<typeof createResearchPlugin>;
let capabilities: CapabilityRegistry;
let adapter: ReturnType<typeof createPluginCapabilityAdapter>;
let failure: unknown;

beforeEach(async () => {
  if (artifacts !== undefined) { if (!isAbsolute(artifacts)) throw new Error('research_artifact_root_must_be_absolute'); await mkdir(artifacts, { recursive: true }); }
  root = await realpath(await mkdtemp(join(artifacts ?? tmpdir(), 'roc experiment integration-')));
  workspace = join(root, 'workspace'); await mkdir(workspace);
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); applyResearchDatabaseSchema(db);
  plugin = createResearchPlugin({ experimentRoot: join(root, 'runs'), toolchainRoot: tools });
  capabilities = new CapabilityRegistry();
  for (const capability of plugin.manifest.capabilities) capabilities.declare(plugin.manifest.id, capability);
  await plugin.initialize({ pluginId: plugin.manifest.id, capabilities, database: { getConnection: () => db },
    config: { get: () => null, set: () => {} }, secrets: { get: () => null, set: () => {}, clear: () => {} },
    eventBus: { publish: async () => {}, subscribe: () => () => {} }, logger: { info: () => {}, warn: () => {}, error: () => {} } });
  adapter = createPluginCapabilityAdapter({ invokeCapability: async <TInput, TOutput>(name: string, input: TInput) => {
    try { return await capabilities.invoke<TInput, TOutput>(name, input); }
    catch (error) { failure = error; throw error; }
  } });
  projectId = (await call('createProject', { title: 'Experiment integration', description: 'Actual Python processes.', workspacePath: workspace }, researchProjectSchema)).id;
});
afterEach(async () => { await plugin.shutdown(); db.close(); if (artifacts === undefined) await rm(root, { recursive: true, force: true }); });
async function call<T>(method: string, input: unknown, schema: z.ZodType<T>): Promise<T> {
  failure = undefined;
  const result = await adapter.invoke(`research.${method}`, [input]);
  if (!result.ok) throw new Error(`${method}: ${result.error.message}`, { cause: failure });
  return schema.parse(result.data);
}
async function run(sourcePath: string, engine: 'python', runtime: ResearchExperimentRuntime, timeoutMs = 30000) {
  const environment = await call('inspectExperimentEnvironment', { projectId, runtime }, researchExperimentEnvironmentSchema);
  const initial = await call('startExperiment', { projectId, requestId: randomUUID(), label: sourcePath, sourcePath, engine, runtime, inputPaths: ['data.csv'],
    arguments: [], parameters: { scale: '2' }, expectedEnvironmentHash: environment.hash, timeoutMs, network: 'disabled' }, researchExperimentExecutionSchema);
  let latest = initial;
  await vi.waitFor(async () => {
    latest = await call('getExperiment', { projectId, runId: initial.id }, researchExperimentExecutionSchema);
    expect(['preparing', 'running']).not.toContain(latest.status);
  }, { timeout: timeoutMs + 15000, interval: 50 });
  await writeFile(join(root, `${initial.id}-result.json`), JSON.stringify(latest, null, 2));
  if (latest.status === 'failed') {
    const log = latest.files.find((file) => file.area === 'log' && file.path === 'stderr.txt');
    if (log !== undefined) {
      const diagnostics = await call('readExperimentFile', { projectId, runId: initial.id, area: log.area, path: log.path }, researchExperimentFileContentSchema);
      await writeFile(join(root, `${initial.id}-stderr.txt`), diagnostics.content);
    }
  }
  return latest;
}

describe.skipIf(tools === undefined)('actual research experiment IPC and private runtime', () => {
  it('never grants posix_spawn to project Python startup hooks during uv preflight', async () => {
    if (tools === undefined) throw new Error('toolchain_required');
    const python = join(tools, 'python/bin/python3');
    const uv = join(tools, 'bin/uv');
    await writeFile(join(workspace, 'pyproject.toml'), '[project]\nname = "roc-startup-hook-fixture"\nversion = "0.1.0"\nrequires-python = ">=3.12,<3.13"\ndependencies = []\n[tool.uv]\npackage = false\n');
    const options = { cwd: workspace, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1', UV_PYTHON_DOWNLOADS: 'never' } };
    await execute(uv, ['venv', '--offline', '--python', python, join(workspace, '.venv')], options);
    await execute(uv, ['lock', '--offline', '--project', workspace, '--python', python], options);
    const startup = "import os, sys; child = os.posix_spawn(sys.executable, [sys.executable, '-I', '-B', '-S', '-c', 'pass'], os.environ, setpgroup=0); os.waitpid(child, 0); open(os.path.join(os.environ['TMPDIR'], 'posix-spawn-permitted'), 'w').write('unsafe')\n";
    await writeFile(join(workspace, '.venv/lib/python3.12/site-packages/probe-startup.pth'), startup);
    const job = join(root, 'probe'); await mkdir(job);
    const spawnedDuringProbe: string[] = [];
    const checks: string[] = [];
    const environment = new ResearchExperimentEnvironmentService(new ResearchToolchain(tools), async (input) => {
      const result = await runResearchProcess(input);
      if (input.command === uv) {
        expect(input.environment.UV_PROJECT_ENVIRONMENT).toContain('/uv-check-');
        checks.push(result.stderr);
      } else expect(input.allowPosixSpawn).toBe(false);
      try { await readFile(join(input.environment.TMPDIR!, 'posix-spawn-permitted')); spawnedDuringProbe.push(input.command); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return result;
    });
    await environment.inspect(workspace, { kind: 'uv' }, job, new AbortController().signal);
    expect(spawnedDuringProbe).toEqual([]);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toContain('uv-check-');
  }, 60000);

  it('checks installed wheel metadata and detects changes without copying package code into the uv probe', async () => {
    if (tools === undefined) throw new Error('toolchain_required');
    const python = join(tools, 'python/bin/python3'); const uv = join(tools, 'bin/uv');
    const wheel = join(workspace, 'roc_measurement-1.0.0-py3-none-any.whl');
    const builder = "import base64, hashlib, sys, zipfile\nfiles = {'roc_measurement/__init__.py': 'VALUE = 42\\n', 'roc_measurement-1.0.0.dist-info/METADATA': 'Metadata-Version: 2.1\\nName: roc-measurement\\nVersion: 1.0.0\\n', 'roc_measurement-1.0.0.dist-info/WHEEL': 'Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'}\nrecord = ''.join(path + ',sha256=' + base64.urlsafe_b64encode(hashlib.sha256(content.encode()).digest()).decode().rstrip('=') + ',' + str(len(content.encode())) + '\\n' for path, content in files.items())\nfiles['roc_measurement-1.0.0.dist-info/RECORD'] = record + 'roc_measurement-1.0.0.dist-info/RECORD,,\\n'\nwith zipfile.ZipFile(sys.argv[1], 'w') as archive:\n    for path, content in files.items(): archive.writestr(path, content)\n";
    const options = { cwd: workspace, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1', UV_PYTHON_DOWNLOADS: 'never' } };
    await execute(python, ['-I', '-B', '-c', builder, wheel], options);
    await writeFile(join(workspace, 'pyproject.toml'), '[project]\nname = "roc-wheel-fixture"\nversion = "0.1.0"\nrequires-python = ">=3.12,<3.13"\ndependencies = ["roc-measurement==1.0.0"]\n[tool.uv]\npackage = false\n[tool.uv.sources]\nroc-measurement = { path = "roc_measurement-1.0.0-py3-none-any.whl" }\n');
    await execute(uv, ['venv', '--offline', '--python', python, join(workspace, '.venv')], options);
    await execute(uv, ['lock', '--offline', '--project', workspace, '--python', python], options);
    await execute(uv, ['sync', '--offline', '--locked', '--project', workspace, '--python', python], options);
    const before = await call('inspectExperimentEnvironment', { projectId, runtime: { kind: 'uv' } }, researchExperimentEnvironmentSchema);
    expect(before.packages).toEqual([{ name: 'roc-measurement', version: '1.0.0' }]);
    await appendFile(join(workspace, '.venv/lib/python3.12/site-packages/roc_measurement-1.0.0.dist-info/METADATA'), 'Summary: Updated local metadata\n');
    const after = await call('inspectExperimentEnvironment', { projectId, runtime: { kind: 'uv' } }, researchExperimentEnvironmentSchema);
    expect(after.packages).toEqual(before.packages);
    expect(after.metadataHash).not.toBe(before.metadataHash);
    expect(after.hash).not.toBe(before.hash);
    await writeFile(join(workspace, 'run.py'), "import os, roc_measurement\nfrom pathlib import Path\nPath(os.environ['ROC_OUTPUT_DIR'], 'result.txt').write_text(str(roc_measurement.VALUE))\n");
    await writeFile(join(workspace, 'data.csv'), '21\n');
    const result = await run('run.py', 'python', { kind: 'uv' });
    expect(result.status).toBe('completed');
    expect((await call('readExperimentFile', { projectId, runId: result.id, area: 'output', path: 'result.txt' }, researchExperimentFileContentSchema)).content).toBe('42');
  }, 90000);

  it('rejects an unverified project interpreter before starting it', async () => {
    await mkdir(join(workspace, '.venv/bin'), { recursive: true });
    await symlink(process.execPath, join(workspace, '.venv/bin/python'));
    await writeFile(join(workspace, 'pyproject.toml'), '[project]\nname = "invalid-interpreter"\nversion = "0.1.0"\n');
    await writeFile(join(workspace, 'uv.lock'), 'version = 1\n');
    await expect(call('inspectExperimentEnvironment', { projectId, runtime: { kind: 'uv' } }, researchExperimentEnvironmentSchema)).rejects.toMatchObject({ cause: { message: 'research_experiment_bundled_python_required' } });
  }, 60000);

  it('runs a frozen Python input with parameters while denying original-project and external file access', async () => {
    await writeFile(join(workspace, 'data.csv'), '21\n');
    const outside = join(root, 'outside.txt'); await writeFile(outside, 'outside sentinel');
    await writeFile(join(workspace, 'run.py'), `import json, os\nfrom pathlib import Path\nparameters = json.loads(os.environ['ROC_PARAMETERS_JSON'])\nvalue = int(Path('data.csv').read_text().strip()) * int(parameters['scale'])\nfor path in [${JSON.stringify(outside)}, ${JSON.stringify(join(workspace, 'data.csv'))}]:\n    try:\n        Path(path).read_text()\n    except PermissionError:\n        pass\n    else:\n        raise AssertionError('outside read succeeded')\nPath(os.environ['ROC_OUTPUT_DIR'], 'result.csv').write_text(str(value) + '\\n')\nprint('Measured signal', value)\n`);
    const result = await run('run.py', 'python', { kind: 'bundled-python' });
    expect(result).toMatchObject({ status: 'completed', exitCode: 0 });
    const output = await call('readExperimentFile', { projectId, runId: result.id, area: 'output', path: 'result.csv' }, researchExperimentFileContentSchema);
    expect(output.content).toBe('42\n');
    expect(await readFile(outside, 'utf8')).toBe('outside sentinel');
  }, 90000);

  it('validates and executes an existing uv environment without changing lockfiles or installing dependencies', async () => {
    if (tools === undefined) throw new Error('toolchain_required');
    await writeFile(join(workspace, 'data.csv'), '21\n');
    await writeFile(join(workspace, 'run.py'), "import os, sys\nfrom pathlib import Path\nPath(os.environ['ROC_OUTPUT_DIR'], 'result.txt').write_text(sys.prefix)\n");
    await writeFile(join(workspace, 'pyproject.toml'), '[project]\nname = "roc-experiment-fixture"\nversion = "0.1.0"\nrequires-python = ">=3.12,<3.13"\ndependencies = []\n[tool.uv]\npackage = false\n');
    const uv = join(tools, 'bin/uv'); const python = join(tools, 'python/bin/python3');
    const options = { cwd: workspace, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1', UV_PYTHON_DOWNLOADS: 'never' } };
    await execute(uv, ['venv', '--offline', '--python', python, join(workspace, '.venv')], options);
    await execute(uv, ['lock', '--offline', '--project', workspace, '--python', python], options);
    const lock = await readFile(join(workspace, 'uv.lock'), 'utf8');
    const result = await run('run.py', 'python', { kind: 'uv' });
    expect(result).toMatchObject({ status: 'completed', environment: { runtime: { kind: 'uv' } } });
    expect(result.environment?.lockFiles.map((file) => file.path)).toEqual(['pyproject.toml', 'uv.lock']);
    expect((await call('readExperimentFile', { projectId, runId: result.id, area: 'output', path: 'result.txt' }, researchExperimentFileContentSchema)).content).toBe(join(workspace, '.venv'));
    expect(await readFile(join(workspace, 'uv.lock'), 'utf8')).toBe(lock);
    await writeFile(join(workspace, 'pyproject.toml'), (await readFile(join(workspace, 'pyproject.toml'), 'utf8')).replace('dependencies = []', 'dependencies = ["pandas==1.0.0"]'));
    await expect(call('inspectExperimentEnvironment', { projectId, runtime: { kind: 'uv' } }, researchExperimentEnvironmentSchema)).rejects.toThrow();
    expect(await readFile(join(workspace, 'uv.lock'), 'utf8')).toBe(lock);
  }, 90000);

});
