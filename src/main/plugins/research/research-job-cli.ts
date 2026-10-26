import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { extractResearchTemplate } from './template-archive';
import { normalizeResearchBibliography, readResearchBibliography, writeResearchBibliography } from './bibliography';
import { renderResearchPdf } from './pdf-render';
import { ResearchProcessError } from './process-runner';
import type { ResearchModelFiles } from './model-store';
import { researchParseOptionsSchema } from '../../../shared/schemas/research-production';
import { researchFigureRenderJobSchema } from '../../../shared/schemas/research-figures';

const absolutePath = z.string().min(1).max(4096).refine(isAbsolute);
const baseRequest = z.object({
  projectRoot: absolutePath,
  sourcePath: absolutePath,
  outputDir: absolutePath
});
const modelFilesSchema = z.object({
  detection: absolutePath,
  recognition: absolutePath,
  dictionary: absolutePath,
  layout: absolutePath,
  table: absolutePath,
  formula: absolutePath.optional(),
  formulaTokenizer: absolutePath.optional()
}).strict();

const jobRequestSchema = z.discriminatedUnion('operation', [
  baseRequest.extend({ operation: z.literal('extract_template') }).strict(),
  baseRequest.extend({ operation: z.literal('render_pdf'), page: z.number().int().positive(), scale: z.number().min(0.5).max(4) }).strict(),
  baseRequest.extend({ operation: z.literal('read_bibliography'), format: z.enum(['bibtex', 'biblatex', 'csl-json']) }).strict(),
  baseRequest.extend({ operation: z.literal('normalize_bibliography') }).strict(),
  baseRequest.extend({ operation: z.literal('write_bibliography'), format: z.enum(['bibtex', 'biblatex', 'csl-json']) }).strict(),
  baseRequest.extend({
    operation: z.literal('parse_document'),
    options: researchParseOptionsSchema,
    modelFiles: modelFilesSchema.nullable(),
    modelManifest: z.union([z.string().regex(/^[a-f0-9]{64}$/u), z.literal('')])
  }).strict(),
  researchFigureRenderJobSchema
]);
type JobRequest = z.infer<typeof jobRequestSchema>;

async function readRequest(): Promise<JobRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > 16 * 1024 * 1024) throw new ResearchProcessError('research_request_too_large');
    chunks.push(chunk as Buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ResearchProcessError('research_json_invalid');
  }
  const request = jobRequestSchema.safeParse(value);
  if (!request.success) throw new ResearchProcessError('research_request_invalid');
  return request.data;
}

async function execute(request: JobRequest, signal: AbortSignal): Promise<unknown> {
  switch (request.operation) {
    case 'extract_template':
      return await extractResearchTemplate({ ...request, signal });
    case 'render_pdf':
      return await renderResearchPdf({ ...request, signal });
    case 'read_bibliography':
      return await readResearchBibliography({ ...request, signal });
    case 'normalize_bibliography':
      return await normalizeResearchBibliography({ ...request, signal });
    case 'write_bibliography':
      return await writeResearchBibliography({ ...request, signal });
    case 'parse_document': {
      const { parseResearchDocument } = await import('./document-parser');
      const parserInput: {
        projectRoot: string;
        sourcePath: string;
        outputDir: string;
        options: z.infer<typeof researchParseOptionsSchema>;
        modelFiles: ResearchModelFiles | null;
        modelManifest: string;
        signal: AbortSignal;
        timeoutMs: number;
      } = { ...request, signal, timeoutMs: 600_000 };
      return await parseResearchDocument(parserInput);
    }
    case 'render_figure': {
      const { renderResearchFigure } = await import('./figure-renderer');
      return await renderResearchFigure(request, signal);
    }
    default:
      throw new ResearchProcessError('research_operation_unsupported');
  }
}

export async function runResearchJobCli(): Promise<number> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(new ResearchProcessError('research_cancelled'));
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  try {
    const result = await execute(await readRequest(), controller.signal);
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    return 0;
  } catch (error) {
    let code = 'research_runtime_failed';
    if (error instanceof ResearchProcessError) code = error.code;
    else if (error instanceof Error && error.message.startsWith('research_')) code = error.message;
    process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code, type: error instanceof Error ? error.constructor.name : 'Error' } })}\n`);
    return 1;
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runResearchJobCli();
}
