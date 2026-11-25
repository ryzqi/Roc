import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ovisModelIdentitySchema, type OvisModelIdentity} from '../../../shared/schemas/research-ovis';
import {researchDocumentCoordinateFrameSchema, type ResearchDocumentCoordinateFrame} from '../../../shared/schemas/research-document-coordinates';
import {projectParsedRegionToPdf} from '../../../shared/research-document-coordinates';
import {orderPdfBlocks} from './pdf-reading-order';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const coordinate = z.number().int().min(0).max(999);
const boxSchema = z.tuple([coordinate, coordinate, coordinate, coordinate])
  .refine(([left, top, right, bottom]) => left < right && top < bottom);
const categorySchema = z.enum([
  'abstract', 'algorithm', 'aside_text', 'chart', 'content', 'display_formula',
  'doc_title', 'figure_title', 'footer', 'footer_image', 'footnote', 'formula_number',
  'header', 'header_image', 'image', 'inline_formula', 'number', 'paragraph_title',
  'reference_content', 'seal', 'table', 'text', 'vertical_text', 'vision_footnote'
]);
const documentSchema = z.array(z.object({bbox: boxSchema, category: categorySchema, content: z.string()}).strict()).max(4096);

const envelopeSchema = z.object({
  protocolVersion: z.literal(1), sourceHash: hash, inputImageSha256: hash,
  page: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(),
  model: ovisModelIdentitySchema, rawSha256: hash,
  generation: z.object({finishReason: z.enum(['stop', 'length']), generationTokens: z.number().int().positive().max(16384),
    tokenIds: z.array(z.number().int().nonnegative()).min(1).max(16384)}).strict()
}).strict();
const bindingSchema = z.object({sourceHash: hash, inputImageSha256: hash,
  frame: researchDocumentCoordinateFrameSchema, model: ovisModelIdentitySchema}).strict();
type Box = [number, number, number, number];
type Category = z.infer<typeof categorySchema>;
export type OvisSourceBinding = z.infer<typeof bindingSchema>;
export type OvisPageBlock = {
  id: string; rawIndex: number; category: Category;
  kind: 'heading' | 'paragraph' | 'table' | 'figure' | 'formula';
  /** Exact generated content, including HTML/LaTeX/image references. Never a filesystem path. */
  rawContent: string;
  candidateRegion: {normalizedBox: Box; bbox: Box; coordinateOrigin: 'TOPLEFT'; pdfBox: Box | null};
  verification: 'unverified';
  /** Candidate model geometry is deliberately unavailable to precise citation consumers. */
  citationLocations: [{page: number; bbox: null; coordinateOrigin: null}];
};
export type OvisAdaptedPage = {
  protocolVersion: 1; sourceHash: string; inputImageSha256: string;
  frame: ResearchDocumentCoordinateFrame; model: OvisModelIdentity;
  raw: string; rawSha256: string; generation: z.infer<typeof envelopeSchema>['generation'];
  blocks: OvisPageBlock[]; warnings: string[];
};
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** JSON.parse checks grammar; this separate lexical pass rejects duplicate (also escaped) object keys. */
function parseDocument(raw: string): z.infer<typeof documentSchema> {
  const value: unknown = JSON.parse(raw);
  const keys: Set<string>[] = [];
  const colon = /[\t\n\r ]*:/y;
  for (const token of raw.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu)) {
    if (token[0] === '{') keys.push(new Set());
    else if (token[0] === '}') keys.pop();
    else if (!token[0].startsWith('"')) {
      // Match the Python worker's integer JSON type; 1.0 and 1e0 are floats there.
      if (!/^-?\d+$/u.test(token[0])) throw new Error('research_ovis_noninteger_coordinate');
    }
    else {
      colon.lastIndex = token.index + token[0].length;
      if (!colon.test(raw)) continue;
      const key: string = JSON.parse(token[0]), current = keys.at(-1);
      if (!current || current.has(key)) throw new Error('research_ovis_duplicate_json_key');
      current.add(key);
    }
  }
  return documentSchema.parse(value);
}

function kind(category: Category): OvisPageBlock['kind'] {
  switch (category) {
    case 'doc_title': case 'paragraph_title': return 'heading';
    case 'display_formula': case 'inline_formula': return 'formula';
    case 'table': return 'table';
    case 'chart': case 'image': case 'seal': case 'header_image': case 'footer_image': return 'figure';
    default: return 'paragraph';
  }
}

/** Validate a completed page atomically. This does not qualify, enable or load a model. */
export function adaptOvisPage(rawBytes: Uint8Array, envelopeInput: unknown, bindingInput: OvisSourceBinding): OvisAdaptedPage {
  if (rawBytes.byteLength > 4 * 1024 * 1024) throw new Error('research_ovis_output_limit');
  const envelope = envelopeSchema.parse(envelopeInput), binding = bindingSchema.parse(bindingInput);
  const {frame} = binding;
  if (envelope.sourceHash !== binding.sourceHash || envelope.inputImageSha256 !== binding.inputImageSha256 ||
      envelope.page !== frame.page || envelope.width !== frame.width || envelope.height !== frame.height ||
      JSON.stringify(envelope.model) !== JSON.stringify(binding.model)) throw new Error('research_ovis_source_binding_invalid');
  const {generation} = envelope, last = generation.tokenIds.at(-1);
  if (generation.finishReason !== 'stop' || generation.generationTokens !== generation.tokenIds.length ||
      (last !== 248044 && last !== 248046) || generation.tokenIds.slice(0, -1).some(token => token === 248044 || token === 248046)) {
    throw new Error('research_ovis_incomplete_output');
  }
  if (sha256(rawBytes) !== envelope.rawSha256) throw new Error('research_ovis_raw_changed');
  const raw = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(rawBytes);
  const blocks = parseDocument(raw).map((block, rawIndex): OvisPageBlock => {
    // The official prompt uses [0,1000); never divide by999 or clip the prediction.
    const [left, top, right, bottom] = block.bbox;
    const bbox: Box = [left * frame.width / 1000, top * frame.height / 1000,
      right * frame.width / 1000, bottom * frame.height / 1000];
    return {id: `page-${frame.page}-ovis-${rawIndex + 1}`, rawIndex, category: block.category, kind: kind(block.category),
      rawContent: block.content, candidateRegion: {normalizedBox: block.bbox, bbox, coordinateOrigin: 'TOPLEFT',
        pdfBox: frame.kind === 'pdf' ? projectParsedRegionToPdf({frame, bbox, coordinateOrigin: 'TOPLEFT'}) : null},
      verification: 'unverified', citationLocations: [{page: frame.page, bbox: null, coordinateOrigin: null}]};
  });
  const ordered = orderPdfBlocks(blocks.map(block => ({...block, bbox: block.candidateRegion.bbox})), frame.width);
  return {protocolVersion: 1, sourceHash: binding.sourceHash, inputImageSha256: binding.inputImageSha256,
    frame, model: envelope.model, raw, rawSha256: envelope.rawSha256, generation,
    blocks: ordered.blocks.map(({bbox: _bbox, ...block}) => block),
    warnings: [...ordered.warnings, ...(blocks.length ? ['research_ovis_content_unverified'] : [])]};
}
