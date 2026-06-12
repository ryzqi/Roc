import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import { RocDomainError } from '../../errors';
import { FORGE_EXHAUSTED_CODES } from '../errors';
import { FORGE_TRANSIENT_TYPES, readForgeMessageTag } from '../message-tags';
import {
  defaultErrorTracker,
  forgeGuardrailsStateSchema,
  type ForgeErrorTrackerState
} from '../state-schema';

export function createErrorBudgetMiddleware(opts: { maxRetries?: number; maxToolErrors?: number } = {}) {
  const maxRetries = opts.maxRetries === undefined ? 3 : opts.maxRetries;
  const maxToolErrors = opts.maxToolErrors === undefined ? 2 : opts.maxToolErrors;

  return createMiddleware({
    name: 'ForgeErrorBudgetMiddleware',
    stateSchema: forgeGuardrailsStateSchema,
    beforeAgent: (state) => {
      const existing = state.forge_error_tracker;
      if (existing !== undefined && existing.maxRetries !== undefined) {
        return undefined;
      }
      return {
        forge_error_tracker: {
          consecutiveRetries: 0,
          consecutiveToolErrors: 0,
          maxRetries,
          maxToolErrors
        }
      };
    },
    beforeModel: (state) => {
      const tracker = readTracker(state.forge_error_tracker);
      const last = state.messages[state.messages.length - 1];
      if (last === undefined) {
        return undefined;
      }
      const tag = readForgeMessageTag(last);
      const isNudge = tag !== null && FORGE_TRANSIENT_TYPES.has(tag);

      if (!isNudge) {
        if (tracker.consecutiveRetries === 0) {
          return undefined;
        }
        return {
          forge_error_tracker: {
            ...tracker,
            consecutiveRetries: 0
          }
        };
      }

      const next = tracker.consecutiveRetries + 1;
      if (next > tracker.maxRetries) {
        throw new RocDomainError({
          code: FORGE_EXHAUSTED_CODES.retries,
          message: `连续 ${next} 次 nudge 后模型仍未给出合法工具调用，停止运行。`,
          category: 'external',
          retryable: true,
          userAction: '请检查模型 / prompt 配置后重试。'
        });
      }
      return {
        forge_error_tracker: {
          ...tracker,
          consecutiveRetries: next
        }
      };
    },
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      if (!ToolMessage.isInstance(result)) {
        return result;
      }

      const tracker = readTracker(request.state.forge_error_tracker);
      const isSoftError = readForgeMessageTag(result) === 'forge:tool_resolution';
      const isHardError = result.status === 'error' && !isSoftError;

      if (isHardError) {
        const next = tracker.consecutiveToolErrors + 1;
        if (next > tracker.maxToolErrors) {
          throw new RocDomainError({
            code: FORGE_EXHAUSTED_CODES.toolErrors,
            message: `连续工具失败 ${next} 次，停止运行。`,
            category: 'external',
            retryable: true,
            userAction: '请检查工具实现或 Provider 状态后重试。'
          });
        }
        return new Command({
          update: {
            messages: [result],
            forge_error_tracker: {
              ...tracker,
              consecutiveToolErrors: next
            }
          }
        });
      }

      if (tracker.consecutiveToolErrors > 0) {
        return new Command({
          update: {
            messages: [result],
            forge_error_tracker: {
              ...tracker,
              consecutiveToolErrors: 0
            }
          }
        });
      }

      return result;
    }
  });
}

function readTracker(value: ForgeErrorTrackerState | undefined): ForgeErrorTrackerState {
  if (value === undefined) {
    return defaultErrorTracker();
  }
  return value;
}
