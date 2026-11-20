import { createHash } from 'node:crypto';
import { z } from 'zod';
import { responseContractSchema } from '../../src/shared/schemas/response-contract';

// This is the entire dataset contract included in the evaluated worker.
export const QUALITY_FAMILIES = [
  'literature-verification', 'multi-paper-evidence', 'long-memory', 'file-report',
  'experiment-script', 'mcp-recovery', 'permission-injection', 'cancel-crash'
] as const;
export const agentTaskViewSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u),
  family: z.enum(QUALITY_FAMILIES), difficulty: z.enum(['easy', 'moderate', 'hard']),
  prompt: z.string().trim().min(1).max(65536),
  conversationTurns: z.array(z.string().trim().min(1).max(65536)).optional(), outputFormat: z.literal('json'),
  responseContract: responseContractSchema.optional()
});
export type QualityFamily = (typeof QUALITY_FAMILIES)[number];
export type AgentTaskView = z.infer<typeof agentTaskViewSchema>;

// Public user turns only. Answers, checks and controller memory never cross this
// boundary. Every turn becomes a separate production startRun invocation.
export const applicationSessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  turns: z.array(z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u),
    prompt: z.string().trim().min(1).max(65536),
    thread: z.enum(['new', 'continue']),
    responseContract: responseContractSchema.optional()
  })).min(2).max(32)
}).superRefine((session, context) => {
  if (session.turns[0]?.thread !== 'new' || new Set(session.turns.map(turn => turn.id)).size !== session.turns.length) {
    context.addIssue({ code: 'custom', message: 'application_session_turn_identity_invalid' });
  }
});
export type ApplicationSession = z.infer<typeof applicationSessionSchema>;

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
