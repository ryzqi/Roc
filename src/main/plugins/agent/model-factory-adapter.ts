import type { LangChainModelFactory } from '../../services/langchain-model-factory';

const nonFinalTextBlockTypes = new Set([
  'reasoning',
  'tool_call',
  'tool_call_chunk',
  'invalid_tool_call',
  'server_tool_call',
  'server_tool_call_chunk',
  'server_tool_call_result',
  'non_standard'
]);

export type AgentModelHandle = {
  providerId: string;
  modelId: string;
  invoke(input: string): Promise<string>;
  stream?(input: string): AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
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
      invoke: async (input) => readModelResponseText(await handle.model.invoke(input)),
      stream: async (input) => await handle.model.stream(input)
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
      invoke: async (input) => readModelResponseText(await handle.model.invoke(input)),
      stream: async (input) => await handle.model.stream(input)
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
  if (response === null || typeof response !== 'object') {
    throw new Error('agent_model_response_invalid');
  }
  const content = 'content' in response ? response.content : undefined;
  if (typeof content === 'string') {
    return requireNonEmptyResponse(content);
  }
  const blocks = readResponseBlocks(response, content);
  if (blocks === null) {
    throw new Error('agent_model_response_invalid');
  }
  const textBlocks: string[] = [];
  for (const block of blocks) {
    if (typeof block === 'string') {
      textBlocks.push(block);
      continue;
    }
    if (block === null || typeof block !== 'object' || !('type' in block) || typeof block.type !== 'string') {
      throw new Error('agent_model_response_invalid');
    }
    if (block.type === 'text') {
      if (!('text' in block) || typeof block.text !== 'string') {
        throw new Error('agent_model_response_invalid');
      }
      textBlocks.push(block.text);
      continue;
    }
    if (nonFinalTextBlockTypes.has(block.type)) {
      continue;
    }
    throw new Error('agent_model_response_invalid');
  }
  return requireNonEmptyResponse(textBlocks.join('\n\n'));
}

function readResponseBlocks(response: object, content: unknown): unknown[] | null {
  if ('contentBlocks' in response) {
    const contentBlocks = response.contentBlocks;
    if (contentBlocks === undefined) {
      return Array.isArray(content) ? content : null;
    }
    if (!Array.isArray(contentBlocks)) {
      throw new Error('agent_model_response_invalid');
    }
    return contentBlocks;
  }
  if (Array.isArray(content)) {
    return content;
  }
  return null;
}

function requireNonEmptyResponse(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('agent_model_response_empty');
  }
  return trimmed;
}
