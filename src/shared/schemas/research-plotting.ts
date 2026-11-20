import { z } from 'zod';

export const researchFigureOptionsSchema = z.object({
  widthInches: z.number().min(1).max(24), heightInches: z.number().min(1).max(24),
  dpi: z.number().int().min(72).max(1200), seed: z.number().int().min(0).max(4294967295)
}).strict().refine((value) => value.widthInches * value.heightInches * value.dpi ** 2 <= 32_000_000,
  { message: 'research_figure_pixel_limit' });

export const researchFigureOutputCheckSchema = z.object({
  widthPixels: z.number().int().positive(), heightPixels: z.number().int().positive(),
  widthPoints: z.number().positive(), heightPoints: z.number().positive(), pageCount: z.literal(1),
  files: z.array(z.object({ path: z.enum(['figure.png', 'figure.svg', 'figure.pdf']),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().positive() }).strict()).length(3)
}).strict().refine((value) => new Set(value.files.map((file) => file.path)).size === 3,
  { message: 'research_figure_formats_required' });

export const researchFigureValidationSchema = researchFigureOutputCheckSchema.safeExtend({
  rendererHash: z.string().regex(/^[a-f0-9]{64}$/u), options: researchFigureOptionsSchema
});

export type ResearchFigureOptions = z.infer<typeof researchFigureOptionsSchema>;
export type ResearchFigureValidation = z.infer<typeof researchFigureValidationSchema>;
