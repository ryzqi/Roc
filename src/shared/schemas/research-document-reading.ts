import {z} from 'zod';

export const researchBlockReadingSchema = z.object({
  version: z.literal(1),
  role: z.enum(['body', 'heading', 'caption', 'object', 'page_header', 'page_footer', 'page_number', 'unknown']),
  source: z.literal('rule'),
  // Explicit heuristic strength; not recognizer confidence or a calibrated probability.
  ruleScore: z.number().min(0).max(1).nullable(),
  signals: z.array(z.string().min(1)).max(8),
  continuesFrom: z.string().min(1).nullable(),
  continuesTo: z.string().min(1).nullable()
}).strict();
export type ResearchBlockReading = z.infer<typeof researchBlockReadingSchema>;

export function isPageMargin(role: ResearchBlockReading['role'] | undefined): boolean {
  return role === 'page_header' || role === 'page_footer' || role === 'page_number';
}

/** Validate references at publication, including coherent reciprocal adjacent-page identities. */
export function assertDocumentReadingLinks(blocks: readonly {
  id: string; reading?: ResearchBlockReading; locations: readonly {page: number}[]
}[]): void {
  const byId = new Map(blocks.map(block => [block.id, block]));
  for (const block of blocks) {
    if (!block.reading) continue;
    for (const direction of ['continuesFrom', 'continuesTo'] as const) {
      const id = block.reading[direction];
      if (id === null) continue;
      const other = byId.get(id), forward = direction === 'continuesTo';
      const page = block.locations[0]?.page, otherPage = other?.locations[0]?.page;
      if (!other || id === block.id || block.reading.role !== 'body' || other.reading?.role !== 'body' ||
          block.locations.length !== 1 || other.locations.length !== 1 || page === undefined || otherPage === undefined ||
          otherPage !== page + (forward ? 1 : -1) ||
          other.reading[forward ? 'continuesFrom' : 'continuesTo'] !== block.id) {
        throw new Error('research_document_reading_link_invalid');
      }
    }
  }
}
