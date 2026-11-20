import {z} from 'zod';

const id = z.string().min(1).max(200);
const project = {projectId: id};
export const readingScopeSchema = z.strictObject(project);
export const readingNoteSchema = z.strictObject({
  id, ...project, itemId: id.nullable(), title: z.string().trim().min(1).max(200), markdown: z.string().max(1_000_000),
  links: z.array(z.string()), revision: z.number().int().positive(), archived: z.boolean(), createdAt: z.string(), updatedAt: z.string()
});
export const readingNotesSchema = z.array(readingNoteSchema);
export const readingNoteSaveSchema = readingNoteSchema.omit({links: true, revision: true, createdAt: true, updatedAt: true})
  .extend({expectedRevision: z.number().int().nonnegative()});
export const readingNoteExportSchema = z.strictObject({...project, noteId: id, expectedRevision: z.number().int().positive()});
export const readingExportResultSchema = z.strictObject({path: z.string().nullable()});
export const readingHighlightSchema = z.strictObject({
  id, ...project, documentId: id, sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), page: z.number().int().positive(),
  text: z.string().max(30000), note: z.string().max(10000), color: z.enum(['yellow', 'green', 'blue', 'pink']),
  rects: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]))
    .max(500).refine(rects => rects.every(([x,y,w,h]) => w > 0 && h > 0 && x+w <= 1.001 && y+h <= 1.001)),
  revision: z.number().int().positive(), archived: z.boolean(), createdAt: z.string()
});
export const readingHighlightListSchema = z.strictObject({...project, documentId: id, sourceHash: z.string()});
export const readingHighlightsSchema = z.array(readingHighlightSchema);
export const readingHighlightSaveSchema = readingHighlightSchema.omit({revision: true, createdAt: true})
  .extend({expectedRevision: z.number().int().nonnegative()});
export const radarFeedSchema = z.strictObject({id, ...project, title: z.string().trim().min(1).max(200), url: z.string().url().max(2048),
  pinned: z.boolean(), archived: z.boolean(), revision: z.number().int().positive(), refreshedAt: z.string().nullable(), error: z.string().nullable()});
export const radarFeedsSchema = z.array(radarFeedSchema);
export const radarFeedSaveSchema = radarFeedSchema.omit({revision: true, refreshedAt: true, error: true})
  .extend({expectedRevision: z.number().int().nonnegative()});
export const radarArticleSchema = z.strictObject({id, feedId: id, title: z.string(), url: z.string(), summary: z.string(),
  pdfUrl:z.string().url().nullable().optional(), publisher:z.string().nullable().optional(), authors: z.array(z.string()), publishedAt: z.string().nullable(), arxivId: z.string().nullable(), doi: z.string().nullable(),
  read: z.boolean(), importedItemId: id.nullable(), score: z.number().nullable()});
export const radarArticlesSchema = z.array(radarArticleSchema);
export const radarArticlesRequestSchema = z.strictObject({...project, feedId: id.nullable(), unread: z.boolean()});
export const radarRefreshSchema = z.strictObject({...project, feedId: id});
export const radarArticleMarkSchema = z.strictObject({...project, articleId: id, read: z.boolean()});
export const radarImportSchema = z.strictObject({...project, articleId: id});
export const radarImportResultSchema = z.strictObject({itemId: id});
export const radarRecommendSchema = z.strictObject({...project,
  categories: z.array(z.string().regex(/^[a-z-]+(?:\.[A-Z]{2})?$/u)).min(1).max(8), force: z.boolean()});
export const radarRecommendationsSchema = z.strictObject({date: z.string(), cached: z.boolean(), corpusSize: z.number().int(),
  articles: radarArticlesSchema, configId: id});
export const translationSettingsSchema = z.strictObject({provider: z.enum(['google', 'openai', 'deepl', 'azure', 'googleCloud', 'tencent']), baseUrl: z.string().url(),
  model: z.string().max(200), region:z.string().max(100).default(''), target: z.string().min(2).max(40), keyConfigured: z.boolean()});
export const translationSettingsSaveSchema = translationSettingsSchema.omit({keyConfigured: true})
  .extend({apiKey: z.string().max(10000).nullable()});
export const readingTranslateSchema = z.strictObject({...project, text: z.string().trim().min(1).max(250000), target: z.string().min(2).max(40)});
export const readingTranslationSchema = z.strictObject({text: z.string(), provider: z.string(), target: z.string()});
export const readingEmptySchema = z.strictObject({});
export type ReadingNote = z.infer<typeof readingNoteSchema>;
export type ReadingHighlight = z.infer<typeof readingHighlightSchema>;
export type RadarFeed = z.infer<typeof radarFeedSchema>;
export type RadarArticle = z.infer<typeof radarArticleSchema>;
export const radarBrowserRequestSchema = z.strictObject({
  action:z.enum(['open','bounds','hide','back','reload','inspect']), source:z.enum(['cool','modelscope']),
  bounds:z.strictObject({x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),width:z.number().int().nonnegative(),height:z.number().int().nonnegative()})
});
export const radarBrowserPaperSchema = z.strictObject({title:z.string().max(2000),url:z.string().url().max(2048),
  arxivId:z.string().nullable(),doi:z.string().nullable()});
export const radarBrowserResultSchema = z.strictObject({url:z.string(),papers:z.array(radarBrowserPaperSchema).max(100)});
export const readingDiscoveryRequestSchema=z.strictObject({...project,itemId:id,direction:z.enum(['references','citations']),offset:z.number().int().min(0).max(9900),force:z.boolean()});
export const readingDiscoveryResultSchema=z.strictObject({articles:radarArticlesSchema,source:z.string(),fetchedAt:z.string(),cached:z.boolean(),nextOffset:z.number().int().nonnegative().nullable(),warnings:z.array(z.string())});
export const radarCapturePageSchema=z.strictObject({...project,url:z.string().url().max(2048)});
