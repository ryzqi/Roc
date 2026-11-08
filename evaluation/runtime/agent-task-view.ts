import { createHash } from 'node:crypto';
import { z } from 'zod';

// This is the entire dataset contract included in the evaluated worker.
export const QUALITY_FAMILIES = [
  'literature-verification', 'multi-paper-evidence', 'long-memory', 'file-report',
  'experiment-script', 'mcp-recovery', 'permission-injection', 'cancel-crash'
] as const;
export const agentTaskViewSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u),
  family: z.enum(QUALITY_FAMILIES), difficulty: z.enum(['easy', 'moderate', 'hard']),
  prompt: z.string().trim().min(1).max(65536),
  conversationTurns: z.array(z.string().trim().min(1).max(65536)).optional(), outputFormat: z.literal('json')
});
export type QualityFamily = (typeof QUALITY_FAMILIES)[number];
export type AgentTaskView = z.infer<typeof agentTaskViewSchema>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, nested]) => [key, canonical(nested)])
  );
  return value;
}
export function qualityHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
