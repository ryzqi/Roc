import type { BaseMessage } from '@langchain/core/messages';
import { ReducedValue, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';

const stepTrackerSchema = z.object({
  executedTools: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).default(() => ({})),
  requiredSteps: z.array(z.string()).default(() => []),
  terminalTools: z.array(z.string()).default(() => []),
  iterationIndex: z.number().int().nonnegative().default(0),
  prematureAttempts: z.number().int().nonnegative().default(0),
  prereqViolations: z.number().int().nonnegative().default(0)
});

const stepTrackerUpdateSchema = stepTrackerSchema.partial();

const errorTrackerSchema = z.object({
  consecutiveRetries: z.number().int().nonnegative().default(0),
  consecutiveToolErrors: z.number().int().nonnegative().default(0),
  maxRetries: z.number().int().positive().default(3),
  maxToolErrors: z.number().int().positive().default(2),
  maxPrematureAttempts: z.number().int().positive().default(3),
  maxPrereqViolations: z.number().int().positive().default(2)
});

const errorTrackerUpdateSchema = errorTrackerSchema.partial();

export type ForgeStepTrackerState = z.infer<typeof stepTrackerSchema>;
export type ForgeErrorTrackerState = z.infer<typeof errorTrackerSchema>;

export function defaultStepTracker(): ForgeStepTrackerState {
  return stepTrackerSchema.parse({});
}

export function defaultErrorTracker(): ForgeErrorTrackerState {
  return errorTrackerSchema.parse({});
}

export function mergeStepTracker(
  current: ForgeStepTrackerState | undefined,
  update: z.infer<typeof stepTrackerUpdateSchema> | undefined
): ForgeStepTrackerState {
  const base = { ...defaultStepTracker(), ...current };
  if (update === undefined) {
    return base;
  }
  return {
    ...base,
    ...update,
    executedTools: mergeExecutedTools(base.executedTools, update.executedTools)
  };
}

function mergeExecutedTools(
  current: ForgeStepTrackerState['executedTools'],
  update: ForgeStepTrackerState['executedTools'] | undefined
): ForgeStepTrackerState['executedTools'] {
  if (update === undefined) {
    return current;
  }
  const merged = { ...current };
  for (const [toolName, executions] of Object.entries(update)) {
    merged[toolName] = [...(merged[toolName] ?? []), ...executions];
  }
  return merged;
}

export function mergeErrorTracker(
  current: ForgeErrorTrackerState | undefined,
  update: z.infer<typeof errorTrackerUpdateSchema> | undefined
): ForgeErrorTrackerState {
  return { ...defaultErrorTracker(), ...current, ...update };
}

export const forgeGuardrailsStateSchema = new StateSchema({
  forge_step_tracker: new ReducedValue(stepTrackerSchema.default(defaultStepTracker), {
    inputSchema: stepTrackerUpdateSchema,
    reducer: mergeStepTracker
  }),
  forge_error_tracker: new ReducedValue(errorTrackerSchema.default(defaultErrorTracker), {
    inputSchema: errorTrackerUpdateSchema,
    reducer: mergeErrorTracker
  })
});

export type ForgeGuardrailsState = typeof forgeGuardrailsStateSchema.State;
export type ForgeGuardrailsUpdate = typeof forgeGuardrailsStateSchema.Update;

export type PrereqRule =
  | { kind: 'nameOnly'; tool: string }
  | { kind: 'argMatched'; tool: string; matchArg: string; currentArg?: string };

export function checkPrerequisitesMet(
  state: ForgeStepTrackerState,
  toolName: string,
  args: Record<string, unknown>,
  rules: readonly PrereqRule[]
): { satisfied: true } | { satisfied: false; missing: string[] } {
  void toolName;
  const missing: string[] = [];
  for (const rule of rules) {
    const executions = state.executedTools[rule.tool] ?? [];
    if (rule.kind === 'nameOnly') {
      if (executions.length === 0) {
        missing.push(rule.tool);
      }
      continue;
    }
    const currentArg = rule.currentArg ?? rule.matchArg;
    const currentValue = args[currentArg];
    const matched = executions.some((prevArgs) => prevArgs[rule.matchArg] === currentValue);
    if (!matched) {
      missing.push(`${rule.tool}(${rule.matchArg}=${JSON.stringify(currentValue)})`);
    }
  }
  return missing.length === 0 ? { satisfied: true } : { satisfied: false, missing };
}

export function recordToolExecution(
  state: ForgeStepTrackerState,
  toolName: string,
  args: Record<string, unknown>
): ForgeStepTrackerState {
  const previous = state.executedTools[toolName] ?? [];
  return {
    ...state,
    executedTools: {
      ...state.executedTools,
      [toolName]: [...previous, args]
    }
  };
}

export function bumpIteration(state: ForgeStepTrackerState): ForgeStepTrackerState {
  return { ...state, iterationIndex: state.iterationIndex + 1 };
}

export function markIterationOnMessage(message: BaseMessage, iterationIndex: number): BaseMessage {
  const kwargs = (message.additional_kwargs ??= {});
  kwargs.forge_iteration_index = iterationIndex;
  return message;
}

export function readIterationFromMessage(message: BaseMessage): number | null {
  const value = message.additional_kwargs?.forge_iteration_index;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function areRequiredStepsSatisfied(state: ForgeStepTrackerState): boolean {
  return state.requiredSteps.every((step) => (state.executedTools[step] ?? []).length > 0);
}

export function pendingRequiredSteps(state: ForgeStepTrackerState): string[] {
  return state.requiredSteps.filter((step) => (state.executedTools[step] ?? []).length === 0);
}
