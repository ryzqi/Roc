import Database from 'better-sqlite3';
import { ToolMessage } from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { StaticAgentModelFactoryAdapter } from '../../../../src/main/plugins/agent/model-factory-adapter';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { ResearchExperimentService } from '../../../../src/main/plugins/research/experiment-service';
import type { PreparedExperimentEnvironment } from '../../../../src/main/plugins/research/experiment-environment';
import { ResearchProductionInputService } from '../../../../src/main/plugins/research/production-input-service';
import { registerResearchProductionInputCapabilities, researchProductionInputCapabilities } from '../../../../src/main/plugins/research/production-input-capabilities';
import { createResearchRoleTools } from '../../../../src/main/plugins/research/role-tools';
import { createResearchRoleExecutor } from '../../../../src/main/plugins/research/role-executor';
import { createResearchHumanGate } from '../../../../src/main/plugins/research/human-gate';
import { ResearchStageRuntime } from '../../../../src/main/plugins/research/stage-runtime';
import type { ResearchStageOutput } from '../../../../src/shared/types';
import { createProviderTestServices } from '../../provider-test-fixture';

let root: string;
let workspace: string;
let db: Database.Database;
let repository: ResearchRepository;
let experiments: ResearchExperimentService;
let inputs: ResearchProductionInputService;
let capabilities: CapabilityRegistry;
let projectId: string;
let artifactId: string;
let experimentId: string;
const environment: PreparedExperimentEnvironment = {
  snapshot: { runtime: { kind: 'bundled-python' }, executable: '/python/bin/python', prefix: '/python', basePrefix: '/python', version: '3.12.14', platform: 'darwin', architecture: 'arm64',
    toolchainHash: 'a'.repeat(64), metadataHash: 'b'.repeat(64), packages: [], lockFiles: [], hash: 'c'.repeat(64) },
  readablePaths: ['/python'], environment: { PATH: '/python/bin:/usr/bin' }, python: '/python/bin/python'
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'roc-production-input-')));
  workspace = join(root, 'workspace'); await mkdir(workspace); await writeFile(join(workspace, 'run.py'), 'print("42")');
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
  projectId = repository.createProject({ title: 'Input study', description: 'Real registered production inputs.', workspacePath: workspace }).id;
  experiments = new ResearchExperimentService(repository, { inspect: async () => environment }, join(root, 'runs'), { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, async (input) => {
    const output = input.environment.ROC_OUTPUT_DIR;
    if (output === undefined) throw new Error('output_required');
    await writeFile(join(output, 'result.csv'), 'signal\n42\n');
    await writeFile(join(output, 'binary.bin'), Buffer.from([0xff, 0x00, 0x80]));
    await writeFile(join(output, 'numeric.bin'), Buffer.from([0x01, 0x00, 0x02, 0x00]));
    await writeFile(join(output, 'ascii.pdf'), '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
    return { exitCode: 0, stdout: 'Measured signal: 42.\n', stderr: '' };
  });
  const run = await experiments.start({ projectId, requestId: randomUUID(), label: 'Measured signal', engine: 'python', runtime: { kind: 'bundled-python' },
    sourcePath: 'run.py', inputPaths: [], arguments: [], parameters: {}, expectedEnvironmentHash: environment.snapshot.hash, timeoutMs: 10000, network: 'disabled' });
  experimentId = run.id;
  await vi.waitFor(() => expect(repository.experiments.get(projectId, run.id).status).toBe('completed'));
  repository.transitionWorkflow({ projectId, expectedStage: 'discovery', action: 'move', targetStage: 'experiment' });
  const published = await experiments.publish(projectId, run.id);
  if (published.artifactId === null) throw new Error('artifact_required');
  artifactId = published.artifactId;
  inputs = new ResearchProductionInputService(repository, experiments, { verify: async () => { throw new Error('unexpected_figure'); } },
    { inspect: async () => { throw new Error('unexpected_export'); }, read: async () => { throw new Error('unexpected_export'); } });
  capabilities = new CapabilityRegistry();
  for (const capability of researchProductionInputCapabilities) capabilities.declare('research-test', capability);
  registerResearchProductionInputCapabilities({ pluginId: 'research-test', capabilities, database: { getConnection: () => db },
    config: { get: () => null, set: () => {} }, secrets: { get: () => null, set: () => {}, clear: () => {} }, eventBus: { publish: async () => {}, subscribe: () => () => {} },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }, inputs);
});
afterEach(async () => { await Promise.all([inputs.shutdown(), experiments.shutdown()]); db.close(); await rm(root, { recursive: true, force: true }); });

