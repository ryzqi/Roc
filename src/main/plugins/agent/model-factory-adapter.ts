import { DEFAULT_RUN_MODEL_OUTPUT_TOKENS } from '../../../shared/run-budget-policy';
import type { LangChainChatModelHandle, LangChainModelFactory } from '../../services/langchain-model-factory';

export type AgentModelHandle = {
  providerId: string;
  modelId: string;
  langChainHandle?: LangChainChatModelHandle;
};

export type AgentModelFactoryAdapter = {
  createDefaultModelHandle(input?: { maxOutputTokens?: number }): Promise<AgentModelHandle>;
  createModelHandleByProviderAndModel(input: { providerId: string; modelId: string; maxOutputTokens?: number }): Promise<AgentModelHandle>;
};

export class LangChainAgentModelFactoryAdapter implements AgentModelFactoryAdapter {
  constructor(
    private readonly factory: Pick<LangChainModelFactory, 'createChatModelByProviderAndModel' | 'createDefaultChatModel'>,
    private readonly options: { beforeCreate?: () => void } = {}
  ) {}

  async createDefaultModelHandle(input: { maxOutputTokens?: number } = {}): Promise<AgentModelHandle> {
    if (this.options.beforeCreate !== undefined) {
      this.options.beforeCreate();
    }
    const maxOutputTokens = resolveOutputLimit(input.maxOutputTokens);
    const handle = await this.factory.createDefaultChatModel({ streaming: true, maxOutputTokens });
    return {
      providerId: handle.provider.id,
      modelId: handle.modelId,
      langChainHandle: handle
    };
  }

  async createModelHandleByProviderAndModel(input: { providerId: string; modelId: string; maxOutputTokens?: number }): Promise<AgentModelHandle> {
    if (this.options.beforeCreate !== undefined) {
      this.options.beforeCreate();
    }
    const handle = await this.factory.createChatModelByProviderAndModel(input.providerId, input.modelId, {
      streaming: true,
      maxOutputTokens: resolveOutputLimit(input.maxOutputTokens)
    });
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

  createDefaultModelHandle(_input: { maxOutputTokens?: number } = {}): Promise<AgentModelHandle> {
    resolveOutputLimit(_input.maxOutputTokens);
    return Promise.resolve({
      ...this.handle
    });
  }

  createModelHandleByProviderAndModel(input: { providerId: string; modelId: string; maxOutputTokens?: number }): Promise<AgentModelHandle> {
    resolveOutputLimit(input.maxOutputTokens);
    if (input.providerId !== this.handle.providerId || input.modelId !== this.handle.modelId) {
      throw new Error('static_model_handle_mismatch');
    }
    return Promise.resolve({
      ...this.handle
    });
  }
}

function resolveOutputLimit(maxOutputTokens: number | undefined): number {
  const resolved = maxOutputTokens ?? DEFAULT_RUN_MODEL_OUTPUT_TOKENS;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > DEFAULT_RUN_MODEL_OUTPUT_TOKENS) {
    throw new Error('run_budget_output_limit_invalid');
  }
  return resolved;
}
