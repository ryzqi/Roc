import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { z } from 'zod';
import type { ResearchExperimentExecution, ResearchExperimentFile } from '../../../shared/schemas/research-experiments';
import { researchFigureStartSchema, type ResearchFigurePublication, type ResearchFigureStart, researchFigureSourceRequestSchema } from '../../../shared/schemas/research-figures';
import { researchFigureValidationSchema } from '../../../shared/schemas/research-plotting';
import { collectExperimentFiles, experimentFileLimit, snapshotExperimentInputs } from './experiment-files';
import type { ResearchExperimentService } from './experiment-service';
import { assertFigureRun, figureManifest, figureManifestPath } from './figure-repository';
import { assertFigureEnvironment, figureGeneratedInputs, figureProcessCommand, figureValidationPath, finishFigureOutput } from './figure-runner';
import { ResearchProcessError } from './process-runner';
import { writeFrozenManifest } from './research-frozen-manifest';
import { ResearchJobSession } from './research-job-session';
import { createResearchDirectory, readResearchFile, researchContentHash } from './research-files';
import type { ResearchRepository } from './repository';

export class ResearchFigureService {
  private readonly session = new ResearchJobSession('research_figure_service_closed');
  constructor(private readonly repository: ResearchRepository, private readonly experiments: ResearchExperimentService) {}

  async inspect(projectId: string, runtime: ResearchFigureStart['runtime']) {
    return this.experiments.inspect(projectId, runtime);
  }

  async start(input: ResearchFigureStart): Promise<ResearchExperimentExecution> {
    const request = researchFigureStartSchema.parse(input);
    return await this.experiments.enqueue({
      ...request,
      engine: 'matplotlib',
      network: 'disabled',
      figure: request.figure
    }, (run, signal) => this.execute(run, signal));
  }

  async cancel(projectId: string, runId: string): Promise<ResearchExperimentExecution> {
    return this.experiments.cancel(projectId, runId);
  }

  getRun(projectId: string, runId: string): ResearchExperimentExecution {
    return this.repository.experiments.get(projectId, runId);
  }

  async publish(projectId: string, runId: string, replacesFigureId: string | null): Promise<ResearchFigurePublication> {
    return await this.session.guard(async () => this.publishRun(projectId, runId, replacesFigureId));
  }

  private async publishRun(projectId: string, runId: string, replacesFigureId: string | null): Promise<ResearchFigurePublication> {
    this.session.requireOpen();
    const run = await this.experiments.snapshot(projectId, runId);
    const validation = await this.validation(projectId, runId);
    assertFigureRun(run, validation);
    const content = figureManifest(run, validation);
    const hash = await writeFrozenManifest({
      root: this.repository.experiments.root(projectId, runId),
      path: figureManifestPath,
      content,
      limit: experimentFileLimit,
      changedCode: 'research_figure_manifest_changed'
    });
    this.session.requireOpen();
    return this.repository.figures.publish(projectId, runId, replacesFigureId, validation, hash);
  }

  async verify(projectId: string, figureId: string): Promise<ResearchFigurePublication> {
    this.session.requireOpen();
    const record = this.repository.figures.get(projectId, figureId);
    const run = await this.experiments.snapshot(projectId, record.runId);
    const validation = await this.validation(projectId, record.runId);
    assertFigureRun(run, validation);
    const bytes = await readResearchFile(this.repository.experiments.root(projectId, record.runId), figureManifestPath, experimentFileLimit);
    if (researchContentHash(bytes) !== record.manifestHash || researchContentHash(figureManifest(run, validation)) !== record.manifestHash) throw new Error('research_figure_manifest_changed');
    return record;
  }

  async verifyStage(projectId: string): Promise<void> {
    await this.session.guard(async () => {
      const stage = this.repository.getWorkflow(projectId).stages.find((entry) => entry.stage === 'figure');
      if (stage === undefined) throw new Error('research_stage_not_found');
      for (const id of stage.artifactIds) {
        const record = this.repository.figures.forArtifact(this.repository.getArtifact(id));
        await this.verify(projectId, record.id);
      }
      this.session.requireOpen();
    });
  }

  async source(input: z.infer<typeof researchFigureSourceRequestSchema>): Promise<Buffer> {
    this.session.requireOpen();
    const figure = this.repository.figures.get(input.projectId, input.figureId);
    const expected = figure.validation.files.find((file) => file.path === `figure.${input.format}`);
    if (expected === undefined || expected.sha256 !== input.sha256) throw new Error('research_figure_output_changed');
    const manifest = await readResearchFile(this.repository.experiments.root(input.projectId, figure.runId), figureManifestPath, experimentFileLimit);
    if (researchContentHash(manifest) !== figure.manifestHash) throw new Error('research_figure_manifest_changed');
    const { bytes, file } = await this.experiments.source({ projectId: input.projectId, runId: figure.runId, area: 'output', path: expected.path });
    if (file.sha256 !== expected.sha256 || file.size !== expected.size) throw new Error('research_figure_output_changed');
    return bytes;
  }

