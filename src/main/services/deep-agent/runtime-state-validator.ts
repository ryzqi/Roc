import type { ProviderUsageAccumulator } from './stream-usage-accumulator';

export type RuntimeStateValidationError = {
  code: string;
  message: string;
  diagnostics: Record<string, unknown>;
};

/**
 * Token budget 越界检测
 */
export function validateTokenBudget(
  usageAccumulator: ProviderUsageAccumulator,
  contextBudgetTokens: number | null | undefined
): RuntimeStateValidationError | null {
  if (contextBudgetTokens === null || contextBudgetTokens === undefined || contextBudgetTokens <= 0) {
    return null;
  }

  const totalTokens = usageAccumulator.totalTokens;
  if (totalTokens === null) {
    return null;
  }

  if (totalTokens > contextBudgetTokens) {
    return {
      code: 'context_budget_exhausted',
      message: `Token 使用量 (${totalTokens}) 超出配置的上下文预算 (${contextBudgetTokens})`,
      diagnostics: {
        totalTokens,
        contextBudgetTokens,
        overflowTokens: totalTokens - contextBudgetTokens,
        inputTokens: usageAccumulator.inputTokens,
        outputTokens: usageAccumulator.outputTokens
      }
    };
  }

  return null;
}

/**
 * 工具调用循环检测
 */
export type ToolCallRecord = {
  toolName: string;
  blockId: string;
  timestamp: number;
};

export class ToolCallLoopDetector {
  private readonly calls: ToolCallRecord[] = [];
  private readonly windowSize: number;
  private readonly loopThreshold: number;

  constructor(options?: { windowSize?: number; loopThreshold?: number }) {
    this.windowSize = options?.windowSize ?? 10;
    this.loopThreshold = options?.loopThreshold ?? 3;
  }

  recordToolCall(toolName: string, blockId: string): RuntimeStateValidationError | null {
    const now = Date.now();
    this.calls.push({ toolName, blockId, timestamp: now });

    // 保持滑动窗口
    if (this.calls.length > this.windowSize) {
      this.calls.shift();
    }

    // 检测相同工具的重复调用
    const recentCalls = this.calls.slice(-this.windowSize);
    const toolCallCounts = new Map<string, number>();

    for (const call of recentCalls) {
      toolCallCounts.set(call.toolName, (toolCallCounts.get(call.toolName) ?? 0) + 1);
    }

    for (const [tool, count] of toolCallCounts) {
      if (count >= this.loopThreshold) {
        return {
          code: 'tool_call_loop_detected',
          message: `检测到工具调用循环: "${tool}" 在最近 ${this.windowSize} 次调用中出现 ${count} 次`,
          diagnostics: {
            toolName: tool,
            count,
            windowSize: this.windowSize,
            threshold: this.loopThreshold,
            recentCalls: recentCalls.map(c => ({ tool: c.toolName, blockId: c.blockId }))
          }
        };
      }
    }

    // 检测简单的 A-B-A-B 模式
    if (recentCalls.length >= 4) {
      const last4 = recentCalls.slice(-4).map(c => c.toolName);
      if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) {
        return {
          code: 'tool_call_alternating_loop_detected',
          message: `检测到交替工具调用循环: "${last4[0]}" <-> "${last4[1]}"`,
          diagnostics: {
            pattern: last4,
            tools: [last4[0], last4[1]]
          }
        };
      }
    }

    return null;
  }

  reset(): void {
    this.calls.length = 0;
  }

  getCallHistory(): readonly ToolCallRecord[] {
    return this.calls;
  }
}
