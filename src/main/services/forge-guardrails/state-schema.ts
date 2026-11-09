import type { BaseMessage } from '@langchain/core/messages';

export function markIterationOnMessage(message: BaseMessage, iterationIndex: number): BaseMessage {
  if (message.additional_kwargs === undefined) {
    message.additional_kwargs = {};
  }
  const kwargs = message.additional_kwargs;
  kwargs.forge_iteration_index = iterationIndex;
  return message;
}

export function readIterationFromMessage(message: BaseMessage): number | null {
  const value = message.additional_kwargs?.forge_iteration_index;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
