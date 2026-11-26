/** Null selects all source pages; explicit selection is bounded before rendering. */
export function selectedPageNumbers(value: string): number[] | null {
  if (value.trim().length === 0) return null;
  const pages = new Set<number>();
  for (const part of value.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(part.trim());
    if (!match) throw new Error('research_parse_page_range_invalid');
    const start = Number(match[1]), end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > 10_000 || end - start >= 500) {
      throw new Error('research_parse_page_range_invalid');
    }
    for (let page = start; page <= end; page++) pages.add(page);
    if (pages.size > 500) throw new Error('research_parse_page_limit');
  }
  return [...pages].sort((a, b) => a - b);
}
export function parsePageRange(value: string, pageCount: number): number[] {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 10_000) throw new Error('research_pdf_page_limit');
  const selected = selectedPageNumbers(value);
  if (selected === null && pageCount > 500) throw new Error('research_parse_page_limit');
  if (selected?.some(page => page > pageCount)) throw new Error('research_parse_page_range_invalid');
  return selected ?? Array.from({length: pageCount}, (_, index) => index + 1);
}
