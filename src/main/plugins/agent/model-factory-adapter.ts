import type { LangChainModelFactory } from '../../services/langchain-model-factory';

export type AgentModelHandle = {
  providerId: string;
  modelId: string;
};

export type AgentModelFactoryAdapter = {
  createDefaultModelHandle(): Promise<AgentModelHandle>;
  createModelHandleByModelId(modelId: string): Promise<AgentModelHandle>;
};

export class LangChainAgentModelFactoryAdapter implements AgentModelFactoryAdapter {
  constructor(private readonly factory: Pick<LangChainModelFactory, 'createChatModelByModelId' | 'createDefaultChatModel'>) {}

  async createDefaultModelHandle(): Promise<AgentModelHandle> {
    const handle = await this.factory.createDefaultChatModel({ streaming: true });
    return {
      providerId: handle.provider.id,
      modelId: handle.modelId
    };
  }

  async createModelHandleByModelId(modelId: string): Promise<AgentModelHandle> {
    const handle = await this.factory.createChatModelByModelId(modelId, { streaming: true });
    return {
      providerId: handle.provider.id,
      modelId: handle.modelId
    };
  }
}

export class StaticAgentModelFactoryAdapter implements AgentModelFactoryAdapter {
  constructor(private readonly handle: AgentModelHandle) {}

  createDefaultModelHandle(): Promise<AgentModelHandle> {
    return Promise.resolve(this.handle);
  }

  createModelHandleByModelId(modelId: string): Promise<AgentModelHandle> {
    return Promise.resolve({
      providerId: this.handle.providerId,
      modelId
    });
  }
}