  async shutdown(): Promise<void> { await this.session.shutdown(); }

  private async execute(initial: ResearchExperimentExecution, signal: AbortSignal): Promise<void> {
    const root = this.repository.experiments.root(initial.projectId, initial.id);
    let files: ResearchExperimentFile[] = [];
    let output = { exitCode: 1, stdout: '', stderr: '' };
    let failure: unknown;
    let prepared: Awaited<ReturnType<ResearchExperimentService['inspectWorkspace']>> | null = null;
    try {
      const workspace = await this.experiments.verifyRun(initial, signal);
      await mkdir(root, { mode: 0o700 });
      const input = await createResearchDirectory(root, 'input');
      const out = await createResearchDirectory(root, 'output');
      const scratch = await createResearchDirectory(root, 'scratch');
      await createResearchDirectory(root, 'log');
      prepared = await this.experiments.inspectWorkspace(workspace, initial.request.runtime, scratch, signal);
      if (prepared.snapshot.hash !== initial.request.expectedEnvironmentHash) throw new Error('research_experiment_environment_changed');
      assertFigureEnvironment(prepared.snapshot.packages);
      const snapshot = await snapshotExperimentInputs(workspace, input, initial.request, prepared.snapshot, signal, figureGeneratedInputs());
      files = snapshot.files;
      await this.experiments.verifyRun(initial, signal);
      this.repository.experiments.start(initial.projectId, initial.id, prepared.snapshot, files, snapshot.hash);
      const command = figureProcessCommand(initial, prepared, input, out);
      const executable = prepared.snapshot.executable;
      output = await this.experiments.runProcess({
        command: command.command, args: command.args, additionalExecutables: [executable], cwd: input,
        readablePaths: [...prepared.readablePaths, input], writablePaths: [out, scratch],
        environment: {
          ...prepared.environment, PYTHONUNBUFFERED: '1', PATH: `${dirname(executable)}:${prepared.environment.PATH}`,
          ROC_INPUT_DIR: input, ROC_OUTPUT_DIR: out, ROC_PARAMETERS_JSON: JSON.stringify(initial.request.parameters),
          ...command.environment
        },
        timeoutMs: initial.request.timeoutMs, signal, allowOcrAcceleration: false, allowPosixSpawn: false, networkAccess: 'none'
      });
      if (output.exitCode !== 0) throw new Error('research_experiment_process_failed');
      await finishFigureOutput(initial, out, signal);
      await this.experiments.verifyRun(initial, signal);
      const current = await this.experiments.inspectWorkspace(workspace, initial.request.runtime, scratch, signal);
      if (current.snapshot.hash !== prepared.snapshot.hash) throw new Error('research_experiment_environment_changed');
    } catch (error) {
      failure = error;
      if (error instanceof ResearchProcessError) output = { exitCode: 1, stdout: output.stdout + error.stdout, stderr: output.stderr + error.stderr };
    }
    try {
      await createResearchDirectory(root, 'log');
      await writeFile(join(root, 'log/stdout.txt'), output.stdout, { flag: 'wx', mode: 0o400 });
      await writeFile(join(root, 'log/stderr.txt'), output.stderr, { flag: 'wx', mode: 0o400 });
      files.push(...await collectExperimentFiles(join(root, 'log'), 'log'));
      if (prepared !== null) files.push(...await collectExperimentFiles(join(root, 'output'), 'output'));
      const status = signal.aborted ? this.session.isClosed ? 'interrupted' : 'cancelled' : failure === undefined ? 'completed' : 'failed';
      const error = signal.aborted ? this.session.isClosed ? 'research_experiment_interrupted' : 'research_experiment_cancelled' : failure === undefined ? null : errorCode(failure);
      this.repository.experiments.finish(initial.projectId, initial.id, { status, files, exitCode: prepared === null ? null : output.exitCode, error });
    } catch (error) {
      this.repository.experiments.finish(initial.projectId, initial.id, {
        status: signal.aborted ? this.session.isClosed ? 'interrupted' : 'cancelled' : 'failed',
        files, exitCode: output.exitCode, error: errorCode(error)
      });
    } finally {
      await rm(join(root, 'scratch'), { recursive: true, force: true });
    }
  }

  private async validation(projectId: string, runId: string) {
    const { bytes } = await this.experiments.source({ projectId, runId, area: 'output', path: figureValidationPath });
    return researchFigureValidationSchema.parse(JSON.parse(bytes.toString('utf8')));
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error && /^research_[a-z0-9_]+$/u.test(error.message) ? error.message : 'research_figure_failed';
}
