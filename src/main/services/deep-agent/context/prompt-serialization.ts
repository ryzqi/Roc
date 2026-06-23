import type { PromptBlock } from './prompt-blocks';

export function serializePromptBlocks(blocks: readonly PromptBlock[]): string {
  return blocks.map((block) => [`<!-- BLOCK:${block.type}:${block.stability}:${block.hash} -->`, block.content].join('\n')).join('\n');
}
