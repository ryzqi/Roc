import {
  researchParsedRegionProjectionSchema, researchPdfRegionProjectionSchema,
  type ResearchParsedRegionProjection, type ResearchPdfRegionProjection
} from './schemas/research-document-coordinates';

/** Return PDF user-space XYXY coordinates using the captured viewport, including crop, rotation and UserUnit. */
export function projectParsedRegionToPdf(input: ResearchParsedRegionProjection): [number, number, number, number] {
  const {frame, bbox, coordinateOrigin} = researchParsedRegionProjectionSchema.parse(input);
  const [a, b, c, d, e, f] = frame.viewport.transform;
  const determinant = a * d - b * c;
  const [x1, y1, x2, y2] = bbox;
  const points = [[x1, y1], [x1, y2], [x2, y1], [x2, y2]].map(([x, rawY]) => {
    const y = coordinateOrigin === 'BOTTOMLEFT' ? frame.height - rawY : rawY;
    return [(d * (x - e) - c * (y - f)) / determinant, (-b * (x - e) + a * (y - f)) / determinant];
  });
  return [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1])),
    Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))];
}

/** Project a captured PDF user-space rectangle into its measured TOPLEFT raster frame. */
export function projectPdfRegionToParsed(input: ResearchPdfRegionProjection): [number, number, number, number] {
  const {frame, bbox: [x1, y1, x2, y2]} = researchPdfRegionProjectionSchema.parse(input);
  const [a, b, c, d, e, f] = frame.viewport.transform;
  const points = [[x1, y1], [x1, y2], [x2, y1], [x2, y2]]
    .map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  return [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1])),
    Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))];
}
