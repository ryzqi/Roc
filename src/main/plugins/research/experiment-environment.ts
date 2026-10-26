import { dirname } from 'node:path';
import { researchExperimentEnvironmentSchema, type ResearchExperimentEnvironment, type ResearchExperimentStartRuntime } from '../../../shared/schemas/research-experiments';
import { researchContentHash } from './research-files';
import { runResearchProcess, type ResearchProcessRequest } from './process-runner';
import { inspectNativeExperimentEnvironment } from './experiment-native-environment';
import type { ResearchToolchain, ResearchTypeScriptRuntime } from './toolchain';

export type PreparedExperimentEnvironment = {
  snapshot: ResearchExperimentEnvironment;
  readablePaths: string[];
  environment: NodeJS.ProcessEnv;
  typescriptRuntime: ResearchTypeScriptRuntime | null;
};

export type NativeRuntime = Extract<ResearchExperimentStartRuntime, { kind: 'renv' | 'julia' }>;
export type NativeTools = Awaited<ReturnType<ResearchToolchain['nativeRuntime']>>;
type ProcessRun = (input: ResearchProcessRequest) => ReturnType<typeof runResearchProcess>;

export class ResearchExperimentEnvironmentService {
  constructor(private readonly tools: Pick<ResearchToolchain, 'nativeRuntime' | 'typescriptRuntime'>,
    private readonly run: ProcessRun = runResearchProcess) {}

  async inspect(root: string, runtime: ResearchExperimentStartRuntime, jobDir: string, signal: AbortSignal): Promise<PreparedExperimentEnvironment> {
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
      return { snapshot, readablePaths: [tools.runnerPath, ...tools.packageRoots], environment: tools.environment, typescriptRuntime: tools };
    }
    const tools = await this.tools.nativeRuntime(jobDir);
    return inspectNativeExperimentEnvironment({ workspace: root, runtime, jobDir, tools, run: this.run, signal });
  }
}
