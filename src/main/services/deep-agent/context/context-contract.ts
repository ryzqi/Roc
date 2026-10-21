import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';

const contractSchema = z.object({
  userConstraints: z.array(z.string()),
  acceptanceIds: z.array(z.string()),
  pendingEffects: z.array(z.string()),
  pendingApprovals: z.array(z.string()),
  sourceSpans: z.array(z.string())
}).strict();

export type ContextControlState = Pick<z.infer<typeof contractSchema>, 'acceptanceIds' | 'pendingEffects' | 'pendingApprovals'>;
const contractId = 'roc-context-contract';

export function isContextContract(message: BaseMessage): boolean {
  return message.getType() === 'human' && message.id === contractId && message.additional_kwargs.roc_context_contract === true;
}

export function collectUserConstraints(messages: readonly BaseMessage[]): string[] {
  const constraints: string[] = [];
  for (const message of messages) {
    if (isContextContract(message)) {
      constraints.push(...contractSchema.parse(JSON.parse(String(message.content))).userConstraints);
    } else if (message.getType() === 'human') {
      constraints.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
    }
  }
  return [...new Set(constraints)];
}

// Runtime facts survive independently of the model's lossy summary and cannot be marked satisfied by it.
export function pinContextContract(messages: readonly BaseMessage[], original: readonly BaseMessage[],
  state: ContextControlState, sourceSpans: readonly string[]): BaseMessage[] {
  const previous = original.filter(isContextContract).map(message => contractSchema.parse(JSON.parse(String(message.content))));
  const previousSpans = previous.flatMap(contract => contract.sourceSpans);
  const retained = new Set(messages.filter(message => message.getType() === 'human' && !isContextContract(message))
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)));
  const contract = contractSchema.parse({ userConstraints: collectUserConstraints(original).filter(text => !retained.has(text)), ...state,
    acceptanceIds: [...new Set([...previous.flatMap(contract => contract.acceptanceIds), ...state.acceptanceIds])],
    sourceSpans: [...new Set([...previousSpans, ...sourceSpans])] });
  if (Object.values(contract).every(items => items.length === 0)) return messages.filter(message => !isContextContract(message));
  const pinned = new HumanMessage({ id: contractId, content: JSON.stringify(contract),
    additional_kwargs: { roc_context_contract: true } });
  const result = messages.filter(message => !isContextContract(message));
  const firstHuman = result.findIndex(message => message.getType() === 'human');
  result.splice(firstHuman < 0 ? 0 : firstHuman + 1, 0, pinned);
  return result;
}
