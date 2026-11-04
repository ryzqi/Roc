import {z} from 'zod';

const point = z.number();
export const researchCoordinateFrameContractVersion = 1;
const rectangle = z.tuple([point, point, point, point]);
const raster = {
  page: z.number().int().positive(), unit: z.literal('raster-pixel'), coordinateOrigin: z.literal('TOPLEFT'),
  width: z.number().int().positive(), height: z.number().int().positive()
};
export const researchPdfCoordinateFrameSchema = z.object({
  kind: z.literal('pdf'), ...raster,
  viewport: z.object({
    width: z.number().positive(), height: z.number().positive(), scale: z.number().positive(),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    userUnit: z.number().positive(), viewBox: rectangle,
    transform: z.tuple([point, point, point, point, point, point])
  }).strict().refine(viewport => {
    const [a, b, c, d] = viewport.transform;
    const determinant = a * d - b * c;
    return Number.isFinite(determinant) && determinant !== 0 &&
      viewport.viewBox[2] > viewport.viewBox[0] && viewport.viewBox[3] > viewport.viewBox[1];
  }, 'A PDF viewport must have an invertible measured transform and a nonempty viewBox.')
}).strict().refine(frame => frame.width === Math.round(frame.viewport.width) && frame.height === Math.round(frame.viewport.height),
  'Raster dimensions must match the measured PDF viewport.');
export const researchRasterCoordinateFrameSchema = z.object({kind: z.literal('image'), ...raster}).strict();
export const researchDocumentCoordinateFrameSchema = z.union([researchPdfCoordinateFrameSchema, researchRasterCoordinateFrameSchema]);
export const researchParsedRegionProjectionSchema = z.object({
  frame: researchPdfCoordinateFrameSchema, bbox: rectangle, coordinateOrigin: z.enum(['TOPLEFT', 'BOTTOMLEFT'])
}).strict().refine(({frame, bbox: [x1, y1, x2, y2]}) =>
  x1 >= 0 && y1 >= 0 && x2 <= frame.width && y2 <= frame.height && x2 > x1 && y2 > y1,
'A parsed region must be a nonempty XYXY rectangle inside its captured raster.');

export type ResearchPdfCoordinateFrame = z.infer<typeof researchPdfCoordinateFrameSchema>;
export type ResearchDocumentCoordinateFrame = z.infer<typeof researchDocumentCoordinateFrameSchema>;
export type ResearchParsedRegionProjection = z.infer<typeof researchParsedRegionProjectionSchema>;
