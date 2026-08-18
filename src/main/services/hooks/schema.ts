import { z } from 'zod';
import { rocHookConfigSchema } from '../../../shared/schemas/ipc-memory-settings';
import {
  type RocHookCommandOutput,
  type RocHookCommandOutputAction,
  type RocHookConfig,
  type RocHookEventName
} from '../../../shared/types';

export const HookConfigSchema = rocHookConfigSchema;

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
