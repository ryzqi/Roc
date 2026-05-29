import { AIMessage, RemoveMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  defaultErrorTracker,
  defaultStepTracker,
  readForgeMessageTag,
  ROC_PREREQUISITES
} from '../../../../../src/main/services/forge-guardrails';
import { createForgeCleanupMiddleware } from '../../../../../src/main/services/forge-guardrails/middleware/forge-cleanup';
import { createResponseValidationMiddleware } from '../../../../../src/main/services/forge-guardrails/middleware/response-validation';
import { createStepEnforcementMiddleware } from '../../../../../src/main/services/forge-guardrails/middleware/step-enforcement';

async function runResponseValidation(messages: BaseMessage[]): Promise<BaseMessage[]> {
  const middleware = createResponseValidationMiddleware({ knownToolNames: () => ['get_weather'] });
  const afterModel = middleware.afterModel;
  if (typeof afterModel !== 'object' || afterModel === null || typeof afterModel.hook !== 'function') {
    throw new Error('Expected response validation middleware to expose object-form afterModel hook.');
  }

  const update = (await afterModel.hook({ messages } as never, {} as never)) as { messages?: BaseMessage[] } | undefined;
  return update?.messages ?? [];
}

async function runStepEnforcement(messages: BaseMessage[]): Promise<BaseMessage[]> {
  const middleware = createStepEnforcementMiddleware({
    resolveWorkflowFromContext: () => 'propose_background_task',
    prerequisitesConfig: ROC_PREREQUISITES
  });
  const afterModel = middleware.afterModel;
  if (typeof afterModel !== 'object' || afterModel === null || typeof afterModel.hook !== 'function') {
    throw new Error('Expected step enforcement middleware to expose object-form afterModel hook.');
  }

  const update = (await afterModel.hook(
    {
      messages,
      forge_step_tracker: {
        ...defaultStepTracker(),
        requiredSteps: ['propose_background_task', 'schedule_background_task'],
        terminalTools: ['confirm_with_user']
      },
      forge_error_tracker: defaultErrorTracker()
    } as never,
    {} as never
  )) as { messages?: BaseMessage[] } | undefined;
  return update?.messages ?? [];
}

function cleanupIds(messages: BaseMessage[]): string[] {
  const middleware = createForgeCleanupMiddleware();
  if (typeof middleware.afterAgent !== 'function') {
    throw new Error('Expected cleanup middleware to expose afterAgent.');
  }

  const update = middleware.afterAgent({ messages } as never, {} as never) as { messages?: RemoveMessage[] } | undefined;
  return (update?.messages ?? []).map((message) => message.id);
}

describe('ForgeCleanupMiddleware', () => {
  it('removes retry nudges produced by response validation', async () => {
    const [nudge] = await runResponseValidation([
      new AIMessage({
        id: 'ai-bare',
        content: 'I can answer directly.'
      })
    ]);

    expect(nudge?.id).toBe('forge-retry-nudge-ai-bare');
    expect(readForgeMessageTag(nudge!)).toBe('forge:retry_nudge');
    expect(cleanupIds([nudge!])).toEqual(['forge-retry-nudge-ai-bare']);
  });

  it('removes unknown-tool nudges produced by response validation', async () => {
    const [nudge] = await runResponseValidation([
      new AIMessage({
        id: 'ai-unknown',
        content: '',
        tool_calls: [
          {
            name: 'missing_tool',
            args: { city: 'Paris' },
            id: 'call-missing',
            type: 'tool_call'
          }
        ]
      })
    ]);

    expect(nudge?.id).toBe('forge-unknown-tool-nudge-call-missing');
    expect(readForgeMessageTag(nudge!)).toBe('forge:unknown_tool_nudge');
    expect(cleanupIds([nudge!])).toEqual(['forge-unknown-tool-nudge-call-missing']);
  });

  it('removes step nudges produced by step enforcement', async () => {
    const [nudge] = await runStepEnforcement([
      new AIMessage({
        id: 'ai-confirm',
        content: '',
        tool_calls: [
          {
            name: 'confirm_with_user',
            args: { summary: 'done' },
            id: 'call-confirm',
            type: 'tool_call'
          }
        ]
      })
    ]);

    expect(nudge).toBeInstanceOf(ToolMessage);
    expect(nudge?.id).toBe('forge-step-nudge-call-confirm');
    expect(readForgeMessageTag(nudge!)).toBe('forge:step_nudge');
    expect(cleanupIds([nudge!])).toEqual(['forge-step-nudge-call-confirm']);
  });

  it('removes prerequisite nudges produced by step enforcement', async () => {
    const [nudge] = await runStepEnforcement([
      new AIMessage({
        id: 'ai-edit',
        content: '',
        tool_calls: [
          {
            name: 'edit_file',
            args: { path: '/a.md' },
            id: 'call-edit',
            type: 'tool_call'
          }
        ]
      })
    ]);

    expect(nudge).toBeInstanceOf(ToolMessage);
    expect(nudge?.id).toBe('forge-prerequisite-nudge-call-edit');
    expect(readForgeMessageTag(nudge!)).toBe('forge:prerequisite_nudge');
    expect(cleanupIds([nudge!])).toEqual(['forge-prerequisite-nudge-call-edit']);
  });
});
