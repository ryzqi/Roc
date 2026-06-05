import type { LangChainModelFactory } from '../../services/langchain-model-factory';

export type AgentModelHandle = {
  providerId: string;
  modelId: string;
  invoke(input: string): Promise<string>;
};

export type AgentModelFactoryAdapter = {
  createDefaultModelHandle(): Promise<AgentModelHandle>;
  createModelHandleByModelId(modelId: string): Promise<AgentModelHandle>;
};

export class LangChainAgentModelFactoryAdapter implements AgentModelFactoryAdapter {
  constructor(
    private readonly factory: Pick<LangChainModelFactory, 'createChatModelByModelId' | 'createDefaultChatModel'>,
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
      invoke: async (input) => readModelResponseText(await handle.model.invoke(input))
    };
  }

  async createModelHandleByModelId(modelId: string): Promise<AgentModelHandle> {
    if (this.options.beforeCreate !== undefined) {
      this.options.beforeCreate();
    }
    const handle = await this.factory.createChatModelByModelId(modelId, { streaming: true });
    return {
      providerId: handle.provider.id,
      modelId: handle.modelId,
      invoke: async (input) => readModelResponseText(await handle.model.invoke(input))
    };
  }
}

export class StaticAgentModelFactoryAdapter implements AgentModelFactoryAdapter {
  constructor(
    private readonly handle: Omit<AgentModelHandle, 'invoke'>,
    private readonly responseText = 'Static agent response.'
  ) {}

  createDefaultModelHandle(): Promise<AgentModelHandle> {
    return Promise.resolve({
      ...this.handle,
      invoke: async () => this.responseText
    });
  }

  createModelHandleByModelId(modelId: string): Promise<AgentModelHandle> {
    return Promise.resolve({
      providerId: this.handle.providerId,
      modelId,
      invoke: async () => this.responseText
    });
  }
}

function readModelResponseText(response: unknown): string {
  if (typeof response === 'string') {
    return requireNonEmptyResponse(response);
  }
  if (response === null || typeof response !== 'object' || !('content' in response)) {
    throw new Error('agent_model_response_invalid');
  }
  const content = response.content;
  if (typeof content === 'string') {
    return requireNonEmptyResponse(content);
  }
  if (!Array.isArray(content)) {
    throw new Error('agent_model_response_invalid');
  }
  const textBlocks: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      textBlocks.push(block);
      continue;
    }
    if (block === null || typeof block !== 'object' || !('type' in block) || block.type !== 'text' || !('text' in block) || typeof block.text !== 'string') {
      throw new Error('agent_model_response_invalid');
    }
    textBlocks.push(block.text);
  }
  return requireNonEmptyResponse(textBlocks.join('\n\n'));
}

function requireNonEmptyResponse(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('agent_model_response_empty');
  }
  return trimmed;
}
