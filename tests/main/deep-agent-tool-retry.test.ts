import { ToolMessage } from '@langchain/core/messages';
import type { ClientTool } from '@langchain/core/tools';
import { GraphInterrupt } from '@langchain/langgraph';
import { MiddlewareError } from 'langchain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocCompositeBackend } from '../../src/main/services/deep-agent/backend';
import type { DeepAgentBuildInput } from '../../src/main/services/deep-agent/agent-builder';
import { compileRunCapabilityManifest } from '../../src/main/plugins/agent/run-capability-manifest';
import { RocDomainError } from '../../src/main/services/errors';
import { createDeepAgentTestSnapshot } from './deep-agent-test-helpers';

type ToolRetryConfig = {
  backoffFactor?: number;
  maxRetries?: number;
  onFailure?: 'error' | ((error: Error) => string);
  retryOn?: (error: Error) => boolean;
  tools?: string[];
};

type CreateDeepAgentConfig = {
  middleware?: readonly unknown[];
};

const mocked = vi.hoisted(() => ({
  createDeepAgent: vi.fn((_config?: CreateDeepAgentConfig) => ({ __agent: true })),
  toolRetryMiddleware: vi.fn((_config?: ToolRetryConfig) => ({ name: 'toolRetryMiddleware' }))
}));

vi.mock('deepagents', async () => {
  const actual = await vi.importActual<typeof import('deepagents')>('deepagents');
  return {
    ...actual,
    createDeepAgent: mocked.createDeepAgent
  };
});

vi.mock('langchain', async () => {
  const actual = await vi.importActual<typeof import('langchain')>('langchain');
  return {
    ...actual,
    toolRetryMiddleware: mocked.toolRetryMiddleware
  };
});

