import type { WorkflowHint } from '../../../../shared/types';

export type RunSummaryInput = {
  assistantMessage: string;
  successfulToolNames: readonly string[];
  workflowHint: WorkflowHint;
};

const MAX_SUMMARY_CHARS = 240;
const autoMemoryCandidatePrefixes = new Set([
  'user_preference',
  'workspace_fact',
  'decision',
  'pitfall',
  'verification',
  'transient_task_result'
]);
const autoMemoryConfidences = new Set(['high', 'medium', 'low']);

export function buildRunSummary(input: RunSummaryInput): string | null {
  const typedMemoryLines = extractTypedMemoryCandidateLines(input.assistantMessage);
  if (typedMemoryLines.length > 0) {
    return typedMemoryLines.join('\n');
  }
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

function extractTypedMemoryCandidateLines(value: string): string[] {
  const lines = value.split(/\r?\n/u);
  const candidates: string[] = [];
  for (const line of lines) {
    const normalized = normalizeWhitespace(line);
    const match = /^([a-z_]+):\s*(.*)$/u.exec(normalized);
    if (match === null) {
      continue;
    }
    const type = match[1];
    const body = match[2];
    if (type === undefined || body === undefined || !autoMemoryCandidatePrefixes.has(type)) {
      continue;
    }
    const parts = body.split('|').map((part) => part.trim());
    const confidence = parts[1];
    if (parts.length < 4 || confidence === undefined || !autoMemoryConfidences.has(confidence)) {
      continue;
    }
    candidates.push(`${type}: ${body}`);
  }
  return candidates;
}

function isToolOnlyNoise(message: string, toolNames: readonly string[]): boolean {
  if (message.length > 0) {
    return false;
  }
  return toolNames.length > 0;
}
