import { HumanMessage } from '@langchain/core/messages';
import { ReducedValue, StateSchema } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import {
  defaultErrorTracker,
  forgeGuardrailsStateSchema,
  readIterationFromMessage,
  markIterationOnMessage
} from '../../../../src/main/services/forge-guardrails/state-schema';

const REMOVED_STEP_TRACKER_FIELD = ['forge', 'step', 'tracker'].join('_');

describe('forge guardrails state schema', () => {
  it('exposes LangGraph reduced state fields', () => {
    expect(StateSchema.isInstance(forgeGuardrailsStateSchema)).toBe(true);
    expect(Reflect.has(forgeGuardrailsStateSchema.fields, REMOVED_STEP_TRACKER_FIELD)).toBe(false);
    expect(ReducedValue.isInstance(forgeGuardrailsStateSchema.fields.forge_error_tracker)).toBe(true);
  });

  it('creates the default error tracker with retry and tool-error budgets only', () => {
    expect(defaultErrorTracker()).toEqual({
      consecutiveRetries: 0,
      consecutiveToolErrors: 0,
      maxRetries: 3,
      maxToolErrors: 2
    });
  });

  it('marks and reads iteration indexes on messages', () => {
    const message = new HumanMessage('x');

    expect(markIterationOnMessage(message, 7)).toBe(message);
    expect(readIterationFromMessage(message)).toBe(7);
    expect(message.additional_kwargs.forge_iteration_index).toBe(7);
  });

  it('ignores invalid iteration tags', () => {
    expect(readIterationFromMessage(new HumanMessage('x'))).toBeNull();
    expect(readIterationFromMessage(new HumanMessage({ content: 'x', additional_kwargs: { forge_iteration_index: -1 } }))).toBeNull();
    expect(readIterationFromMessage(new HumanMessage({ content: 'x', additional_kwargs: { forge_iteration_index: 1.2 } }))).toBeNull();
    expect(readIterationFromMessage(new HumanMessage({ content: 'x', additional_kwargs: { forge_iteration_index: '1' } }))).toBeNull();
  });
});
