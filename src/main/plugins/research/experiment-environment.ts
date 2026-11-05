import { dirname, join } from 'node:path';
import { researchExperimentEnvironmentSchema, type ResearchExperimentEnvironment, type ResearchExperimentRuntime } from '../../../shared/schemas/research-experiments';
import { researchContentHash } from './research-files';
import { runResearchProcess, type ResearchProcessRequest } from './process-runner';
import { inspectNativeExperimentEnvironment } from './experiment-native-environment';
import type { ResearchProcessScope, ResearchToolchain, ResearchTypeScriptRuntime } from './toolchain';
import type { NativeCodeReceipt } from './experiment-native-code-schema';
import type { ResearchEnvironmentProbeResource } from '../../../shared/schemas/research-process-resources';
import type { ResearchPythonEnvironmentService } from './python-environment-service';
import type { InspectedPythonEnvironment } from './experiment-python-probe';

export type PreparedExperimentEnvironment = {
  snapshot: ResearchExperimentEnvironment;
  readablePaths: string[];
  environment: NodeJS.ProcessEnv;
  typescriptRuntime: ResearchTypeScriptRuntime | null;
  nativeCode: NativeCodeReceipt | null;
  python: InspectedPythonEnvironment | null;
};

export type NativeRuntime = Extract<ResearchExperimentRuntime, { kind: 'renv' | 'julia' }>;
export type NativeTools = Awaited<ReturnType<ResearchToolchain['nativeRuntime']>>;
type ProcessRun = (input: ResearchProcessRequest) => ReturnType<typeof runResearchProcess>;

export class ResearchExperimentEnvironmentService {
  constructor(private readonly tools: Pick<ResearchToolchain, 'nativeRuntime' | 'typescriptRuntime'>,
    private readonly pythonEnvironments: Pick<ResearchPythonEnvironmentService, 'resolve'>,
    private readonly run: ProcessRun = runResearchProcess) {}

  async inspect(root: string, runtime: ResearchExperimentRuntime, jobDir: string, signal: AbortSignal, admission: ResearchProcessScope,
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
      return { snapshot, readablePaths: [tools.runnerPath, frameworks, ...tools.packageRoots], environment: tools.environment, typescriptRuntime: tools, nativeCode: null, python: null };
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
        toolchainHash: researchContentHash(JSON.stringify({
          inspectionContractVersion: codeReceipt.metadataIdentity.inspectionContractVersion,
          probe: codeReceipt.metadataIdentity.probe
        })),
        metadataHash, packages: report.distributions, lockFiles: [lockFile]
      });
      const snapshot = researchExperimentEnvironmentSchema.parse({ ...value, hash: researchContentHash(JSON.stringify(value)) });
      signal.throwIfAborted();
      return { snapshot, python, nativeCode: null, typescriptRuntime: null,
        readablePaths: [...controls.codeRoots, ...controls.controls.map(file => file.path)],
        environment: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: jobDir } };
    }
    const tools = await this.tools.nativeRuntime(jobDir);
    return inspectNativeExperimentEnvironment({ workspace: root, runtime, jobDir, tools, run: this.run, signal, admission, onProbe });
  }
}
