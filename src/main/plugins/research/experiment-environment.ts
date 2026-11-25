import { dirname, join } from 'node:path';
import { researchExperimentEnvironmentSchema, type ResearchExperimentEnvironment, type ResearchExperimentRuntime } from '../../../shared/schemas/research-experiments';
import { researchContentHash } from './research-files';
import type { ResearchProcessScope, ResearchToolchain, ResearchTypeScriptRuntime } from './toolchain';
import type { ResearchEnvironmentProbeResource } from '../../../shared/schemas/research-process-resources';
import type { ResearchPythonEnvironmentService } from './python-environment-service';
import type { InspectedPythonEnvironment } from './experiment-python-probe';
import { pythonExperimentToolchainHash } from './experiment-python-process';

export type PreparedExperimentEnvironment = {
  snapshot: ResearchExperimentEnvironment;
  readablePaths: string[];
  environment: NodeJS.ProcessEnv;
  typescriptRuntime: ResearchTypeScriptRuntime | null;
  python: InspectedPythonEnvironment | null;
};

export class ResearchExperimentEnvironmentService {
  constructor(private readonly tools: Pick<ResearchToolchain, 'typescriptRuntime'>,
    private readonly pythonEnvironments: Pick<ResearchPythonEnvironmentService, 'acquireRuntime'>) {}

  async inspect(runtime: ResearchExperimentRuntime, jobDir: string, signal: AbortSignal, admission: ResearchProcessScope,
    onProbe: (receipt: ResearchEnvironmentProbeResource) => void): Promise<PreparedExperimentEnvironment> {
    const lease = await this.acquire(runtime, jobDir, signal, admission, onProbe);
    try { return lease.prepared; } finally { lease.release(); }
  }

  async acquire(runtime: ResearchExperimentRuntime, jobDir: string, signal: AbortSignal, admission: ResearchProcessScope,
    onProbe: (receipt: ResearchEnvironmentProbeResource) => void): Promise<ExperimentEnvironmentLease> {
    signal.throwIfAborted();
    if (runtime.kind === 'python') {
      if (admission.projectId === null) throw new Error('research_python_environment_project_required');
      const lease = await this.pythonEnvironments.acquireRuntime({projectId: admission.projectId,
        environmentId: runtime.environmentId, expectedHash: runtime.expectedHash}, jobDir, signal, admission, onProbe);
      try {
        return {prepared: preparePython(runtime, lease.environment, jobDir),
          verify: async onProbe => preparePython(runtime, await lease.verify(onProbe), jobDir), release: lease.release};
      } catch (error) { lease.release(); throw error; }
    }
    return {prepared: await this.inspectBundled(runtime, jobDir, signal), release: () => undefined,
      verify: () => this.inspectBundled(runtime, jobDir, signal)};
  }

  private async inspectBundled(runtime: ResearchExperimentRuntime, jobDir: string, signal: AbortSignal): Promise<PreparedExperimentEnvironment> {
    if (runtime.kind === 'bundled-node') {
      const tools = await this.tools.typescriptRuntime(jobDir);
      const metadataHash = researchContentHash(JSON.stringify({ contractVersion: 1, runnerHash: tools.runnerHash, packages: tools.packages }));
      const value = {
        runtime,
        executable: tools.executable,
        prefix: dirname(tools.executable),
        basePrefix: dirname(tools.executable),
        version: tools.nodeVersion,
        platform: tools.platform,
        architecture: tools.architecture,
        toolchainHash: tools.hash,
        metadataHash,
        packages: tools.packages.map(({ name, version }) => ({ name, version })),
        lockFiles: []
      };
      const snapshot = researchExperimentEnvironmentSchema.parse({ ...value, hash: researchContentHash(JSON.stringify(value)) });
      signal.throwIfAborted();
      // Electron's macOS executable loads its bundled dylibs before Node's permission checks.
      const frameworks = join(dirname(dirname(tools.executable)), 'Frameworks');
      return { snapshot, readablePaths: [tools.runnerPath, frameworks, ...tools.packageRoots], environment: tools.environment, typescriptRuntime: tools, python: null };
    }
    throw new Error('research_experiment_runtime_unsupported');
  }
}

export type ExperimentEnvironmentLease = {
  prepared: PreparedExperimentEnvironment;
  verify: (onProbe: (receipt: ResearchEnvironmentProbeResource) => void) => Promise<PreparedExperimentEnvironment>;
  release: () => void;
};
function preparePython(runtime: ResearchExperimentRuntime, python: InspectedPythonEnvironment, jobDir: string): PreparedExperimentEnvironment {
  const {controls, report, metadataHash, lockFiles, codeReceipt} = python;
  const value = researchExperimentEnvironmentSchema.omit({hash: true}).parse({
    runtime, executable: controls.selectedExecutable, prefix: report.prefix, basePrefix: report.basePrefix,
    version: report.version, platform: report.platform, architecture: report.architecture,
    toolchainHash: pythonExperimentToolchainHash(codeReceipt), metadataHash, packages: report.distributions, lockFiles
  });
  const snapshot = researchExperimentEnvironmentSchema.parse({...value, hash: researchContentHash(JSON.stringify(value))});
  return {snapshot, python, typescriptRuntime: null,
    readablePaths: [...controls.codeRoots, ...controls.controls.map(file => file.path)],
    environment: {PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: jobDir}};
}
