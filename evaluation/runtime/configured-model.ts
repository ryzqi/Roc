import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { ConfigService } from '../../src/main/services/config-service';
import { ProvidersSchema } from '../../src/main/services/config/schema';
import { defaultModelStateForProviders, normalizeProvidersConfig } from '../../src/main/services/config/provider-rules';
import { LangChainModelFactory } from '../../src/main/services/langchain-model-factory';
import { RocPaths } from '../../src/main/services/paths';
import { SecretService } from '../../src/main/services/secret-service';
import type { SafeStorageBackend } from '../../src/main/infrastructure/safe-storage-backend';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function readModelSelection(root: string, selection?: { providerId: string; modelId: string }) {
  // Do not initialize ConfigService: initialization/migration can write user settings.
  const document = JSON.parse(readFileSync(join(root, 'config/settings.json'), 'utf8')) as { providers: unknown };
  const providers = normalizeProvidersConfig(ProvidersSchema.parse(document.providers));
  const selected = selection ?? defaultModelStateForProviders(providers);
  const provider = providers.providers.find(p => p.id === selected.providerId);
  const model = provider?.models.find(m => m.id === selected.modelId);
  if (!provider?.enabled || !model?.enabled) throw Object.assign(new Error('roc_configured_model_unavailable'), { code: 'roc_configured_model_unavailable' });
  return { provider, model, identity: { source: 'roc-settings', providerId: provider.id, providerType: provider.type,
    model: model.id, configurationHash: digest({ ...provider, models: [model] }) } };
}

export async function createConfiguredModel(root: string, storage: SafeStorageBackend, selection?: { providerId: string; modelId: string }) {
  const selected = readModelSelection(root, selection);
  const paths = new RocPaths(root);
  const readonlyStorage: SafeStorageBackend = {
    isEncryptionAvailable: () => storage.isEncryptionAvailable(),
    encryptString: async () => { throw new Error('evaluation_secret_write_forbidden'); },
    decryptString: async encrypted => ({ plaintext: (await storage.decryptString(encrypted)).plaintext, shouldReEncrypt: false })
  };
  const factory = new LangChainModelFactory(new ConfigService(paths), new SecretService(paths, readonlyStorage));
  const handle = await factory.createModelForProvider(selected.provider, selected.model.id, { streaming: false, maxOutputTokens: 4096 });
  return { handle, identity: { ...selected.identity, contextBudgetTokens: handle.runtime.contextBudgetTokens,
    maxOutputTokens: handle.runtime.maxOutputTokens, transport: 'roc-model-factory-stdio-v1' } };
}

type WireMessage = { role: string; content: BaseMessage['content']; tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  reasoning_content?: string };
export function fromWire(messages: WireMessage[]): BaseMessage[] {
  return messages.map(m => {
    if (m.role === 'user') return new HumanMessage(m.content ?? '');
    if (m.role === 'system' || m.role === 'developer') return new SystemMessage(m.content ?? '');
    if (m.role === 'tool' && m.tool_call_id) return new ToolMessage({ content: m.content ?? '', tool_call_id: m.tool_call_id });
    if (m.role === 'assistant') return new AIMessage({ content: m.content ?? '',
      tool_calls: m.tool_calls?.map(t => ({ id: t.id, name: t.function.name, args: JSON.parse(t.function.arguments) as Record<string, unknown>, type: 'tool_call' })),
      additional_kwargs: m.reasoning_content ? { reasoning_content: m.reasoning_content } : {} });
    throw new Error('model_message_role_unsupported');
  });
}

export async function completeConfigured(model: Awaited<ReturnType<typeof createConfiguredModel>>, body: {
  model: string; messages: WireMessage[]; tools?: Parameters<NonNullable<typeof model.handle.model.bindTools>>[0];
}, signal: AbortSignal) {
  if (body.model !== model.identity.model) throw new Error('model_binding_changed');
  const runnable = body.tools?.length ? model.handle.model.bindTools!(body.tools) : model.handle.model;
  const reply = await runnable.invoke(fromWire(body.messages), { signal });
  if (reply.invalid_tool_calls?.length) throw new Error('model_invalid_tool_call');
  const usage = reply.usage_metadata;
  const content = typeof reply.content === 'string' ? reply.content : reply.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { id: reply.id ?? randomUUID(), object: 'chat.completion', created: 0, model: model.identity.model,
    choices: [{ index: 0, finish_reason: reply.tool_calls?.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content,
      ...(reply.additional_kwargs.reasoning_content ? { reasoning_content: reply.additional_kwargs.reasoning_content } : {}),
      ...(reply.tool_calls?.length ? { tool_calls: reply.tool_calls.map(t => ({ id: t.id ?? randomUUID(), type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}) } }],
    ...(usage ? { usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens } } : {}) };
}
