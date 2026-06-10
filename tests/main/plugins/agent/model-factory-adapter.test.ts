import { describe, expect, it, vi } from 'vitest';

import { LangChainAgentModelFactoryAdapter } from '../../../../src/main/plugins/agent/model-factory-adapter';
import type {
  LangChainChatModelHandle,
  LangChainModelFactory
} from '../../../../src/main/services/langchain-model-factory';

describe('LangChainAgentModelFactoryAdapter', () => {
  it('creates default LangChain handles with streaming enabled for DeepAgent runs', async () => {
    const handle = createLangChainHandle('nvidia:test-model');
    const factory = createFactory(handle);
    const adapter = new LangChainAgentModelFactoryAdapter(factory);

    const modelHandle = await adapter.createDefaultModelHandle();

    expect(factory.createDefaultChatModel).toHaveBeenCalledWith({ streaming: true });
    expect(modelHandle).toEqual({
      providerId: 'nvidia',
      modelId: 'nvidia:test-model',
      langChainHandle: handle
    });
  });

  it('creates selected LangChain handles with streaming enabled for DeepAgent resumes', async () => {
    const handle = createLangChainHandle('nvidia:selected-model');
    const factory = createFactory(handle);
    const adapter = new LangChainAgentModelFactoryAdapter(factory);

    const modelHandle = await adapter.createModelHandleByModelId('nvidia:selected-model');

    expect(factory.createChatModelByModelId).toHaveBeenCalledWith('nvidia:selected-model', { streaming: true });
    expect(modelHandle).toEqual({
      providerId: 'nvidia',
      modelId: 'nvidia:selected-model',
      langChainHandle: handle
    });
  });
});

function createFactory(handle: LangChainChatModelHandle): Pick<LangChainModelFactory, 'createChatModelByModelId' | 'createDefaultChatModel'> {
  return {
    createChatModelByModelId: vi.fn(async () => handle),
    createDefaultChatModel: vi.fn(async () => handle)
  };
}

function createLangChainHandle(modelId: string): LangChainChatModelHandle {
  return {
    provider: {
      id: 'nvidia',
      type: 'nvidia'
    } as never,
    modelId,
    model: {} as never,
    runtime: {
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      contextBudgetTokens: 128_000,
      modelKwargs: {},
      providerType: 'nvidia',
      streaming: true
    }
  };
}