function approveInput(): void {
  repository.transitionWorkflow({ projectId, expectedStage: 'experiment', action: 'start' });
  repository.transitionWorkflow({ projectId, expectedStage: 'experiment', action: 'complete' });
  repository.transitionWorkflow({ projectId, expectedStage: 'experiment', action: 'approve' });
}
function writerTools() {
  approveInput();
  repository.transitionWorkflow({ projectId, expectedStage: 'figure', action: 'move', targetStage: 'writing' });
  const queued = repository.runs.begin({ projectId, expectedStage: 'writing', instruction: 'Read the approved data.', requestId: randomUUID() });
  const run = repository.runs.markRunning(queued.id, projectId, { providerId: 'test-provider', modelId: 'test-model' });
  const controller = new AbortController();
  const tools = createResearchRoleTools({ run, context: repository.runs.getContext(run.id), repository, capabilities, signal: controller.signal });
  const get = (name: string) => { const tool = tools.find((tool) => tool.name === name); if (tool === undefined) throw new Error('tool_required'); return tool; };
  return { run, controller, get };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe('approved production inputs', () => {
  it('requires approval and resolves a managed execution without trusting an arbitrary artifact path', async () => {
    await expect(inputs.inspect(projectId, artifactId)).rejects.toThrow('research_production_approval_required');
    approveInput();
    const result = await inputs.inspect(projectId, artifactId);
    expect(result.source).toMatchObject({ kind: 'experiment', execution: { id: experimentId, status: 'completed' } });
    expect(result.files).toContainEqual(expect.objectContaining({ area: 'output', path: 'result.csv', size: 10 }));
    expect((await inputs.read({ projectId, artifactId, area: 'output', path: 'result.csv' })).content).toBe('signal\n42\n');
    const other = repository.createProject({ title: 'Other', description: '', workspacePath: join(root, 'other-inputs') });
    await expect(inputs.inspect(other.id, artifactId)).rejects.toThrow('research_production_project_mismatch');
    await expect(inputs.read({ projectId, artifactId, area: 'bundle', path: 'result.csv' })).rejects.toThrow('research_production_file_not_found');
  });

  it('rejects altered registered files on inspection and reading', async () => {
    approveInput();
    await writeFile(join(root, 'runs', experimentId, 'output/result.csv'), 'signal\n999\n');
    await expect(inputs.inspect(projectId, artifactId)).rejects.toThrow('research_experiment_snapshot_changed');
    await expect(inputs.read({ projectId, artifactId, area: 'output', path: 'result.csv' })).rejects.toThrow('research_experiment_snapshot_changed');
  });

  it('binds production tools to captured inputs and pages real text without passing binary bytes to the model', async () => {
    const { get } = writerTools();
    const listing = await get('inspect_production_input').invoke({ artifactId, section: 'files', offset: 0, limit: 8000 });
    expect(listing).toMatchObject({ artifactId, section: 'files', nextOffset: null });
    expect(JSON.parse(listing.content)).toContainEqual(expect.objectContaining({ area: 'output', path: 'result.csv' }));
    expect(await get('read_production_input_file').invoke({ artifactId, area: 'output', path: 'result.csv', offset: 7, limit: 3 }))
      .toMatchObject({ content: '42\n', totalChars: 10, nextOffset: null, binary: false });
    const binary = await get('read_production_input_file').invoke({ artifactId, area: 'output', path: 'binary.bin', offset: 0, limit: 100 });
    expect(binary).toMatchObject({ binary: true, file: { size: 3 } });
    expect(Object.hasOwn(binary, 'content')).toBe(false);
    await expect(get('inspect_production_input').invoke({ artifactId: 'not-captured', section: 'summary', offset: 0, limit: 8000 })).rejects.toThrow('research_artifact_not_in_run_inputs');
    await expect(get('read_production_input_file').invoke({ projectId: 'other', artifactId, area: 'output', path: 'result.csv', offset: 0, limit: 10 })).rejects.toThrow();
  });

  it('refuses archived or stale runs even while a tool handle still holds the original running snapshot', async () => {
    const { get } = writerTools();
    repository.updateProject({ id: projectId, status: 'archived' });
    await expect(get('inspect_production_input').invoke({ artifactId, section: 'summary', offset: 0, limit: 1000 })).rejects.toThrow('research_run_not_current');
    await expect(get('capture_evidence').invoke({ chunkId: `experiment:${experimentId}:output:result.csv:chunk:0` })).rejects.toThrow('research_run_not_current');
  });

  it.each(['numeric.bin', 'ascii.pdf'])('keeps %s out of model text even when its bytes decode as UTF-8', async (path) => {
    const { get } = writerTools();
    const result = await get('read_production_input_file').invoke({ artifactId, area: 'output', path, offset: 0, limit: 8000 });
    expect(result.binary).toBe(true);
    expect(Object.hasOwn(result, 'content')).toBe(false);
  });

  it('rejects a late asynchronous response after cancellation', async () => {
    const { get, controller } = writerTools();
    const entered = deferred<void>(); const release = deferred<void>(); const inspect = inputs.inspect.bind(inputs);
    vi.spyOn(inputs, 'inspect').mockImplementationOnce(async (...args) => { const result = await inspect(...args); entered.resolve(); await release.promise; return result; });
    const pending = get('inspect_production_input').invoke({ artifactId, section: 'summary', offset: 0, limit: 1000 });
    const assertion = expect(pending).rejects.toThrow();
    await entered.promise; controller.abort(); release.resolve(); await assertion;
  });

  it('feeds registered experiment text through the installed LangChain loop into an evidence-backed manuscript', async () => {
    approveInput();
    repository.transitionWorkflow({ projectId, expectedStage: 'figure', action: 'move', targetStage: 'writing' });
    const evidence = repository.evidence.capture({ projectId, chunkId: `experiment:${experimentId}:output:result.csv:chunk:0` });
    const roleTools = ['search_knowledge', 'list_evidence', 'read_artifact', 'capture_evidence', 'inspect_production_input', 'read_production_input_file'];
    class WritingModel extends FakeToolCallingModel {
      boundNames: string[] = [];
      private responseTool: string | null = null;
      constructor() {
        super({ toolCalls: [
          [{ name: 'inspect_production_input', args: { artifactId, section: 'files', offset: 0, limit: 8000 }, id: 'inspect-files' }],
          [{ name: 'read_production_input_file', args: { artifactId, area: 'output', path: 'result.csv', offset: 0, limit: 8000 }, id: 'read-data' }],
          []
        ] });
      }
      override bindTools(tools: Parameters<FakeToolCallingModel['bindTools']>[0]) {
        this.boundNames = tools.map((tool) => {
          const definition: unknown = Reflect.get(tool, 'function');
          const name: unknown = definition !== null && typeof definition === 'object' ? Reflect.get(definition, 'name') : Reflect.get(tool, 'name');
          if (typeof name !== 'string') throw new Error('test_tool_name_missing');
          return name;
        });
        const responseTool = this.boundNames.find((name) => !roleTools.includes(name));
        if (responseTool === undefined) throw new Error('test_response_tool_missing');
        this.responseTool = responseTool;
        return this;
      }
      override async _generate(...args: Parameters<FakeToolCallingModel['_generate']>) {
        const messages = args[0].filter(ToolMessage.isInstance);
        if (this.index === 1) {
          expect(messages.map((message) => message.tool_call_id)).toEqual(['inspect-files']);
          expect(String(messages[0].content)).toContain('result.csv');
        }
        if (this.index === 2) {
          const message = messages.find((entry) => entry.tool_call_id === 'read-data');
          if (message === undefined || typeof message.content !== 'string' || this.responseTool === null) throw new Error('test_read_result_required');
          const data = z.object({ content: z.string() }).parse(JSON.parse(message.content));
          expect(data.content).toBe('signal\n42\n');
          const content = `Measured signal: ${data.content.trim().split('\n')[1]}.`;
          const output: ResearchStageOutput = { title: 'Measured results', markdown: content, verdict: 'ready',
            claims: [{ subjectType: 'paragraph', content, status: 'supported', evidenceIds: [evidence.id] }],
            sections: [{ title: 'Results', claimIndexes: [0] }] };
          this.toolCalls[2] = [{ name: this.responseTool, args: output, id: 'manuscript-result' }];
        }
        const result = await super._generate(...args);
        result.generations[0].message.response_metadata = { model_name: 'writing-test-revision-1' };
        return result;
      }
    }
    const services = createProviderTestServices('roc-production-writing-');
    const provider = services.configService.getProviders().providers[0];
    if (provider === undefined) throw new Error('test_provider_missing');
    const model = new WritingModel();
    const runtime = new ResearchStageRuntime(repository, capabilities, createResearchRoleExecutor(new StaticAgentModelFactoryAdapter({
      providerId: provider.id, modelId: 'test-model', langChainHandle: { provider, model, modelId: 'test-model', runtime: {
        baseUrl: null, contextBudgetTokens: 32000, modelKwargs: {}, providerType: provider.type, streaming: false
      } }
    })), createResearchHumanGate({ repository }));
    try {
      const run = runtime.start({ projectId, expectedStage: 'writing', instruction: `Use the approved experiment and evidence ${evidence.id}.`, requestId: randomUUID() });
      await runtime.waitForIdle();
      const completed = repository.runs.get(run.id, projectId);
      expect(completed).toMatchObject({ status: 'completed', modelVersion: 'writing-test-revision-1', inputArtifactIds: [artifactId] });
      const manuscriptId = completed.outputArtifactIds[0];
      expect(repository.manuscripts.getManuscript(manuscriptId)?.latex).toContain('Measured signal: 42.');
      expect(repository.evidence.listClaims({ projectId, artifactId: manuscriptId })).toMatchObject([{ evidenceIds: [evidence.id], status: 'supported' }]);
      expect(repository.listProvenance({ projectId, subjectId: manuscriptId })).toContainEqual(expect.objectContaining({ sourceType: 'model_run', sourceId: run.id }));
      expect(repository.getWorkflow(projectId).stages.find((stage) => stage.stage === 'writing')?.status).toBe('waiting_approval');
      expect(model.boundNames).toEqual(expect.arrayContaining(roleTools));
      expect(model.boundNames).toHaveLength(roleTools.length + 1);
    } finally { await runtime.shutdown(); await services.cleanup(); }
  });

  it('waits for reads at shutdown and rejects the late return before querying closed state', async () => {
    approveInput();
    const entered = deferred<void>(); const release = deferred<void>(); const snapshot = experiments.snapshot.bind(experiments);
    vi.spyOn(experiments, 'snapshot').mockImplementationOnce(async (...args) => { const result = await snapshot(...args); entered.resolve(); await release.promise; return result; });
    const pending = inputs.inspect(projectId, artifactId);
    const assertion = expect(pending).rejects.toThrow('research_production_input_closed');
    await entered.promise;
    let closed = false; const closing = inputs.shutdown().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release.resolve(); await assertion; await closing;
  });
});
