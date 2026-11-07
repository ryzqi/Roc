import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { LangChainModelFactory } = await importTypeScriptModule('src/main/services/langchain-model-factory.ts', {
  platform: 'node',
  external: ['@langchain/*', 'p-retry'],
  tempDir: '.runtime/test-bundles'
});
const factory = new LangChainModelFactory({}, { getProviderSecret: async () => 'fixture-key' });

function provider(type, options = {}, modelId = 'fixture-model') {
  return {
    id: 'fixture', name: 'Fixture', type, enabled: true,
    endpoint: 'http://127.0.0.1:1/v1', credentialRef: 'secret:fixture',
    models: [{ id: modelId, enabled: true, options }]
  };
}

test('OpenAI model options reach the SDK and preserve explicit zero and false values', async () => {
  const config = provider('openai_compatible', {
    temperature: 0, topP: 0.5, presencePenalty: 0, frequencyPenalty: 0.2,
    seed: 0, parallelToolCalls: false, streamUsage: false,
    stop: ['END'], reasoning: { effort: 'low' }, modelKwargs: { custom_field: 'fixture' },
    contextBudgetTokens: 8192, maxTokens: 1024
  });
  const { model, runtime } = await factory.createModelForProvider(config, 'fixture-model');
  const params = model.invocationParams({});
  assert.equal(params.temperature, 0);
  assert.equal(params.top_p, 0.5);
  assert.equal(params.presence_penalty, 0);
  assert.equal(params.frequency_penalty, 0.2);
  assert.equal(params.seed, 0);
  assert.equal(params.parallel_tool_calls, false);
  assert.deepEqual(params.stop, ['END']);
  assert.equal(params.custom_field, 'fixture');
  assert.equal(model.streamUsage, false);
  assert.deepEqual(model.reasoning, { effort: 'low' });
  assert.equal(runtime.contextBudgetTokens, 8192);
  assert.equal(runtime.maxOutputTokens, 1024);
});

test('provider-specific options stay scoped to NVIDIA and OpenAI', async () => {
  const options = {
    thinking: true, includeReasoning: true, topK: 12, minP: 0.1,
    repetitionPenalty: 1.1, guidedRegex: '[a-z]+',
    modelKwargs: { openai_only: true }, seed: 0, parallelToolCalls: false
  };
  const nvidia = await factory.createModelForProvider(provider('nvidia', options, 'deepseek-ai/deepseek-r1'), 'deepseek-ai/deepseek-r1', { streaming: false });
  assert.equal(nvidia.runtime.modelKwargs.reasoning_effort, 'medium');
  assert.equal(nvidia.runtime.modelKwargs.include_reasoning, true);
  assert.equal(nvidia.runtime.modelKwargs.top_k, 12);
  assert.equal(nvidia.runtime.modelKwargs.seed, 0);
  assert.deepEqual(nvidia.runtime.modelKwargs.nvext, { guided_regex: '[a-z]+' });
  assert.equal(nvidia.runtime.modelKwargs.openai_only, undefined);
  const router = await factory.createModelForProvider(provider('openrouter', options), 'fixture-model');
  assert.deepEqual(router.runtime.modelKwargs, {});
  assert.equal(router.model.invocationParams({}).seed, undefined);
  assert.equal(router.model.invocationParams({}).parallel_tool_calls, undefined);
});

test('llama.cpp keeps sampling fallbacks, explicit overrides and forced streaming', async () => {
  const config = provider('llama_cpp', {
    temperature: 0, topP: 0.8, presencePenalty: 0,
    samplingProfileOverrides: { temperature: 0.9, topP: 0.95, topK: 20, minP: 0.05, repeatPenalty: 1.2 },
    contextBudgetTokens: 8192, maxTokens: 2048
  });
  config.credentialRef = null;
  const { model, runtime } = await factory.createModelForProvider(config, 'fixture-model', { streaming: false, maxOutputTokens: 512 });
  assert.equal(model.temperature, 0);
  assert.equal(model.topP, 0.8);
  assert.equal(model.presencePenalty, 0);
  assert.equal(runtime.streaming, true);
  assert.equal(model.streamUsage, false);
  assert.equal(runtime.maxOutputTokens, 512);
  assert.deepEqual(runtime.modelKwargs, { cache_prompt: true, top_k: 20, min_p: 0.05, repeat_penalty: 1.2 });
});

test('Anthropic keeps thinking and stop parameters and rejects invalid thinking budgets', async () => {
  const options = { maxTokens: 4096, topK: 20, stop: ['END'], anthropicThinking: { mode: 'enabled', budgetTokens: 2048 } };
  const { model } = await factory.createModelForProvider(provider('anthropic_compatible', options), 'fixture-model');
  assert.deepEqual(model.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.deepEqual(model.stopSequences, ['END']);
  assert.equal(model.topK, 20);
  await assert.rejects(factory.createModelForProvider(provider('anthropic_compatible', { ...options, maxTokens: 1024 }), 'fixture-model'));
});

test('unsupported providers remain rejected', async () => {
  await assert.rejects(factory.createModelForProvider(provider('custom'), 'fixture-model'), /尚未支持 LangChain/);
});
