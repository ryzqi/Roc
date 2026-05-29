import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import { RocDomainError } from '../../errors';
import { FORGE_EXHAUSTED_CODES } from '../errors';
import { createForgeMessageId, readForgeMessageTag, tagForgeMessage } from '../message-tags';
import { prerequisiteNudge, stepNudge } from '../nudge-templates';
import type { PrerequisitesConfig } from '../prerequisites-config';
import {
  areRequiredStepsSatisfied,
  bumpIteration,
  checkPrerequisitesMet,
  forgeGuardrailsStateSchema,
  markIterationOnMessage,
  pendingRequiredSteps,
  recordToolExecution,
  type ForgeErrorTrackerState,
  type ForgeStepTrackerState
} from '../state-schema';
import { resolveWorkflow, type WorkflowHint } from '../workflow-resolver';

export function createStepEnforcementMiddleware(opts: {
  resolveWorkflowFromContext: () => WorkflowHint;
  prerequisitesConfig: PrerequisitesConfig;
}) {
  return createMiddleware({
    name: 'ForgeStepEnforcement',
    stateSchema: forgeGuardrailsStateSchema,
    beforeAgent: (state) => {
      const existing = state.forge_step_tracker;
      if (existing !== undefined && isInitializedTracker(existing)) {
        return undefined;
      }

      const workflow = resolveWorkflow(opts.resolveWorkflowFromContext());
      const executedTools = existing === undefined ? {} : existing.executedTools;
      return {
        forge_step_tracker: {
          executedTools,
          requiredSteps: workflow === null ? [] : workflow.requiredSteps,
          terminalTools: workflow === null ? [] : workflow.terminalTools,
          iterationIndex: 0,
          prematureAttempts: 0,
          prereqViolations: 0
        }
      };
    },
    beforeModel: (state) => {
      const tracker = state.forge_step_tracker;
      if (tracker === undefined) {
        return undefined;
      }

      const bumped = bumpIteration(tracker);
      const lastAi = findLastAiMessage(state.messages);
      if (lastAi !== undefined) {
        markIterationOnMessage(lastAi, bumped.iterationIndex);
      }

      return {
        forge_step_tracker: bumped
      };
    },
    afterModel: {
      canJumpTo: ['model'],
      hook: (state) => {
        const tracker = state.forge_step_tracker;
        if (tracker === undefined) {
          return undefined;
        }

        const last = state.messages[state.messages.length - 1];
        if (!AIMessage.isInstance(last)) {
          return undefined;
        }
        const toolCalls = last.tool_calls;
        if (toolCalls === undefined || toolCalls.length === 0) {
          return undefined;
        }

        const terminalCalls = toolCalls.filter((toolCall) => tracker.terminalTools.includes(toolCall.name));
        if (terminalCalls.length > 0 && !areRequiredStepsSatisfied(tracker)) {
          const nextAttempts = tracker.prematureAttempts + 1;
          const maxAttempts = readMaxPrematureAttempts(state.forge_error_tracker);
          if (nextAttempts > maxAttempts) {
            throw new RocDomainError({
              code: FORGE_EXHAUSTED_CODES.stepEnforcement,
              message: `模型连续 ${nextAttempts} 次过早调用终止工具。`,
              category: 'external',
              retryable: true,
              userAction: '请检查 workflow 设置或模型行为。'
            });
          }
          const pendingSteps = pendingRequiredSteps(tracker);
          const tier = Math.min(nextAttempts, 3) as 1 | 2 | 3;
          return {
            messages: terminalCalls.map((toolCall) =>
              createStepNudgeMessage(toolCall.name, readToolCallId(toolCall, 'step'), pendingSteps, tier)
            ),
            forge_step_tracker: {
              ...tracker,
              prematureAttempts: nextAttempts
            },
            jumpTo: 'model' as const
          };
        }

        const violations = toolCalls
          .map((toolCall) => readPrereqViolation(tracker, toolCall, opts.prerequisitesConfig))
          .filter((violation): violation is PrereqViolation => violation !== null);
        if (violations.length === 0) {
          return undefined;
        }

        const nextViolations = tracker.prereqViolations + 1;
        const maxViolations = readMaxPrereqViolations(state.forge_error_tracker);
        if (nextViolations > maxViolations) {
          throw new RocDomainError({
            code: FORGE_EXHAUSTED_CODES.prerequisite,
            message: `模型连续 ${nextViolations} 次违反前置依赖。`,
            category: 'external',
            retryable: true,
            userAction: '请检查 prereq 设置或模型行为。'
          });
        }

        return {
          messages: violations.map((violation) =>
            createPrerequisiteNudgeMessage(
              violation.toolName,
              readToolCallId(violation.toolCall, 'prereq'),
              violation.missing
            )
          ),
          forge_step_tracker: {
            ...tracker,
            prereqViolations: nextViolations
          },
          jumpTo: 'model' as const
        };
      }
    },
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      if (!ToolMessage.isInstance(result)) {
        return result;
      }
      if (result.status === 'error' || readForgeMessageTag(result) === 'forge:tool_resolution') {
        return result;
      }

      const tracker = request.state.forge_step_tracker;
      if (tracker === undefined) {
        return result;
      }

      const updatedTracker = recordToolExecution(tracker, request.toolCall.name, readToolArgs(request.toolCall.args));
      return new Command({
        update: {
          messages: [result],
          forge_step_tracker: updatedTracker
        }
      });
    }
  });
}

