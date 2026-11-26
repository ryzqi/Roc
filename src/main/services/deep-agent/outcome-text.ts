import {RocDomainError} from '../errors';

// At most 16 MiB of UTF-16 payload before final assembly. Never silently truncate.
export const maxOutcomeTextCharacters = 8 * 1024 * 1024;

export function createOutcomeTextCollector(hookDisplayTexts: readonly string[]): {
  finish: () => string;
  push: (delta: string) => void;
} {
  const chunks: string[] = [];
  const blocks: string[] = [];
  let receivedCharacters = 0;
  const append = (text: string): void => {
    if (text.length === 0) return;
    chunks.push(text);
    if (chunks.length >= 256) {
      blocks.push(chunks.join(''));
      chunks.length = 0;
    }
  };
  let pendingPrefix = '';
  let prefixResolved = false;

  const consumePrefix = (): void => {
    while (pendingPrefix.length > 0) {
      const matchingHookText = [...hookDisplayTexts]
        .sort((left, right) => right.length - left.length)
        .find((text) => pendingPrefix.startsWith(text));
      if (matchingHookText !== undefined) {
        pendingPrefix = pendingPrefix.slice(matchingHookText.length).trimStart();
        continue;
      }
      if (hookDisplayTexts.some((text) => text.startsWith(pendingPrefix))) {
        return;
      }
      prefixResolved = true;
      append(pendingPrefix);
      pendingPrefix = '';
    }
  };

  return {
    finish: () => {
      consumePrefix();
      if (!prefixResolved && pendingPrefix.length > 0) {
        append(pendingPrefix);
        pendingPrefix = '';
      }
      const result = blocks.join('') + chunks.join('');
      blocks.length = 0;
      chunks.length = 0;
      return result;
    },
    push: (delta) => {
      if (delta.length > maxOutcomeTextCharacters - receivedCharacters) {
        throw new RocDomainError({code: 'agent_output_memory_limit',
          message: '本轮输出超过内存容量限制，已停止。请拆分任务后继续。', category: 'internal', retryable: false});
      }
      receivedCharacters += delta.length;
      if (prefixResolved) {
        append(delta);
        return;
      }
      pendingPrefix += delta;
      consumePrefix();
    }
  };
}

