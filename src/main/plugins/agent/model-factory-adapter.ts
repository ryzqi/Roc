import type { LangChainChatModelHandle, LangChainModelFactory } from '../../services/langchain-model-factory';

export type AgentModelHandle = {
  providerId: string;
  modelId: string;
  langChainHandle?: LangChainChatModelHandle;
};

export type AgentModelFactoryAdapter = {
  createDefaultModelHandle(): Promise<AgentModelHandle>;
  createModelHandleByProviderAndModel(input: { providerId: string; modelId: string }): Promise<AgentModelHandle>;
};

export class LangChainAgentModelFactoryAdapter implements AgentModelFactoryAdapter {
  constructor(
    private readonly factory: Pick<LangChainModelFactory, 'createChatModelByProviderAndModel' | 'createDefaultChatModel'>,
    private readonly options: { beforeCreate?: () => void } = {}
  ) {}

  async createDefaultModelHandle(): Promise<AgentModelHandle> {
    if (this.options.beforeCreate !== undefined) {
      this.options.beforeCreate();
    }
    const handle = await this.factory.createDefaultChatModel({ streaming: true });
    return {
      providerId: handle.provider.id,
      modelId: handle.modelId,
      langChainHandle: handle
    };
  }

  async createModelHandleByProviderAndModel(input: { providerId: string; modelId: string }): Promise<AgentModelHandle> {
    if (this.options.beforeCreate !== undefined) {
      this.options.beforeCreate();
    }
    const handle = await this.factory.createChatModelByProviderAndModel(input.providerId, input.modelId, { streaming: true });
    return {
      providerId: handle.provider.id,
      modelId: handle.modelId,
      langChainHandle: handle
    };
  }
}

export class StaticAgentModelFactoryAdapter implements AgentModelFactoryAdapter {
  constructor(
    private readonly handle: AgentModelHandle
  ) {}

  createDefaultModelHandle(): Promise<AgentModelHandle> {
    return Promise.resolve({
      ...this.handle
    });
  }

  createModelHandleByProviderAndModel(input: { providerId: string; modelId: string }): Promise<AgentModelHandle> {
    if (input.providerId !== this.handle.providerId || input.modelId !== this.handle.modelId) {
      throw new Error('static_model_handle_mismatch');
    }
    return Promise.resolve({
      ...this.handle
    });
  }
}
