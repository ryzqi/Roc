import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { createResponseValidator, type ResponseContract, type ResponseJsonSchema } from '../../../shared/schemas/response-contract';
import { readMessageContentSummary } from './record-utils';

/**
 * Native ToolStrategy can enforce this structural-only, fully-required subset.
 * Refinements, optional fields and uniqueItems stay on Roc's checkpointed one-
 * correction path; their retry semantics must survive restart unchanged.
 * Final acceptance independently validates the complete contract in both cases.
 */
export function supportsNativeResponseContract(contract: ResponseContract): boolean {
  if (contract.schema.type !== 'object') return false;
  const eligible = (schema: ResponseJsonSchema): boolean => {
    if (schema.type === 'array') return schema.uniqueItems !== true &&
      schema.minItems === undefined && schema.maxItems === undefined && eligible(schema.items);
    if (schema.type === 'string') return schema.enum === undefined &&
      schema.minLength === undefined && schema.maxLength === undefined;
    if (schema.type === 'number' || schema.type === 'integer') return schema.enum === undefined &&
      schema.minimum === undefined && schema.maximum === undefined;
    if (schema.type === 'boolean') return schema.enum === undefined;
    if (schema.type === 'null') return true;
    const keys = Object.keys(schema.properties);
    return schema.required.length === keys.length &&
      keys.every(key => schema.required.includes(key) && eligible(schema.properties[key]!));
  };
  return eligible(contract.schema);
}

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
