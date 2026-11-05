import { z } from 'zod';

export const notebookLimits = {
  bytes: 8 * 1024 * 1024, depth: 32, nodes: 100000, cells: 500,
  sourceBytes: 256 * 1024, outputsPerCell: 100, outputBytes: 2 * 1024 * 1024,
  previewCharacters: 8000, reviewIssuesPerCell: 100
} as const;

const json = z.json();
const object = z.record(z.string(), json);
const multiline = z.union([z.string(), z.array(z.string())]);
const count = z.number().int().nonnegative().nullable();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const tags = z.array(z.string().regex(/^[^,]+$/u)).refine(value => new Set(value).size === value.length);
const cellMetadata = z.object({
  name: z.string().min(1).optional(), tags: tags.optional(), jupyter: object.optional()
}).catchall(json);
const mimeBundle = z.record(z.string(), json).superRefine((value, context) => {
  for (const [mime, data] of Object.entries(value)) {
    if (!/^application\/(.*\+)?json$/u.test(mime) && !multiline.safeParse(data).success) {
      context.addIssue({ code: 'custom', path: [mime], message: 'Notebook MIME data must be a string or string array.' });
    }
  }
});
const outputSchema = z.discriminatedUnion('output_type', [
  z.object({ output_type: z.literal('stream'), name: z.string(), text: multiline }).strict(),
  z.object({ output_type: z.literal('display_data'), data: mimeBundle, metadata: object }).strict(),
  z.object({ output_type: z.literal('execute_result'), data: mimeBundle, metadata: object, execution_count: count }).strict(),
  z.object({ output_type: z.literal('error'), ename: z.string(), evalue: z.string(), traceback: z.array(z.string()) }).strict()
]);
const common = { id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u), source: multiline };
const cellSchema = z.discriminatedUnion('cell_type', [
  z.object({ ...common, cell_type: z.literal('code'), execution_count: count,
    metadata: cellMetadata.extend({
      collapsed: z.boolean().optional(), scrolled: z.union([z.boolean(), z.literal('auto')]).optional(),
      execution: z.record(z.string(), z.string()).optional()
    }), outputs: outputSchema.array().max(notebookLimits.outputsPerCell) }).strict(),
  z.object({ ...common, cell_type: z.literal('markdown'), metadata: cellMetadata,
    attachments: z.record(z.string(), mimeBundle).optional() }).strict(),
  z.object({ ...common, cell_type: z.literal('raw'),
    metadata: cellMetadata.extend({ format: z.string().optional() }),
    attachments: z.record(z.string(), mimeBundle).optional() }).strict()
]);

// A fixed supported version, with no legacy conversion or future-version fallback.
export const researchNotebookSchema = z.object({
  nbformat: z.literal(4), nbformat_minor: z.literal(5),
  metadata: z.object({
    kernelspec: z.object({ name: z.string(), display_name: z.string() }).catchall(json).optional(),
    language_info: z.object({
      name: z.string(), codemirror_mode: z.union([z.string(), object]).optional(),
      file_extension: z.string().optional(), mimetype: z.string().optional(), pygments_lexer: z.string().optional()
    }).catchall(json).optional(),
    orig_nbformat: z.number().int().positive().optional(), title: z.string().optional(),
    authors: z.array(z.object({ name: z.string().optional() }).catchall(json)).optional()
  }).catchall(json),
  cells: cellSchema.array().max(notebookLimits.cells)
}).strict();

export const researchNotebookReviewIssueSchema = z.object({
  kind: z.enum(['magic', 'shell', 'external_path', 'extension', 'rich_output']),
  line: z.number().int().positive().nullable(), detail: z.string()
}).strict();
export const researchNotebookPreviewCellSchema = z.object({
  id: common.id, index: z.number().int().nonnegative(), cellType: z.enum(['code', 'markdown', 'raw']),
  sourceHash: digest, cellHash: digest, source: z.string().max(notebookLimits.previewCharacters),
  sourceCharacters: z.number().int().nonnegative(), executionCount: count,
  outputs: z.array(z.object({
    index: z.number().int().nonnegative(), kind: z.enum(['stream', 'display_data', 'execute_result', 'error']),
    mimeTypes: z.string().array(), text: z.string().max(notebookLimits.previewCharacters),
    textCharacters: z.number().int().nonnegative(), hash: digest, trust: z.literal('untrusted')
  }).strict()),
  attachments: z.array(z.object({ name: z.string(), hash: digest, mimeTypes: z.string().array() }).strict()),
  reviewIssues: researchNotebookReviewIssueSchema.array().max(notebookLimits.reviewIssuesPerCell)
}).strict();
export const researchNotebookPreviewSchema = z.object({
  schemaVersion: z.literal(1), format: z.literal('nbformat-4.5'), sha256: digest,
  size: z.number().int().nonnegative().max(notebookLimits.bytes),
  language: z.string().nullable(), kernel: z.string().nullable(),
  execution: z.literal('static'), outputTrust: z.literal('untrusted'),
  cells: researchNotebookPreviewCellSchema.array().max(notebookLimits.cells)
}).strict();

export type ResearchNotebook = z.infer<typeof researchNotebookSchema>;
export type ResearchNotebookCell = ResearchNotebook['cells'][number];
export type ResearchNotebookPreview = z.infer<typeof researchNotebookPreviewSchema>;
export type ResearchNotebookReviewIssue = z.infer<typeof researchNotebookReviewIssueSchema>;

const identifier = z.string().trim().min(1).max(300);
const notebookPath = z.string().min(1).max(4096).regex(/\.ipynb$/iu);
export const researchNotebookFileRequestSchema = z.strictObject({ projectId: identifier, path: notebookPath });
export const researchNotebookImportRequestSchema = researchNotebookFileRequestSchema.extend({
  requestId: identifier, expectedSha256: digest
});
export const researchNotebookGetRequestSchema = z.strictObject({
  projectId: identifier, notebookId: identifier, expectedHash: digest
});
export const researchNotebookListRequestSchema = z.strictObject({
  projectId: identifier, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100)
});
export const researchNotebookSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), id: identifier, request: researchNotebookImportRequestSchema,
  actor: z.strictObject({ kind: z.literal('user'), id: z.string().regex(/^window:[1-9][0-9]*$/u) }),
  workspacePath: z.string().startsWith('/'), sha256: digest,
  size: z.number().int().nonnegative().max(notebookLimits.bytes), recordedAt: z.iso.datetime()
});
export const researchNotebookReceiptSchema = z.strictObject({
  snapshot: researchNotebookSnapshotSchema, snapshotHash: digest
});
export const researchNotebookImportedSchema = z.strictObject({
  receipt: researchNotebookReceiptSchema, preview: researchNotebookPreviewSchema
});
export const researchNotebookListResultSchema = z.strictObject({
  items: researchNotebookReceiptSchema.array().max(100), total: z.number().int().nonnegative()
});
export type ResearchNotebookFileRequest = z.infer<typeof researchNotebookFileRequestSchema>;
export type ResearchNotebookImportRequest = z.infer<typeof researchNotebookImportRequestSchema>;
export type ResearchNotebookGetRequest = z.infer<typeof researchNotebookGetRequestSchema>;
export type ResearchNotebookListRequest = z.infer<typeof researchNotebookListRequestSchema>;
export type ResearchNotebookReceipt = z.infer<typeof researchNotebookReceiptSchema>;
export type ResearchNotebookImported = z.infer<typeof researchNotebookImportedSchema>;
