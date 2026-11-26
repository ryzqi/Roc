import type {StreamTextSummary} from './stream-consumers';

export type OutcomeValidationError = {
  code: string;
  message: string;
  diagnostics: Record<string, unknown>;
};

export type OutcomeState = {
  assistantText: StreamTextSummary;
  reasoningText: StreamTextSummary;
  toolCallsByBlockId: Map<string, string>;
  hookDisplayTexts: string[];
  usageAccumulated: boolean;
};

export function validateOutcomeConsistency(state: OutcomeState): OutcomeValidationError | null {
  const hasText = state.assistantText.hasContent;
  const hasReasoning = state.reasoningText.hasContent;
  const hasTools = state.toolCallsByBlockId.size > 0;
  const hasHooks = state.hookDisplayTexts.length > 0;

  // 规则 1: 必须有任意输出
  if (!hasText && !hasReasoning && !hasTools && !hasHooks) {
    return {
      code: 'agent_run_produced_no_output',
      message: 'Agent 运行未产生任何输出(无文本、推理、工具调用或 hook 输出)',
      diagnostics: {
        assistantChunksCount: state.assistantText.chunks,
        assistantTotalChars: state.assistantText.characters,
        reasoningChunksCount: state.reasoningText.chunks,
        reasoningTotalChars: state.reasoningText.characters,
        toolCallsCount: state.toolCallsByBlockId.size,
        hookTextsCount: state.hookDisplayTexts.length,
        usageAccumulated: state.usageAccumulated
      }
    };
  }

  if (!hasText && !hasHooks) {
    return {
      code: 'agent_run_missing_conclusion',
      message: '运行缺少可交付的结论，任务尚未验证。',
      diagnostics: { hasReasoning, toolCallsCount: state.toolCallsByBlockId.size }
    };
  }

  return null;
}
