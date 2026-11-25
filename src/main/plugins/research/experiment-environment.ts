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
    private readonly pythonEnvironments: Pick<ResearchPythonEnvironmentService, 'resolve'>) {}

  async inspect(runtime: ResearchExperimentRuntime, jobDir: string, signal: AbortSignal, admission: ResearchProcessScope,
    onProbe: (receipt: ResearchEnvironmentProbeResource) => void): Promise<PreparedExperimentEnvironment> {
    signal.throwIfAborted();
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
    if (runtime.kind === 'python') {
      if (admission.projectId === null) throw new Error('research_python_selection_project_required');
      const python = await this.pythonEnvironments.resolve({
        projectId: admission.projectId, selectionId: runtime.selectionId, expectedHash: runtime.expectedHash
      }, jobDir, signal, admission, onProbe);
      const { controls, report, metadataHash, lockFile, codeReceipt } = python;
      const value = researchExperimentEnvironmentSchema.omit({ hash: true }).parse({
        runtime, executable: controls.selectedExecutable, prefix: report.prefix, basePrefix: report.basePrefix,
        version: report.version, platform: report.platform, architecture: report.architecture,
        toolchainHash: pythonExperimentToolchainHash(codeReceipt),
        metadataHash, packages: report.distributions, lockFiles: [lockFile]
      });
      const snapshot = researchExperimentEnvironmentSchema.parse({ ...value, hash: researchContentHash(JSON.stringify(value)) });
      signal.throwIfAborted();
      return { snapshot, python, typescriptRuntime: null,
        readablePaths: [...controls.codeRoots, ...controls.controls.map(file => file.path)],
        environment: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: jobDir } };
    }
    throw new Error('research_experiment_runtime_unsupported');
  }
}
