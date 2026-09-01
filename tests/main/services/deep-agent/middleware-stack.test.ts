import { describe, expect, it, vi } from 'vitest';

import { compileRunCapabilityManifest } from '../../../../src/main/plugins/agent/run-capability-manifest';
import {
  readMiddlewareName,
  resolveMiddlewareStack,
  type MiddlewareStackContext
} from '../../../../src/main/services/deep-agent/middleware-stack';
import { createFakePreCompactionFlushRecorder } from './context/pre-compaction-flush-test-helpers';

/**
 * Roc guardrail 栈在 run/task mode、main scope 下的完整顺序。
 * 这里写死期望序列而不是回读 spec —— 回读会变成同义反复，任何顺序都能通过。
 */
const MAIN_RUN_STACK = [
  'todoListMiddleware',
  'RocShellPolicyMiddleware',
  'RTKMiddleware',
  'RocToolProtocolMiddleware',
  'ForgeErrorBudgetMiddleware',
  'ForgeIterationTrackingMiddleware',
  'RocFilesystemPathPolicyMiddleware',
  'ForgeFilesystemToolErrorMiddleware',
  'ContextEditingMiddleware',
  'ForgeRescueParsingMiddleware',
  'toolRetryMiddleware',
  'RocToolRuntimeErrorMiddleware',
  'ForgeToolResolutionMiddleware',
  'ForgeCleanupMiddleware'
] as const;

const PLAN_MODE_MIDDLEWARE = [
  'RocPlanReadOnlyMemoryMiddleware',
  'RocPlanToolExposureMiddleware',
  'RocPlanRuntimeToolGuardMiddleware',
  'RocPlanFilesystemDefaultPathMiddleware'
] as const;

describe('resolveMiddlewareStack', () => {
  it('装配 main scope 的完整 guardrail 栈并保持声明顺序', () => {
    const names = resolveNames(createContext({ executionScope: 'main', mode: 'run' }));

    expect(names).toEqual([...MAIN_RUN_STACK]);
  });

  it('把 todo 列表、rescue 解析与收尾只留给 main scope', () => {
    const mainNames = resolveNames(createContext({ executionScope: 'main', mode: 'run' }));
    const subagentNames = resolveNames(createContext({ executionScope: 'subagent', mode: 'run' }));

    for (const mainOnly of ['todoListMiddleware', 'ForgeRescueParsingMiddleware', 'ForgeCleanupMiddleware']) {
      expect(mainNames).toContain(mainOnly);
      expect(subagentNames).not.toContain(mainOnly);
    }
    // 去掉 main 专属的三格后，两个 scope 的顺序必须完全一致。
    expect(subagentNames).toEqual(
      MAIN_RUN_STACK.filter((name) =>
        name !== 'todoListMiddleware' && name !== 'ForgeRescueParsingMiddleware' && name !== 'ForgeCleanupMiddleware'
      )
    );
  });

  it('只在 plan mode 插入 plan 专属 middleware，且落在安全栈之前', () => {
    const planNames = resolveNames(createContext({ executionScope: 'main', mode: 'plan' }));
    const runNames = resolveNames(createContext({ executionScope: 'main', mode: 'run' }));

    for (const planOnly of PLAN_MODE_MIDDLEWARE) {
      expect(runNames).not.toContain(planOnly);
      expect(planNames.indexOf(planOnly)).toBeLessThan(planNames.indexOf('RocShellPolicyMiddleware'));
    }
    expect(planNames.filter((name) => !PLAN_MODE_MIDDLEWARE.includes(name as never))).toEqual([...MAIN_RUN_STACK]);
  });

  it('plan 专属 middleware 同样进入子代理栈', () => {
    const names = resolveNames(createContext({ executionScope: 'subagent', mode: 'plan' }));

    expect(names).toEqual(expect.arrayContaining([...PLAN_MODE_MIDDLEWARE]));
  });

  it('接入 Roc 压缩时用它替换 Forge 分层压缩，位置不变', () => {
    const context = createContext({ executionScope: 'main', mode: 'run' });
    const withRocCompaction = resolveNames({
      ...context,
      contextCompaction: {
        artifactStore: {} as never,
        budgetProfile: {
          contextWindowTokens: 1000,
          modelInputTokens: 500,
          reservedOutputTokens: 200,
          systemToolOverheadTokens: 100,
          summaryInputTokens: 400,
          safetyMarginTokens: 100
        },
        emitEvent: () => {},
        sessionHistory: createFakePreCompactionFlushRecorder(),
        tokenCounter: {
          countMessages: async () => ({ estimated: false, tokens: 1 }),
          countText: async () => ({ estimated: false, tokens: 1 }),
          wasEstimated: () => false
        }
      }
    });

    expect(withRocCompaction).not.toContain('ContextEditingMiddleware');
    expect(withRocCompaction).toContain('RocContextCompactionPipeline');
    expect(withRocCompaction.indexOf('RocContextCompactionPipeline')).toBe(
      MAIN_RUN_STACK.indexOf('ContextEditingMiddleware')
    );
  });

  it('提供 hook 运行时后，hook middleware 落在所有 Roc guardrail 之前', () => {
    const names = resolveNames({
      ...createContext({ executionScope: 'main', mode: 'run' }),
      hookMiddleware: createHookMiddlewareOptions()
    });

    expect(names.indexOf('RocHookMiddleware')).toBe(1);
    expect(names.indexOf('RocHookMiddleware')).toBeLessThan(names.indexOf('RocShellPolicyMiddleware'));
  });

  it('提供工具效果存储后才装幂等记账，且包在产品错误映射之内', () => {
    const context = createContext({ executionScope: 'main', mode: 'run' });
    expect(resolveNames(context)).not.toContain('RocToolEffectIdempotencyMiddleware');

    const names = resolveNames({ ...context, toolEffectStore: {} as never });

    expect(names.indexOf('RocToolEffectIdempotencyMiddleware')).toBeGreaterThan(
      names.indexOf('ForgeToolResolutionMiddleware')
    );
    expect(names.indexOf('RocToolEffectIdempotencyMiddleware')).toBeLessThan(names.indexOf('ForgeCleanupMiddleware'));
  });

  it('每次解算都给出独立实例，子代理之间不共享可变闭包状态', () => {
    const context = createContext({ executionScope: 'subagent', mode: 'run' });

    const first = resolveMiddlewareStack(context);
    const second = resolveMiddlewareStack(context);

    expect(first).not.toBe(second);
    for (const [index, middleware] of first.entries()) {
      expect(middleware).not.toBe(second[index]);
    }
  });

  it('rescue 候选集在子代理 scope 下永不被求值', () => {
    const knownToolCandidates = vi.fn(() => {
      throw new Error('agent_subagent_rescue_candidates_unavailable');
    });

    resolveMiddlewareStack({ ...createContext({ executionScope: 'subagent', mode: 'run' }), knownToolCandidates });

    expect(knownToolCandidates).not.toHaveBeenCalled();
  });
});

