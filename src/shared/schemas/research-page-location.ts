import {z} from 'zod';

/** Unknown geometry keeps its actual page; coordinates and origin are always absent together. */
export const researchPageLocationSchema = z.object({page: z.number().int().positive(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()])
    .refine(box => box[2] > box[0] && box[3] > box[1], 'research_page_region_invalid').nullable(),
  coordinateOrigin: z.enum(['TOPLEFT', 'BOTTOMLEFT']).nullable()
}).strict().refine(location => (location.bbox === null) === (location.coordinateOrigin === null),
  'A region and its coordinate origin must be present together.');
export type ResearchPageLocation = z.infer<typeof researchPageLocationSchema>;

export function sameResearchPageLocation(a: ResearchPageLocation, b: ResearchPageLocation): boolean {
  return a.page === b.page && a.coordinateOrigin === b.coordinateOrigin &&
    (a.bbox === null || b.bbox === null ? a.bbox === b.bbox : a.bbox.every((value, index) => value === b.bbox![index]));
}
