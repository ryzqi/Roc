import { RemoveMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { isForgeTransientMessage } from '../message-tags';

export function createForgeCleanupMiddleware() {
  return createMiddleware({
    name: 'ForgeCleanupMiddleware',
    afterAgent: (state) => {
      const removals: RemoveMessage[] = [];
      for (const message of state.messages) {
        if (!isForgeTransientMessage(message)) {
          continue;
        }
        if (message.id === undefined) {
          continue;
        }
        removals.push(new RemoveMessage({ id: message.id }));
      }

      if (removals.length === 0) {
        return undefined;
      }
      return {
        messages: removals
      };
    }
  });
}
