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