type ToolCallLike = {
  args?: unknown;
  id?: string;
  name: string;
};

type PrereqViolation = {
  missing: string[];
  toolCall: ToolCallLike;
  toolName: string;
};

function isInitializedTracker(tracker: ForgeStepTrackerState): boolean {
  return tracker.requiredSteps.length > 0 || tracker.terminalTools.length > 0 || tracker.iterationIndex > 0;
}

function findLastAiMessage(messages: readonly unknown[]): AIMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (AIMessage.isInstance(message)) {
      return message;
    }
  }
  return undefined;
}

function readMaxPrematureAttempts(tracker: ForgeErrorTrackerState | undefined): number {
  if (tracker === undefined) {
    return 3;
  }
  return tracker.maxPrematureAttempts;
}

function readMaxPrereqViolations(tracker: ForgeErrorTrackerState | undefined): number {
  if (tracker === undefined) {
    return 2;
  }
  return tracker.maxPrereqViolations;
}

function readToolArgs(args: unknown): Record<string, unknown> {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

function readToolCallId(toolCall: ToolCallLike, prefix: string): string {
  if (toolCall.id !== undefined) {
    return toolCall.id;
  }
  return `${prefix}_${toolCall.name}`;
}

function readPrereqViolation(
  tracker: ForgeStepTrackerState,
  toolCall: ToolCallLike,
  prerequisitesConfig: PrerequisitesConfig
): PrereqViolation | null {
  const toolName = toolCall.name;
  const args = readToolArgs(toolCall.args);
  const rules = prerequisitesConfig.prerequisites[toolName];
  if (rules === undefined || rules.length === 0) {
    return null;
  }
  const result = checkPrerequisitesMet(tracker, toolName, args, rules);
  if (result.satisfied) {
    return null;
  }
  return {
    missing: result.missing,
    toolCall,
    toolName
  };
}

function createStepNudgeMessage(
  toolName: string,
  toolCallId: string,
  pendingSteps: readonly string[],
  tier: 1 | 2 | 3
): ToolMessage {
  const message = tagForgeMessage(
    new ToolMessage({
      id: createForgeMessageId('step-nudge', toolCallId),
      tool_call_id: toolCallId,
      name: toolName,
      content: `[StepEnforcementError] ${stepNudge(toolName, pendingSteps, tier)}`,
      status: 'error'
    }),
    'forge:step_nudge'
  );
  message.additional_kwargs.forge_nudge_tier = tier;
  return message;
}

function createPrerequisiteNudgeMessage(toolName: string, toolCallId: string, missing: readonly string[]): ToolMessage {
  return tagForgeMessage(
    new ToolMessage({
      id: createForgeMessageId('prerequisite-nudge', toolCallId),
      tool_call_id: toolCallId,
      name: toolName,
      content: `[PrerequisiteError] ${prerequisiteNudge(toolName, missing)}`,
      status: 'error'
    }),
    'forge:prerequisite_nudge'
  );
}
