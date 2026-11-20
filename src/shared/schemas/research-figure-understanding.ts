import {z} from 'zod';
import {visualAssetSchema, visualSelectionSchema} from './research-visual-retrieval';
import {scientificExtractionConfigSchema} from './research-scientific-extraction';

const id = z.string().min(1).max(2048);
const label = z.string().trim().min(1).max(500);
const description = z.string().trim().min(1).max(2000);
const panelId = label.nullable();
export const figureUnderstandingVersion = 'roc-figure-understanding/1';
export const figureUnderstandingRequestSchema = visualSelectionSchema.extend({projectId: id});

/** Provider output contains interpretations only. Source identities and approval state are server-owned. */
export const figureInterpretationProposalSchema = z.strictObject({
  panels: z.array(z.strictObject({id: label, label, description})).max(16),
  modules: z.array(z.strictObject({id: label, panelId, label, role: description})).max(64),
  connections: z.array(z.strictObject({from: label, to: label,
    direction: z.enum(['directed', 'undirected', 'uncertain']), description})).max(128),
  lineTrends: z.array(z.strictObject({panelId, series: label,
    direction: z.enum(['increasing', 'decreasing', 'stable', 'nonmonotonic', 'uncertain']), description})).max(32),
  barComparisons: z.array(z.strictObject({panelId, firstCategory: label, secondCategory: label,
    relation: z.enum(['higher', 'lower', 'similar', 'uncertain']), description})).max(32),
  legends: z.array(z.strictObject({panelId, label, visualEncoding: description})).max(64),
  axes: z.array(z.strictObject({panelId, orientation: z.enum(['x', 'y', 'other']), label,
    scale: z.enum(['linear', 'logarithmic', 'unknown'])})).max(32),
  limitations: z.array(description).max(32)
});
export const figureInterpretationSchema = figureInterpretationProposalSchema.superRefine((value, context) => {
  const panels = new Set(value.panels.map(p => p.id)), modules = new Set(value.modules.map(m => m.id));
  if (panels.size !== value.panels.length || modules.size !== value.modules.length) {
    context.addIssue({code: 'custom', message: 'research_figure_duplicate_id'});
  }
  for (const item of [...value.modules, ...value.lineTrends, ...value.barComparisons, ...value.legends, ...value.axes]) {
    if (item.panelId !== null && !panels.has(item.panelId)) {
      context.addIssue({code: 'custom', message: 'research_figure_panel_reference_invalid'});
    }
  }
  for (const connection of value.connections) {
    if (!modules.has(connection.from) || !modules.has(connection.to)) {
      context.addIssue({code: 'custom', message: 'research_figure_module_reference_invalid'});
    }
  }
});
export const figureUnderstandingResultSchema = z.strictObject({
  version: z.literal(figureUnderstandingVersion), projectId: id,
  source: visualAssetSchema.extend({kind: z.literal('figure')}),
  model: scientificExtractionConfigSchema.shape.model,
  promptVersion: id, createdAt: z.iso.datetime(),
  interpretationKind: z.literal('derived'), scientificApproval: z.literal('unreviewed'),
  verification: z.literal('verify_original_pdf'), exactValues: z.literal('requires_table_or_text'),
  interpretation: figureInterpretationSchema
});
export type FigureUnderstandingRequest = z.infer<typeof figureUnderstandingRequestSchema>;
export type FigureUnderstandingResult = z.infer<typeof figureUnderstandingResultSchema>;
export type FigureInterpretation = z.infer<typeof figureInterpretationSchema>;
