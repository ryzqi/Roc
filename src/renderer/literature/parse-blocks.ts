import type { ResearchDocumentContent } from '../../shared/types';

/**
 * Turns a parsed document into the blocks the reader renders.
 *
 * Why a separate module with tests: the contract's `blocks` array is large and
 * loosely ordered (headings, paragraphs, tables, formulas and figures interleaved,
 * each with its own `locations`), and the reader must not lose any of them —
 * a parse you cannot read is indistinguishable from a failed parse.
 *
 * What this deliberately does **not** do:
 *
 *   - no Markdown/LaTeX re-rendering of `content` (that is P7's manuscript work);
 *   - no HTML/markup interpretation of block text;
 *   - no invented text for a block whose `text` is empty — an empty block still
 *     appears, labelled, because silently dropping it would hide a parse gap.
 */

export type ParsedBlockKind = ResearchDocumentContent['blocks'][number]['kind'];

export type ParsedBlock = {
  id: string;
  kind: ParsedBlockKind;
  label: string;
  text: string;
  locator: string;
  /** 1-based page of the first location, or null when the parser gave none. */
  page: number | null;
  /** True when the block's text is empty — the reader shows a placeholder. */
  isBlank: boolean;
};

/** Blocks in document order, with the first page resolved from `locations`. */
export function parseDocumentBlocks(content: ResearchDocumentContent): ParsedBlock[] {
  return content.blocks.map((block) => {
    const firstLocation = block.locations[0];
    return {
      id: block.id,
      kind: block.kind,
      label: block.label.trim().length > 0 ? block.label : `（无标签 ${block.kind}）`,
      text: block.text,
      locator: block.locator,
      page: firstLocation === undefined ? null : firstLocation.page,
      isBlank: block.text.trim().length === 0
    };
  });
}

export type ParseCounts = {
  total: number;
  headings: number;
  paragraphs: number;
  tables: number;
  formulas: number;
  figures: number;
  /** Pages actually referenced by at least one block. */
  pagesCovered: number;
};

/**
 * Counts for the reader's summary line.
 *
 * These are the numbers gate 1 asks about ("章节、至少一个公式、至少一个表格"), so
 * they are computed from the same array that is rendered — not re-queried, and not
 * estimated from the parse metadata.
 */
export function countParsedBlocks(content: ResearchDocumentContent): ParseCounts {
  const blocks = parseDocumentBlocks(content);
  const pages = new Set<number>();
  for (const block of blocks) {
    // `page` is null only when the parser gave no locations for that block.
    if (block.page !== null) {
      pages.add(block.page);
    }
  }
  return {
    total: blocks.length,
    headings: blocks.filter((block) => block.kind === 'heading').length,
    paragraphs: blocks.filter((block) => block.kind === 'paragraph').length,
    tables: blocks.filter((block) => block.kind === 'table').length,
    formulas: blocks.filter((block) => block.kind === 'formula').length,
    figures: blocks.filter((block) => block.kind === 'figure').length,
    pagesCovered: pages.size
  };
}
