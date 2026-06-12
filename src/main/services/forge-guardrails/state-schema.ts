import type { BaseMessage } from '@langchain/core/messages';
import { ReducedValue, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';

const errorTrackerSchema = z.object({
  consecutiveRetries: z.number().int().nonnegative().default(0),
  consecutiveToolErrors: z.number().int().nonnegative().default(0),
  maxRetries: z.number().int().positive().default(3),
  maxToolErrors: z.number().int().positive().default(2)
});

const errorTrackerUpdateSchema = errorTrackerSchema.partial();

export type ForgeErrorTrackerState = z.infer<typeof errorTrackerSchema>;

export function defaultErrorTracker(): ForgeErrorTrackerState {
  return errorTrackerSchema.parse({});
}

export function mergeErrorTracker(
  current: ForgeErrorTrackerState | undefined,
  update: z.infer<typeof errorTrackerUpdateSchema> | undefined
): ForgeErrorTrackerState {
  return { ...defaultErrorTracker(), ...current, ...update };
}

export const forgeGuardrailsStateSchema = new StateSchema({
  forge_error_tracker: new ReducedValue(errorTrackerSchema.default(defaultErrorTracker), {
    inputSchema: errorTrackerUpdateSchema,
    reducer: mergeErrorTracker
  })
});

export type ForgeGuardrailsState = typeof forgeGuardrailsStateSchema.State;
export type ForgeGuardrailsUpdate = typeof forgeGuardrailsStateSchema.Update;

export function markIterationOnMessage(message: BaseMessage, iterationIndex: number): BaseMessage {
  if (message.additional_kwargs === undefined) {
    message.additional_kwargs = {};
  }
  const kwargs = message.additional_kwargs;
  kwargs.forge_iteration_index = iterationIndex;
  return message;
}

export function readIterationFromMessage(message: BaseMessage): number | null {
  const value = message.additional_kwargs?.forge_iteration_index;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
