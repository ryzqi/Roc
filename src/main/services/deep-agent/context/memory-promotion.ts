export type MemoryPromotionInput = {
  runId: string;
  summary: string | null;
};

export function buildMemoryPromotionBullet(input: MemoryPromotionInput): string | null {
  if (input.summary === null) {
    return null;
  }
  const summary = input.summary.trim();
  if (summary.length === 0) {
    return null;
  }
  const runId = input.runId.trim();
  if (runId.length === 0) {
    throw new Error('memory_promotion_run_id_empty');
  }
  return `- ${runId}: ${summary}`;
}

export function normalizeMemoryPromotionSummary(summary: string): string {
  return summary.replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

export function memoryFileContainsPromotionSummary(existing: string, summary: string): boolean {
  const normalizedSummary = normalizeMemoryPromotionSummary(summary);
  if (normalizedSummary.length === 0) {
    return false;
  }
  const lines = existing.split('\n');
  for (const line of lines) {
    const match = /^-\s+[^:]+:\s+(.*)$/u.exec(line.trim());
    if (match === null) {
      continue;
    }
    const existingSummary = match[1];
    if (existingSummary !== undefined && normalizeMemoryPromotionSummary(existingSummary) === normalizedSummary) {
      return true;
    }
  }
  return false;
}
