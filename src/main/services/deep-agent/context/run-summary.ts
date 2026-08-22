import type { WorkflowHint } from '../../../../shared/types';

export type RunSummaryInput = {
  assistantMessage: string;
  successfulToolNames: readonly string[];
  workflowHint: WorkflowHint;
};

const MAX_SUMMARY_CHARS = 240;

export function buildRunSummary(input: RunSummaryInput): string | null {
  const normalized = normalizeWhitespace(input.assistantMessage);
  if (normalized.length === 0) {
    return null;
  }
  if (isToolOnlyNoise(normalized, input.successfulToolNames)) {
    return null;
  }
  if (normalized.length <= MAX_SUMMARY_CHARS) {
    return normalized;
  }
  return normalized.slice(0, MAX_SUMMARY_CHARS);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function isToolOnlyNoise(message: string, toolNames: readonly string[]): boolean {
  if (message.length > 0) {
    return false;
  }
  return toolNames.length > 0;
}
