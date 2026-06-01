import { HumanMessage } from '@langchain/core/messages';
import { ReducedValue, StateSchema } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import {
  areRequiredStepsSatisfied,
  bumpIteration,
  checkPrerequisitesMet,
  defaultErrorTracker,
  defaultStepTracker,
  forgeGuardrailsStateSchema,
  mergeStepTracker,
  pendingRequiredSteps,
  readIterationFromMessage,
  recordToolExecution,
  markIterationOnMessage,
  type ForgeStepTrackerState
} from '../../../../src/main/services/forge-guardrails/state-schema';

describe('forge guardrails state schema', () => {
  it('exposes LangGraph reduced state fields', () => {
    expect(StateSchema.isInstance(forgeGuardrailsStateSchema)).toBe(true);
    expect(ReducedValue.isInstance(forgeGuardrailsStateSchema.fields.forge_step_tracker)).toBe(true);
    expect(ReducedValue.isInstance(forgeGuardrailsStateSchema.fields.forge_error_tracker)).toBe(true);
  });

  it('creates default trackers with explicit counters', () => {
    expect(defaultStepTracker()).toEqual({
      executedTools: {},
      requiredSteps: [],
      terminalTools: [],
      iterationIndex: 0,
      prematureAttempts: 0,
      prereqViolations: 0
    });
    expect(defaultErrorTracker()).toEqual({
      consecutiveRetries: 0,
      consecutiveToolErrors: 0,
      maxRetries: 3,
      maxToolErrors: 2,
      maxPrematureAttempts: 3,
      maxPrereqViolations: 2
    });
  });

  it('merges executedTools updates without overwriting parallel tool results', () => {
    const first = mergeStepTracker(undefined, { executedTools: { read_file: [{ path: 'a' }] } });
    const second = mergeStepTracker(first, { executedTools: { write_file: [{ path: 'b' }] } });

    expect(second.executedTools).toEqual({
      read_file: [{ path: 'a' }],
      write_file: [{ path: 'b' }]
    });
  });

  it('appends same-tool executedTools updates from the same batch', () => {
    const first = mergeStepTracker(undefined, { executedTools: { read_file: [{ path: 'a' }] } });
    const second = mergeStepTracker(first, { executedTools: { read_file: [{ path: 'b' }] } });

    expect(second.executedTools.read_file).toEqual([{ path: 'a' }, { path: 'b' }]);
  });

  it('records tool execution immutably', () => {
    const state = defaultStepTracker();

    const next = recordToolExecution(state, 'read_file', { path: 'a' });

    expect(state.executedTools).toEqual({});
    expect(next.executedTools.read_file).toEqual([{ path: 'a' }]);
  });

  it('checks name-only prerequisites', () => {
    const missing = checkPrerequisitesMet(defaultStepTracker(), 'schedule_background_task', {}, [
      { kind: 'nameOnly', tool: 'propose_background_task' }
    ]);

    expect(missing).toEqual({ satisfied: false, missing: ['propose_background_task'] });

    const satisfiedState = recordToolExecution(defaultStepTracker(), 'propose_background_task', { goal: 'x' });
    expect(
      checkPrerequisitesMet(satisfiedState, 'schedule_background_task', {}, [
        { kind: 'nameOnly', tool: 'propose_background_task' }
      ])
    ).toEqual({ satisfied: true });
  });

  it('checks argument-matched prerequisites', () => {
    const state = recordToolExecution(defaultStepTracker(), 'read_file', { path: '/a' });
    const rules = [{ kind: 'argMatched', tool: 'read_file', matchArg: 'path' }] as const;

    expect(checkPrerequisitesMet(state, 'edit_file', { path: '/b' }, rules)).toEqual({
      satisfied: false,
      missing: ['read_file(path="b")']
    });
    expect(checkPrerequisitesMet(state, 'edit_file', { path: '/a' }, rules)).toEqual({ satisfied: true });
  });

  it('checks argument-matched prerequisites when current and prior argument names differ', () => {
    const state = recordToolExecution(defaultStepTracker(), 'read_file', { path: 'src/a.ts' });
    const rules = [{ kind: 'argMatched', tool: 'read_file', matchArg: 'path', currentArg: 'relativePath' }] as const;

    expect(checkPrerequisitesMet(state, 'delete_file', { relativePath: 'src/a.ts' }, rules)).toEqual({ satisfied: true });
    expect(checkPrerequisitesMet(state, 'delete_file', { relativePath: 'src/b.ts' }, rules)).toEqual({
      satisfied: false,
      missing: ['read_file(path="src/b.ts")']
    });
  });

  it('checks DeepAgents file_path prerequisites for write and edit tools', () => {
    const state = recordToolExecution(defaultStepTracker(), 'read_file', {
      file_path: '/workspace/quicksort_example.py'
    });
    const rules = [{ kind: 'argMatched', tool: 'read_file', matchArg: 'file_path' }] as const;

    expect(checkPrerequisitesMet(state, 'write_file', { file_path: '/workspace/quicksort_example.py' }, rules)).toEqual({
      satisfied: true
    });
    expect(checkPrerequisitesMet(state, 'edit_file', { file_path: '/workspace/other.py' }, rules)).toEqual({
      satisfied: false,
      missing: ['read_file(file_path="other.py")']
    });
  });

  it('matches delete_file relativePath against a prior /workspace/ read_file path', () => {
    const state = recordToolExecution(defaultStepTracker(), 'read_file', {
      file_path: '/workspace/src/old.py'
    });
    const rules = [{ kind: 'argMatched', tool: 'read_file', matchArg: 'file_path', currentArg: 'relativePath' }] as const;

    expect(checkPrerequisitesMet(state, 'delete_file', { relativePath: 'src/old.py' }, rules)).toEqual({
      satisfied: true
    });
    expect(checkPrerequisitesMet(state, 'delete_file', { relativePath: 'src/new.py' }, rules)).toEqual({
      satisfied: false,
      missing: ['read_file(file_path="src/new.py")']
    });
  });

  it('reports pending required steps', () => {
    expect(areRequiredStepsSatisfied(defaultStepTracker())).toBe(true);
    expect(pendingRequiredSteps(defaultStepTracker())).toEqual([]);

    const state: ForgeStepTrackerState = {
      ...recordToolExecution(defaultStepTracker(), 'A', {}),
      requiredSteps: ['A', 'B']
    };

    expect(areRequiredStepsSatisfied(state)).toBe(false);
    expect(pendingRequiredSteps(state)).toEqual(['B']);
  });

  it('bumps iteration immutably', () => {
    const state = defaultStepTracker();
    const first = bumpIteration(state);
    const third = bumpIteration(bumpIteration(first));

    expect(state.iterationIndex).toBe(0);
    expect(first.iterationIndex).toBe(1);
    expect(third.iterationIndex).toBe(3);
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
