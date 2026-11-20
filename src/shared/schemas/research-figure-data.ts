import {z} from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const name = z.string().min(1).max(512);
export const researchFigureDataPath = 'figure-data.json';
export const researchFigureDataFileSchema = z.strictObject({
  path: z.literal(researchFigureDataPath), size: z.number().int().positive(), sha256: hash
});
export const researchFigureDataItemSchema = z.strictObject({
  scenePath: z.number().int().nonnegative().array().min(1).max(128),
  numericFields: z.record(name, z.number()), unavailableFields: name.array().max(1000),
  opacity: z.number().nullable()
});
export const researchFigureDataMarkSchema = z.strictObject({
    name, markType: name, encoding: z.string().min(1).max(1024 * 1024),
    directFields: z.record(name, name), constantChannels: name.array().max(1000), unsupportedChannels: name.array().max(1000),
    items: researchFigureDataItemSchema.array().max(100_000)
});
export const researchFigureDataTraceSchema = z.strictObject({
  schemaVersion: z.literal(1), sourceHash: hash, rendererHash: hash, compiledSpecHash: hash,
  marks: researchFigureDataMarkSchema.array().max(1000)
});
export type ResearchFigureDataTrace = z.infer<typeof researchFigureDataTraceSchema>;
