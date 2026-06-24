import { z } from 'zod';
import {
  rocHookEventNames,
  type RocHookCommandOutput,
  type RocHookCommandOutputAction,
  type RocHookConfig,
  type RocHookEventName
} from '../../../shared/types';

const HookFailureModeSchema = z.enum(['continue', 'block']);

const CommandHandlerSchema = z.object({
  type: z.literal('command'),
  command: z.string().trim().min(1),
  commandWindows: z.string().trim().min(1).optional(),
  timeoutSeconds: z.number().int().min(1).max(600).default(30),
  statusMessage: z.string().trim().min(1).optional(),
  enabled: z.boolean().default(true),
  failureMode: HookFailureModeSchema.default('continue')
}).strict();

const MatcherGroupSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(CommandHandlerSchema).min(1)
}).strict();

const HooksRecordSchema = z.object(
  Object.fromEntries(rocHookEventNames.map((eventName) => [eventName, z.array(MatcherGroupSchema).optional()])) as Record<
    RocHookEventName,
    z.ZodOptional<z.ZodArray<typeof MatcherGroupSchema>>
  >
).strict();

export const HookConfigSchema: z.ZodType<RocHookConfig> = z.object({
  schemaVersion: z.literal(1),
  hooks: HooksRecordSchema
}).strict();

export const EmptyHookConfig: RocHookConfig = {
  schemaVersion: 1,
  hooks: {}
};

export const HookCommandOutputSchema: z.ZodType<RocHookCommandOutput> = z.object({
  action: z.enum(['continue', 'block', 'replace_input', 'add_context', 'request_continue']),
  message: z.string().min(1).optional(),
  updatedInput: z.unknown().optional(),
  additionalContext: z.string().min(1).optional()
});

const supportedActionsByEvent: Record<RocHookEventName, ReadonlySet<RocHookCommandOutputAction>> = {
  SessionStart: new Set(['continue', 'block', 'add_context']),
  UserPromptSubmit: new Set(['continue', 'block', 'add_context']),
  PreToolUse: new Set(['continue', 'block', 'replace_input']),
  PostToolUse: new Set(['continue', 'add_context']),
  Stop: new Set(['continue', 'block', 'add_context', 'request_continue']),
  SessionEnd: new Set(['continue'])
};

export function validateHookCommandOutputForEvent(event: RocHookEventName, output: unknown): RocHookCommandOutput {
  const parsed = HookCommandOutputSchema.parse(output);
  if (!supportedActionsByEvent[event].has(parsed.action)) {
    throw new Error(`unsupported_hook_action:${event}:${parsed.action}`);
  }
  return parsed;
}