describe('deep agent tool retry policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not retry background task side-effect tools automatically', async () => {
    const { buildDeepAgent } = await import('../../src/main/services/deep-agent/agent-builder');

    buildDeepAgent(createBuildInput());

    expect(mocked.toolRetryMiddleware).toHaveBeenCalledWith(expect.objectContaining({
      maxRetries: 2,
      tools: ['web_read', 'web_search'],
      onFailure: expect.any(Function),
      backoffFactor: 1.5
    }));
  });

  it('keeps protocol and safety failures outside native network retry', async () => {
    const { buildDeepAgent } = await import('../../src/main/services/deep-agent/agent-builder');

    const agent = buildDeepAgent(createBuildInput());
    expect(agent).toEqual({ __agent: true });
    const input = mocked.createDeepAgent.mock.calls[0]?.[0];
    if (input?.middleware === undefined) {
      throw new Error('Expected Deep Agents middleware configuration.');
    }
    const middlewareNames = input.middleware.map((middleware) => Reflect.get(middleware as object, 'name'));
    expect(middlewareNames).toEqual(expect.arrayContaining([
      'RocToolProtocolMiddleware',
      'ForgeErrorBudgetMiddleware',
      'toolRetryMiddleware',
      'RocToolRuntimeErrorMiddleware'
    ]));

    expect(middlewareNames.indexOf('RocToolProtocolMiddleware')).toBeLessThan(
      middlewareNames.indexOf('toolRetryMiddleware')
    );
    expect(middlewareNames.indexOf('ForgeErrorBudgetMiddleware')).toBeLessThan(
      middlewareNames.indexOf('toolRetryMiddleware')
    );
    expect(middlewareNames.indexOf('toolRetryMiddleware')).toBeLessThan(
      middlewareNames.indexOf('RocToolRuntimeErrorMiddleware')
    );
  });

  it('retries only retryable network failures', async () => {
    const { buildDeepAgent } = await import('../../src/main/services/deep-agent/agent-builder');

    buildDeepAgent(createBuildInput());
    const retryConfig = mocked.toolRetryMiddleware.mock.calls[0]?.[0];
    const retryOn = retryConfig?.retryOn;
    if (retryOn === undefined) {
      throw new Error('Expected an explicit network retry predicate.');
    }
    const abortError = new Error('AbortError: run aborted');
    abortError.name = 'AbortError';
    const nonRetryableDomainError = new RocDomainError({
      code: 'web_read_private_url',
      message: 'web_read 只允许公开网络地址。',
      category: 'validation',
      retryable: false
    });
    const retryableDomainError = new RocDomainError({
      code: 'web_read_failed',
      message: 'web_read 请求失败：network reset',
      category: 'external',
      retryable: true
    });

    expect(retryOn(MiddlewareError.wrap(abortError, 'RocToolEffectIdempotencyMiddleware'))).toBe(false);
    expect(retryOn(MiddlewareError.wrap(new GraphInterrupt([]), 'RocToolEffectIdempotencyMiddleware'))).toBe(false);
    expect(retryOn(MiddlewareError.wrap(nonRetryableDomainError, 'RocToolEffectIdempotencyMiddleware'))).toBe(false);
    expect(retryOn(MiddlewareError.wrap(
      new Error('web_read 只支持合法的 HTTP/HTTPS URL。'),
      'RocToolEffectIdempotencyMiddleware'
    ))).toBe(false);
    expect(retryOn(MiddlewareError.wrap(retryableDomainError, 'RocToolEffectIdempotencyMiddleware'))).toBe(true);
    expect(retryOn(MiddlewareError.wrap(new Error('fetch failed'), 'RocToolEffectIdempotencyMiddleware'))).toBe(true);
  });

  it('keeps non-retryable failures hard and returns retry exhaustion to the agent', async () => {
    const { buildDeepAgent } = await import('../../src/main/services/deep-agent/agent-builder');
    const actualLangChain = await vi.importActual<typeof import('langchain')>('langchain');

    buildDeepAgent(createBuildInput());
    const retryConfig = mocked.toolRetryMiddleware.mock.calls[0]?.[0];
    if (retryConfig === undefined) {
      throw new Error('Expected native network retry configuration.');
    }
    const retryMiddleware = actualLangChain.toolRetryMiddleware({
      ...retryConfig,
      initialDelayMs: 0,
      jitter: false
    });
    const wrapToolCall = retryMiddleware.wrapToolCall;
    if (typeof wrapToolCall !== 'function') {
      throw new Error('Expected native network retry wrapToolCall hook.');
    }
    const abortHandler = vi.fn(async () => {
      const error = new Error('AbortError: run aborted');
      error.name = 'AbortError';
      throw MiddlewareError.wrap(error, 'RocToolEffectIdempotencyMiddleware');
    });
    const retryableHandler = vi.fn(async () => {
      throw MiddlewareError.wrap(new Error('fetch failed'), 'RocToolEffectIdempotencyMiddleware');
    });
    const nonRetryableHandler = vi.fn(async () => {
      throw MiddlewareError.wrap(
        new Error('web_read 只支持合法的 HTTP/HTTPS URL。'),
        'RocToolEffectIdempotencyMiddleware'
      );
    });

    await expect(wrapToolCall({
      toolCall: { name: 'web_read', args: {}, id: 'call-abort' }
    } as never, abortHandler as never)).rejects.toThrow('AbortError: run aborted');
    await expect(wrapToolCall({
      toolCall: { name: 'web_read', args: {}, id: 'call-invalid-url' }
    } as never, nonRetryableHandler as never)).rejects.toThrow('web_read 只支持合法的 HTTP/HTTPS URL。');
    const exhausted = await wrapToolCall({
      toolCall: { name: 'web_read', args: {}, id: 'call-exhausted' }
    } as never, retryableHandler as never);
    expect(abortHandler).toHaveBeenCalledTimes(1);
    expect(nonRetryableHandler).toHaveBeenCalledTimes(1);
    expect(retryableHandler).toHaveBeenCalledTimes(3);
    expect(ToolMessage.isInstance(exhausted)).toBe(true);
    if (!ToolMessage.isInstance(exhausted)) {
      throw new Error('Expected retry exhaustion ToolMessage.');
    }
    expect(exhausted.status).toBe('error');
    expect(exhausted.content).toBe('Provider 网络请求失败：fetch failed');
  });
});

function createBuildInput(): DeepAgentBuildInput {
  const capabilityManifest = compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic',
    mcpApprovalMode: 'fully_automatic',
    mcpServers: [],
    mode: 'chat',
    workflowHint: 'propose_background_task',
    requestedCapabilities: { mcpServers: [], skills: [] },
    skills: []
  }).manifest;
  return {
    snapshot: createDeepAgentTestSnapshot({
      capabilityManifest,
      workspacePath: 'F:\\Code\\Roc'
    }),
    model: {} as never,
    systemPrompt: 'system',
    backend: { routePrefixes: [] } as unknown as RocCompositeBackend,
    store: {} as never,
    memorySources: [],
    skillSources: [],
    subagents: [],
    tools: [
      fakeTool('web_read'),
      fakeTool('schedule_background_task')
    ],
    checkpointer: undefined
  };
}

function fakeTool(name: string): ClientTool {
  return {
    name,
    description: `${name} tool`,
    schema: undefined,
    invoke: vi.fn()
  } as unknown as ClientTool;
}
