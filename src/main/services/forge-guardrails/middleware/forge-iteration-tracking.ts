import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import {
  markIterationOnMessage,
  readIterationFromMessage
} from '../state-schema';

export function createForgeIterationTrackingMiddleware() {
  return createMiddleware({
    name: 'ForgeIterationTrackingMiddleware',
    beforeModel: (state) => {
      const lastAi = findLastAiMessage(state.messages);
      if (lastAi === undefined) {
        return undefined;
      }
      if (readIterationFromMessage(lastAi) !== null) {
        return undefined;
      }

      markIterationOnMessage(lastAi, readNextIterationIndex(state.messages));
      return undefined;
    }
  });
}

function findLastAiMessage(messages: readonly BaseMessage[]): AIMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && AIMessage.isInstance(message)) {
      return message;
    }
  }
  return undefined;
}

function readNextIterationIndex(messages: readonly BaseMessage[]): number {
  let maxIteration = -1;
  for (const message of messages) {
    const iterationIndex = readIterationFromMessage(message);
    if (iterationIndex !== null && iterationIndex > maxIteration) {
      maxIteration = iterationIndex;
    }
  }
  return maxIteration + 1;
}
