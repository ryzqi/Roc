import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { createResponseValidator, type ResponseContract } from '../../../shared/schemas/response-contract';
import { readMessageContentSummary } from './record-utils';

/** One correction in the ordinary model loop; the checkpoint owns its run-scoped counter. */
export function createResponseContractMiddleware(runId: string, contract: ResponseContract) {
  const validate = createResponseValidator(contract);
  return createMiddleware({
    name: 'RocResponseContractMiddleware',
    stateSchema: z.object({
      rocResponseCorrection: z.object({ runId: z.string(), attempts: z.literal(1) }).optional()
    }),
    afterModel: {
      canJumpTo: ['model'],
      hook: (state, runtime) => {
        runtime.signal?.throwIfAborted();
        const message = state.messages.at(-1);
        if (!AIMessage.isInstance(message) || (message.tool_calls?.length ?? 0) > 0) return;
        const summary = readMessageContentSummary(message);
        const result = validate(summary.hasVisibleText ? summary.visibleText : null);
        if (result.passed || state.rocResponseCorrection?.runId === runId) return;
        return {
          rocResponseCorrection: { runId, attempts: 1 as const },
          messages: [new HumanMessage({
            id: `roc-response-correction:${runId}`,
            content: `Your final response failed the user-provided response contract: ${result.detail}\n` +
              'Return the complete corrected JSON value, without commentary. Keep the answer within the question scope and use only inspected evidence. ' +
              'The response schema in the task contract still applies. This is the only format correction.'
          })],
          jumpTo: 'model'
        };
      }
    }
  });
}
