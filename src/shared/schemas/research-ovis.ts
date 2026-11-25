import {z} from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
/** Identity comes from a verified installation lease, never from model-generated text. */
export const ovisModelIdentitySchema = z.object({
  engine: z.literal('ovisocr3-mlx'), revision: z.literal('5b252386ba615bd464a5a26597560eaba87dae5c'),
  quantization: z.literal('8bit'), groupSize: z.literal(64), visionPrecision: z.literal('bfloat16'),
  device: z.literal('metal'), installationReceiptSha256: hash, inferenceSha256: hash,
  promptSha256: z.literal('1b6139ec72888e087c8af75f2e2dfb78b425e15ae1c1529940b96137613d1db1')
}).strict();
export type OvisModelIdentity = z.infer<typeof ovisModelIdentitySchema>;

export const ovisParserVersion = 'roc-ovis-parser/1' as const;
export const ovisRuntime = {python: '3.14.10', mlx: '0.32.5', 'mlx-vlm': '0.8.1'} as const;
export const ovisRuntimeSchema = z.object({
  python: z.literal(ovisRuntime.python), mlx: z.literal(ovisRuntime.mlx), 'mlx-vlm': z.literal(ovisRuntime['mlx-vlm'])
}).strict();
