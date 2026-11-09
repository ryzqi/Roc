import {Tiktoken} from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/cl100k_base';

export const knowledgeChunkVersion = 'roc-structure-cl100k-1';
export const knowledgeChunkTokens = 512;
let tokenizer: Tiktoken | undefined;
export function chunkTokenCount(text: string): number {
  return (tokenizer ??= new Tiktoken(ranks)).encode(text, [], []).length;
}

export type TextSpan = {start: number; end: number; section: string | null};

/** Exact UTF-16 spans. Paragraph/heading boundaries are preferred; long lines remain bounded.
 * cl100k is a reproducible indexing budget, not a promise about every provider's tokenizer. */
export function structuredSpans(text: string, inheritedSection: string | null = null): TextSpan[] {
  const boundaries = new Set<number>([text.length]);
  const headings = new Map<number, string>();
  const hierarchy: string[] = [];
  for (const match of text.matchAll(/^([ \t]*#{1,6})[ \t]+([^\r\n]+)|\\(subsubsection|subsection|section)\{([^}]+)\}|(?:\r?\n|\r)[ \t]*(?:\r?\n|\r)/gmu)) {
    if (match[1] || match[3]) {
      const level = match[1] ? match[1].trim().length : ({section: 1, subsection: 2, subsubsection: 3}[match[3]!] ?? 1);
      hierarchy.length = level - 1;
      hierarchy[level - 1] = (match[2] ?? match[4]!).trim();
      headings.set(match.index, hierarchy.filter(Boolean).join(' / ').slice(0, 2000));
      boundaries.add(match.index);
    } else boundaries.add(match.index + match[0].length);
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const spans: TextSpan[] = [];
  const headingPoints = [...headings.keys()];
  let start = 0, section = inheritedSection, boundaryIndex = 0, headingIndex = 0;
  while (start < text.length) {
    section = headings.get(start) ?? section;
    while (points[boundaryIndex]! <= start) boundaryIndex++;
    let end = Math.min(start + 2000, text.length);
    while (headingPoints[headingIndex] !== undefined && headingPoints[headingIndex]! <= start) headingIndex++;
    const nextHeading = headingPoints[headingIndex];
    if (nextHeading !== undefined) end = Math.min(end, nextHeading);
    const safeEnd = (value: number): number => value < text.length && /[\uD800-\uDBFF]/u.test(text[value - 1]!) ? value - 1 : value;
    end = safeEnd(end);
    const probeEnd = safeEnd(Math.min(start + 512, end));
    if (probeEnd < end && chunkTokenCount(text.slice(start, probeEnd)) > 160) end = probeEnd;
    while (chunkTokenCount(text.slice(start, end)) > knowledgeChunkTokens) end = safeEnd(start + Math.floor((end - start) * 0.75));
    // Prefer a whole paragraph when it fits; no decode/re-encode can alter original characters.
    let preferred = end;
    for (let i = boundaryIndex; points[i] !== undefined && points[i]! <= end; i++) preferred = points[i]!;
    if (preferred > start) end = preferred;
    spans.push({start, end, section});
    start = end;
  }
  return spans;
}

export function spanLocator(locator: string | null, span: Pick<TextSpan, 'start' | 'end'>): string {
  return `${locator ?? 'text'}; UTF-16 ${span.start + 1}-${span.end}`;
}