function resolveNames(context: MiddlewareStackContext): string[] {
  return resolveMiddlewareStack(context).map((middleware) => readMiddlewareName(middleware));
}

function createContext(input: {
  executionScope: MiddlewareStackContext['executionScope'];
  mode: MiddlewareStackContext['policy']['mode'];
}): MiddlewareStackContext {
  return {
    backend: {} as never,
    contextCompaction: undefined,
    executionScope: input.executionScope,
    hookMiddleware: undefined,
    knownToolCandidates: () => ['read_file'],
    memorySources: ['/memory/global/AGENTS.md'],
    model: {} as never,
    policy: {
      boundToolNames: ['read_file'],
      capabilityManifest: compileRunCapabilityManifest({
        deleteFileApprovalMode: 'default',
        mcpApprovalMode: 'fully_automatic',
        mcpServers: [],
        requestedCapabilities: { mcpServers: [], skills: [] },
        skills: [],
        mode: input.mode === 'plan' ? 'plan' : 'chat',
        workflowHint: null
      }).manifest,
      contextBudgetTokens: 4096,
      mode: input.mode,
      runId: 'run_middleware_stack',
      threadId: 'thread_middleware_stack',
      workspaceHash: 'workspace_middleware_stack',
      workspacePath: 'F:\\Code\\Roc'
    },
    toolEffectStore: undefined
  };
}

function createHookMiddlewareOptions() {
  return {
    hookRuntime: {
      runEvent: vi.fn(async () => ({
        blocked: false,
        blockReason: null,
        updatedInput: undefined,
        additionalContexts: [],
        requestContinue: null,
        runs: [],
        events: []
      }))
    },
    runContext: {
      runId: 'run_middleware_stack',
      threadId: 'thread_middleware_stack',
      workspacePath: 'F:\\Code\\Roc',
      cwd: 'F:\\Code\\Roc',
      source: 'chat' as const,
      modelId: 'model_1',
      workflowHint: null
    },
    emitHookEvent: vi.fn()
  } as never;
}
