import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { createPluginCapabilityAdapter } from '../../../../src/main/ipc/plugin-capability-adapter';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { createResearchPlugin } from '../../../../src/main/plugins/research';
import { figureRenderer, figureRendererPath } from '../../../../src/main/plugins/research/figure-runner';
import { researchContentHash } from '../../../../src/main/plugins/research/research-files';
import { researchProjectSchema, researchWorkflowSnapshotSchema } from '../../../../src/shared/schemas/research';
import { researchClaimSchema, researchEvidenceSchema } from '../../../../src/shared/schemas/research-evidence';
import { researchFigurePublicationSchema } from '../../../../src/shared/schemas/research-figures';
import { researchExperimentEnvironmentSchema, researchExperimentExecutionSchema, researchExperimentFileContentSchema } from '../../../../src/shared/schemas/research-experiments';
import { researchFigureValidationSchema } from '../../../../src/shared/schemas/research-plotting';
import { verifySvgPreviews } from './figure-preview-helper';

const tools = process.env.ROC_RESEARCH_TOOLCHAIN;
const artifacts = process.env.ROC_RESEARCH_ARTIFACT_ROOT;
const options = { widthInches: 4, heightInches: 3, dpi: 150, seed: 42 };
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
  root = await realpath(await mkdtemp(join(artifacts ?? tmpdir(), 'roc figure integration-')));
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
  projectId = (await call('createProject', { title: 'Figure integration', description: 'Reproducible plots and approval.', workspacePath: workspace }, researchProjectSchema)).id;
  await writeFile(join(workspace, 'data.csv'), '1,2\n2,4\n3,8\n');
});
afterEach(async () => { await plugin.shutdown(); db.close(); if (artifacts === undefined) await rm(root, { recursive: true, force: true }); });

async function call<T>(method: string, input: unknown, schema: z.ZodType<T>): Promise<T> {
  failure = undefined;
  const result = await adapter.invoke(`research.${method}`, [input]);
  if (!result.ok) throw new Error(`${method}: ${result.error.message}`, { cause: failure });
  return schema.parse(result.data);
}
async function render() {
  const runtime = { kind: 'bundled-python' };
  const environment = await call('inspectExperimentEnvironment', { projectId, runtime }, researchExperimentEnvironmentSchema);
  const initial = await call('startExperiment', { projectId, requestId: randomUUID(), label: 'Measured response', sourcePath: 'plot.py', engine: 'matplotlib',
    runtime, inputPaths: ['data.csv'], arguments: [], parameters: {}, expectedEnvironmentHash: environment.hash, timeoutMs: 30000, network: 'disabled', figure: options }, researchExperimentExecutionSchema);
  let latest = initial;
  await vi.waitFor(async () => {
    latest = await call('getExperiment', { projectId, runId: initial.id }, researchExperimentExecutionSchema);
    expect(['preparing', 'running']).not.toContain(latest.status);
  }, { timeout: 45000, interval: 50 });
  await writeFile(join(root, `${initial.id}-result.json`), JSON.stringify(latest, null, 2));
  if (latest.status === 'failed') {
    const log = await call('readExperimentFile', { projectId, runId: latest.id, area: 'log', path: 'stderr.txt' }, researchExperimentFileContentSchema);
    await writeFile(join(root, `${initial.id}-stderr.txt`), log.content);
  }
  return latest;
}

const plot = `import json, os
from pathlib import Path
import matplotlib.pyplot as plt
import numpy as np
data = np.loadtxt('data.csv', delimiter=',')
figure, axes = plt.subplots(layout='constrained')
axes.plot(data[:, 0], data[:, 1] + np.random.normal(0, 0.05, len(data)), marker='o')
axes.set(xlabel='Input', ylabel='Response', title='Measured response')
Path(os.environ['ROC_OUTPUT_DIR'], 'measurements.json').write_text(json.dumps({'maximum': float(data[:, 1].max())}), encoding='utf-8')
print('Plotted maximum 8')
`;

