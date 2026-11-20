import type { PDFDocumentProxy } from 'pdfjs-dist';

/** Bound retained extracted text, independently of the size of the PDF being searched. */
export function createPdfTextCache(
  pdf: Pick<PDFDocumentProxy, 'getPage'>,
  { maxPages = 32, maxCharacters = 1_000_000 }: { maxPages?: number; maxCharacters?: number } = {}
): (number: number) => Promise<string> {
  const cached = new Map<number, string>();
  const pending = new Map<number, Promise<string>>();
  let characters = 0;
  return (number) => {
    const text = cached.get(number);
    if (text !== undefined) {
      cached.delete(number);
      cached.set(number, text);
      return Promise.resolve(text);
    }
    const existing = pending.get(number);
    if (existing !== undefined) return existing;
    const request = pdf.getPage(number).then(page => page.getTextContent()).then(content => {
      const text = content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('');
      // Oversized pages are usable by the caller without becoming permanent cache entries.
      if (maxPages > 0 && text.length <= maxCharacters) {
        cached.set(number, text);
        characters += text.length;
        while (cached.size > maxPages || characters > maxCharacters) {
          const oldest = cached.keys().next().value!;
          characters -= cached.get(oldest)!.length;
          cached.delete(oldest);
        }
      }
      return text;
    }).finally(() => pending.delete(number));
    pending.set(number, request);
    return request;
  };
}
