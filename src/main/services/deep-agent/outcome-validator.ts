export type OutcomeValidationError = {
  code: string;
  message: string;
  diagnostics: Record<string, unknown>;
};

export type OutcomeState = {
  assistantChunks: string[];
  reasoningChunks: string[];
  toolCallsByBlockId: Map<string, string>;
  hookDisplayTexts: string[];
  usageAccumulated: boolean;
};

export function validateOutcomeConsistency(state: OutcomeState): OutcomeValidationError | null {
  const hasText = state.assistantChunks.some((c) => c.trim().length > 0);
  const hasReasoning = state.reasoningChunks.some((c) => c.trim().length > 0);
  const hasTools = state.toolCallsByBlockId.size > 0;
  const hasHooks = state.hookDisplayTexts.length > 0;

  // 规则 1: 必须有任意输出
  if (!hasText && !hasReasoning && !hasTools && !hasHooks) {
    return {
      code: 'agent_run_produced_no_output',
      message: 'Agent 运行未产生任何输出(无文本、推理、工具调用或 hook 输出)',
      diagnostics: {
        assistantChunksCount: state.assistantChunks.length,
        assistantTotalChars: state.assistantChunks.join('').length,
        reasoningChunksCount: state.reasoningChunks.length,
        reasoningTotalChars: state.reasoningChunks.join('').length,
        toolCallsCount: state.toolCallsByBlockId.size,
        hookTextsCount: state.hookDisplayTexts.length,
        usageAccumulated: state.usageAccumulated
      }
    };
  }

  // 规则 2: 有工具调用但无文本输出(可疑)
  if (hasTools && !hasText && !hasHooks) {
    console.warn(
      `[OutcomeValidator] 运行完成了 ${state.toolCallsByBlockId.size} 个工具调用,` +
        `但没有生成 assistant 文本输出。这可能表示响应被截断。`
    );
  }

  // 规则 3: 有推理但无结论(可疑)
  if (hasReasoning && !hasText && !hasTools) {
    console.warn(
      `[OutcomeValidator] 运行生成了 ${state.reasoningChunks.join('').length} 字符的推理内容,` +
        `但没有输出结论或工具调用。这可能表示模型被中断。`
    );
  }

  return null;
}