describe.skipIf(tools === undefined)('actual research figure rendering', () => {
  it('renders the same code and data to byte-identical PNG SVG PDF with frozen renderer and dimensions', async () => {
    await writeFile(join(workspace, 'plot.py'), plot);
    const first = await render();
    expect(first).toMatchObject({ status: 'completed', exitCode: 0, error: null });
    const second = await render();
    expect(second.status).toBe('completed');
    expect(first.inputHash).toBe(second.inputHash);
    const outputs = (run: typeof first) => run.files.filter((file) => file.area === 'output');
    expect(outputs(first)).toEqual(outputs(second));
    expect(first.files.find((file) => file.path === figureRendererPath)).toMatchObject({ area: 'input', sha256: researchContentHash(figureRenderer) });
    const report = researchFigureValidationSchema.parse(JSON.parse(await readFile(join(root, 'runs', first.id, 'output/figure-validation.json'), 'utf8')));
    expect(report).toMatchObject({ options, widthPixels: 600, heightPixels: 450, widthPoints: 288, heightPoints: 216, pageCount: 1 });
    expect(report.files.map((file) => file.path).sort()).toEqual(['figure.pdf', 'figure.png', 'figure.svg']);
  }, 90000);

  it('validates output in a fresh interpreter and preserves script logs when a forged figure fails', async () => {
    await writeFile(join(workspace, 'plot.py'), "from matplotlib.figure import Figure\nfrom pathlib import Path\nfigure = Figure()\nfigure.savefig = lambda path, **kwargs: Path(path).write_text('forged bytes', encoding='utf-8')\nprint('before validation')\n");
    const run = await render();
    expect(run).toMatchObject({ status: 'failed', error: 'research_figure_validation_failed' });
    const log = await call('readExperimentFile', { projectId, runId: run.id, area: 'log', path: 'stdout.txt' }, researchExperimentFileContentSchema);
    expect(log.content).toContain('before validation');
    expect(run.files.some((file) => file.path === 'figure-validation.json')).toBe(false);
  }, 60000);

  it('publishes, previews and approves a real figure only while its frozen files and evidence remain valid', async () => {
    await writeFile(join(workspace, 'plot.py'), plot);
    const run = await render();
    expect(run.status).toBe('completed');
    await call('transitionWorkflow', { projectId, expectedStage: 'discovery', action: 'move', targetStage: 'figure' }, researchWorkflowSnapshotSchema);
    const published = await call('publishFigure', { projectId, runId: run.id, replacesFigureId: null }, researchFigurePublicationSchema);
    expect(published.status).toBe('rendered');
    expect(await call('listFigures', { projectId, limit: 10 }, researchFigurePublicationSchema.array())).toEqual([published]);
    const png = published.validation.files.find((file) => file.path === 'figure.png')!;
    const source = { projectId, figureId: published.id, format: 'png', sha256: png.sha256 };
    const response = await capabilities.invoke<typeof source, Response>('research.figure.source', source);
    expect(response.headers.get('content-type')).toBe('image/png');
    const original = Buffer.from(await response.arrayBuffer());
    expect(researchContentHash(original)).toBe(png.sha256);
    await call('transitionWorkflow', { projectId, expectedStage: 'figure', action: 'start' }, researchWorkflowSnapshotSchema);
    await expect(call('transitionWorkflow', { projectId, expectedStage: 'figure', action: 'complete' }, researchWorkflowSnapshotSchema))
      .rejects.toMatchObject({ cause: { message: 'research_figure_evidence_required' } });
    const evidence = await call('captureEvidence', { projectId, chunkId: `experiment:${run.id}:output:measurements.json:chunk:0` }, researchEvidenceSchema);
    await call('createClaim', { projectId, artifactId: published.artifactId, subjectType: 'figure', content: 'The maximum measured response is 8.', status: 'supported', evidenceIds: [evidence.id] }, researchClaimSchema);
    const waiting = await call('transitionWorkflow', { projectId, expectedStage: 'figure', action: 'complete' }, researchWorkflowSnapshotSchema);
    expect(waiting.stages.find((stage) => stage.stage === 'figure')?.status).toBe('waiting_approval');
    const output = join(root, 'runs', run.id, 'output/figure.png');
    await writeFile(output, 'changed since review');
    await expect(call('transitionWorkflow', { projectId, expectedStage: 'figure', action: 'approve' }, researchWorkflowSnapshotSchema))
      .rejects.toMatchObject({ cause: { message: 'research_experiment_snapshot_changed' } });
    await writeFile(output, original);
    expect((await call('getFigure', { projectId, figureId: published.id }, researchFigurePublicationSchema)).status).toBe('rendered');
    await call('transitionWorkflow', { projectId, expectedStage: 'figure', action: 'approve' }, researchWorkflowSnapshotSchema);
    expect((await call('getFigure', { projectId, figureId: published.id }, researchFigurePublicationSchema)).status).toBe('approved');
    await writeFile(join(workspace, 'data.csv'), 'changed workspace data');
    expect(researchContentHash(Buffer.from(await (await capabilities.invoke<typeof source, Response>('research.figure.source', source)).arrayBuffer()))).toBe(png.sha256);
    await writeFile(join(root, 'figure-review-result.json'), JSON.stringify({ runId: run.id, figureId: published.id, artifactId: published.artifactId, evidenceId: evidence.id, status: 'approved' }, null, 2));
  }, 60000);

  it('keeps ordinary SVG text and displays embedded heatmap pixels before and after publication', async () => {
    await writeFile(join(workspace, 'plot.py'), `import matplotlib
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap
matplotlib.rcParams['svg.fonttype'] = 'none'
figure, axes = plt.subplots(layout='constrained')
axes.imshow([[1, 1], [1, 1]], cmap=ListedColormap(['#ff0000']), vmin=0, vmax=1)
axes.set_title('Frequency of url(...) tokens')
`);
    const run = await render();
    expect(run).toMatchObject({ status: 'completed', error: null });
    await call('transitionWorkflow', { projectId, expectedStage: 'discovery', action: 'move', targetStage: 'figure' }, researchWorkflowSnapshotSchema);
    const figure = await call('publishFigure', { projectId, runId: run.id, replacesFigureId: null }, researchFigurePublicationSchema);
    const svg = figure.validation.files.find((file) => file.path === 'figure.svg')!;
    const figureResponse = await capabilities.invoke<unknown, Response>('research.figure.source', { projectId, figureId: figure.id, format: 'svg', sha256: svg.sha256 });
    const experimentResponse = await capabilities.invoke<unknown, Response>('research.experiment.source', { projectId, runId: run.id, area: 'output', path: svg.path, sha256: svg.sha256 });
    const content = await figureResponse.clone().text();
    expect(content).toContain('data:image/png;base64,');
    expect(content).toContain('Frequency of url(...) tokens');
    await verifySvgPreviews({ figure: figureResponse, experiment: experimentResponse }, join(root, 'svg-preview'));
  }, 90000);

  it('still rejects SVG hyperlinks to external resources', async () => {
    await writeFile(join(workspace, 'plot.py'), "import matplotlib.pyplot as plt\nfigure, axes = plt.subplots()\nline, = axes.plot([1, 2], [3, 4])\nline.set_url('https://example.invalid/remote-resource')\n");
    const run = await render();
    expect(run).toMatchObject({ status: 'failed', error: 'research_figure_validation_failed' });
    const diagnostics = await call('readExperimentFile', { projectId, runId: run.id, area: 'log', path: 'stderr.txt' }, researchExperimentFileContentSchema);
    expect(diagnostics.content).toContain('research_figure_svg_external_resource');
  }, 60000);
});
