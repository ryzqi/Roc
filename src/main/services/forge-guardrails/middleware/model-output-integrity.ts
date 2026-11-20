import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { RocDomainError } from '../../errors';
import { readModelOutputCompletion } from '../../model-output-completion';

const REJECTED_CALLS = 'roc_truncated_tool_calls';
const REJECTED_RAW_CALLS = 'roc_truncated_provider_tool_calls';
const REJECTED_CONTENT = 'roc_truncated_content';
const FEEDBACK = 'The model response hit its output limit and is incomplete. No tools from that response were executed. ' +
  'Re-issue the intended calls with complete arguments. Reduce the batch size or split large content into smaller complete calls; do not continue partial JSON. ' +
  'Only one correction is allowed for this run.';

/** Uses the ordinary graph loop and checkpoint state; does not retry effects or hide model usage. */
export function createModelOutputIntegrityMiddleware(runId: string) {
  return createMiddleware({
    name: 'RocModelOutputIntegrityMiddleware',
    stateSchema: z.object({
      rocOutputCorrection: z.object({ runId: z.string(), attempts: z.number().int().nonnegative() }).optional()
    }),
    wrapModelCall: async (request, handler) => {
      request.runtime.signal?.throwIfAborted();
      // jumpTo=model resumes at the model node, skipping beforeModel hooks.
      const correction = request.state.rocOutputCorrection;
      if (correction?.runId === runId && correction.attempts > 1) {
        throw new RocDomainError({
          code: 'agent_model_output_truncated', category: 'validation', retryable: false,
          message: '模型响应连续超过输出限制，已停止执行；截断响应中的工具均未执行。',
          userAction: '请缩小任务或调整模型输出额度后重试。'
        });
      }
      const response = await handler(request);
      if (readModelOutputCompletion(response.response_metadata, response.additional_kwargs) !== 'truncated' || !response.tool_calls?.length) return response;
      // Deep Agents appends HITL after custom middleware, so its afterModel runs first.
      // Keep incomplete proposals away from approval until our afterModel pairs them with errors.
      const { tool_calls: rawToolCalls, ...additional_kwargs } = response.additional_kwargs;
      return new AIMessage({
        id: response.id, name: response.name,
        content: typeof response.content === 'string' ? response.content : response.content.filter(block =>
          block.type !== 'tool_use' && block.type !== 'tool_call' && block.type !== 'function_call'),
        tool_calls: [],
        invalid_tool_calls: response.invalid_tool_calls,
        response_metadata: response.response_metadata, usage_metadata: response.usage_metadata,
        additional_kwargs: { ...additional_kwargs, [REJECTED_CALLS]: response.tool_calls, [REJECTED_CONTENT]: response.content,
          ...(rawToolCalls === undefined ? {} : { [REJECTED_RAW_CALLS]: rawToolCalls }) }
      });
    },
    afterModel: {
      canJumpTo: ['model'],
      hook: (state, runtime) => {
        runtime.signal?.throwIfAborted();
        const message = state.messages.at(-1);
        if (!AIMessage.isInstance(message) || readModelOutputCompletion(message.response_metadata, message.additional_kwargs) !== 'truncated') return;
        const attempts = state.rocOutputCorrection?.runId === runId ? state.rocOutputCorrection.attempts : 0;
        const { [REJECTED_CALLS]: rejectedCalls, [REJECTED_RAW_CALLS]: rawToolCalls,
          [REJECTED_CONTENT]: rejectedContent, ...additional_kwargs } = message.additional_kwargs;
        const calls = (Array.isArray(rejectedCalls) ? rejectedCalls as NonNullable<AIMessage['tool_calls']> : message.tool_calls ?? [])
          .map((call, index) => ({ ...call, id: call.id ?? `roc-output-call:${message.id}:${index}` }));
        // These fields were moved from this AIMessage before approval; restore their native shapes.
        const providerToolCalls = rawToolCalls as AIMessage['additional_kwargs']['tool_calls'];
        const content = (rejectedContent ?? message.content) as AIMessage['content'];
        const restoredMessages = calls.length > 0 ? [
          new AIMessage({ id: message.id, name: message.name, content,
            additional_kwargs: { ...additional_kwargs, ...(providerToolCalls === undefined ? {} : { tool_calls: providerToolCalls }) },
            response_metadata: message.response_metadata, usage_metadata: message.usage_metadata,
            invalid_tool_calls: message.invalid_tool_calls, tool_calls: calls })
        ] : [];
        // OpenAI falls back to raw calls when no arguments could be parsed. Pair those
        // IDs too, otherwise the next provider request contains unanswered proposals.
        const rejected = calls.length > 0 ? calls : (additional_kwargs.tool_calls ?? []).map(call => ({ id: call.id, name: call.function.name }));
        const messages = rejected.length > 0 ? [
          ...restoredMessages,
          ...rejected.map(call => new ToolMessage({
            id: `roc-output-rejection:${message.id}:${call.id}`,
            tool_call_id: call.id, name: call.name, content: FEEDBACK, status: 'error'
          }))
        ] : [new HumanMessage({ id: `roc-output-rejection:${message.id}`, content: FEEDBACK })];
        return { messages, rocOutputCorrection: { runId, attempts: attempts + 1 }, jumpTo: 'model' };
      }
    }
  });
}
