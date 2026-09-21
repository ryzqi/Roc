import Database from 'better-sqlite3';
import { FakeToolCallingModel } from 'langchain';
import { expect, it } from 'vitest';

import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { StaticAgentModelFactoryAdapter } from '../../../../src/main/plugins/agent/model-factory-adapter';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { createResearchRoleExecutor } from '../../../../src/main/plugins/research/role-executor';
import { createResearchHumanGate } from '../../../../src/main/plugins/research/human-gate';
import { ResearchStageRuntime } from '../../../../src/main/plugins/research/stage-runtime';
import type { ResearchStageOutput } from '../../../../src/shared/types';
import { createProviderTestServices } from '../../provider-test-fixture';

const output: ResearchStageOutput = { title: 'Search strategy', markdown: 'Use an explicit evidence corpus.', claims: [], sections: [], verdict: 'ready' };
const roleToolNames = ['search_knowledge', 'list_evidence', 'read_artifact'];

class StructuredResearchModel extends FakeToolCallingModel {
  boundNames: string[] = [];

  override bindTools(tools: Parameters<FakeToolCallingModel['bindTools']>[0]) {
    this.boundNames = tools.map((tool) => {
      const definition: unknown = Reflect.get(tool, 'function');
      const name: unknown = definition !== null && typeof definition === 'object'
        ? Reflect.get(definition, 'name') : Reflect.get(tool, 'name');
      if (typeof name !== 'string') throw new Error('test_tool_name_missing');
      return name;
    });
    const responseTool = this.boundNames.find((name) => !roleToolNames.includes(name));
    if (responseTool === undefined) throw new Error('test_response_tool_missing');
    this.toolCalls = [[{ name: responseTool, args: output, id: 'structured-result' }]];
    return this;
  }

  override async _generate(...args: Parameters<FakeToolCallingModel['_generate']>) {
    const result = await super._generate(...args);
    result.generations[0].message.response_metadata = { model_name: 'test-model-revision-1' };
    return result;
  }
}

it('runs the installed LangChain agent with structured output and only role-authorized tools', async () => {
  const services = createProviderTestServices('roc-research-executor-');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db);
  const repository = new ResearchRepository(db);
  const provider = services.configService.getProviders().providers[0];
  if (provider === undefined) throw new Error('test_provider_missing');
  const model = new StructuredResearchModel();
  const executor = createResearchRoleExecutor(new StaticAgentModelFactoryAdapter({
    providerId: provider.id, modelId: 'test-model',
    langChainHandle: { provider, model, modelId: 'test-model', runtime: {
      baseUrl: null, contextBudgetTokens: 32000, modelKwargs: {}, providerType: provider.type, streaming: false
    } }
  }));
  const runtime = new ResearchStageRuntime(repository, new CapabilityRegistry(), executor, createResearchHumanGate({ repository }));
  try {
    const project = repository.createProject({ title: 'SDK test', description: 'Exercise the real SDK loop.', workspacePath: '/tmp/role-executor.test-1' });
    const run = runtime.start({ projectId: project.id, expectedStage: 'discovery', instruction: 'Plan the search.', requestId: 'sdk' });
    await runtime.waitForIdle();
    const completed = repository.runs.get(run.id, project.id);
    expect(completed).toMatchObject({ status: 'completed', modelVersion: 'test-model-revision-1' });
    expect(repository.runs.getArtifactContent(project.id, completed.outputArtifactIds[0])?.output).toEqual(output);
    expect(model.boundNames).toEqual(expect.arrayContaining(roleToolNames));
    expect(model.boundNames).toHaveLength(roleToolNames.length + 1);
    expect(model.boundNames).not.toContain('write_file');
  } finally {
    await runtime.shutdown();
    db.close();
    await services.cleanup();
  }
});
