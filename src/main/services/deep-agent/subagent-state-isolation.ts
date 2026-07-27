import { Command, isCommand } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import { z } from 'zod/v3';

const NATIVE_BUDGET_STATE_KEYS: ReadonlySet<string> = new Set([
  'threadModelCallCount',
  'runModelCallCount',
  'threadToolCallCount',
  'runToolCallCount'
]);

const nativeBudgetStateSchema = z.object({
  runModelCallCount: z.number().default(0),
  runToolCallCount: z.record(z.string(), z.number()).default({}),
  threadModelCallCount: z.number().default(0),
  threadToolCallCount: z.record(z.string(), z.number()).default({})
});

export function createRocSubagentStateIsolationMiddleware() {
  return createMiddleware({
    name: 'RocSubagentStateIsolationMiddleware',
    stateSchema: nativeBudgetStateSchema,
    wrapToolCall: async (request, handler) => {
      if (request.toolCall.name !== 'task') {
        return await handler(request);
      }
      const result = await handler(request);
      if (!isCommand(result)) {
        return result;
      }
      const update = result.update;
      if (update === undefined || Array.isArray(update)) {
        return result;
      }
      return new Command({
        graph: result.graph,
        goto: result.goto,
        resume: result.resume,
        update: omitNativeBudgetState(update)
      });
    }
  });
}

export function createRocSubagentBudgetStateInitializationMiddleware() {
  return createMiddleware({
    name: 'RocSubagentBudgetStateInitializationMiddleware',
    stateSchema: nativeBudgetStateSchema,
    beforeAgent: () => ({
      runModelCallCount: 0,
      runToolCallCount: {},
      threadModelCallCount: 0,
      threadToolCallCount: {}
    })
  });
}

function omitNativeBudgetState<TState extends object>(state: TState): TState {
  let filteredState: TState | null = null;
  for (const key of NATIVE_BUDGET_STATE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(state, key)) {
      continue;
    }
    if (filteredState === null) {
      filteredState = { ...state };
    }
    Reflect.deleteProperty(filteredState, key);
  }
  return filteredState === null ? state : filteredState;
}
