import { pathToFileURL } from 'node:url';
import { extractResearchTemplate } from './template-archive';
import { normalizeResearchBibliography, readResearchBibliography, writeResearchBibliography } from './bibliography';
import { renderResearchPdf } from './pdf-render';
import { ResearchProcessError } from './process-runner';
import type { BibliographyFormat } from './bibliography';

type JobRequest =
  | { operation: 'extract_template'; projectRoot: string; sourcePath: string; outputDir: string }
  | { operation: 'render_pdf'; projectRoot: string; sourcePath: string; outputDir: string; page: number; scale: number }
  | { operation: 'read_bibliography'; projectRoot: string; sourcePath: string; outputDir: string; format: BibliographyFormat }
  | { operation: 'normalize_bibliography'; projectRoot: string; sourcePath: string; outputDir: string }
  | { operation: 'write_bibliography'; projectRoot: string; sourcePath: string; outputDir: string; format: BibliographyFormat };

async function readRequest(): Promise<JobRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > 16 * 1024 * 1024) {
      throw new ResearchProcessError('research_request_too_large');
    }
    chunks.push(chunk as Buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ResearchProcessError('research_json_invalid');
  }
  if (typeof value !== 'object' || value === null || !('operation' in value) || typeof value.operation !== 'string') {
    throw new ResearchProcessError('research_request_invalid');
  }
  return value as JobRequest;
}

async function execute(request: JobRequest): Promise<unknown> {
  switch (request.operation) {
    case 'extract_template':
      return await extractResearchTemplate(request);
    case 'render_pdf':
      return await renderResearchPdf(request);
    case 'read_bibliography':
      return await readResearchBibliography(request);
    case 'normalize_bibliography':
      return await normalizeResearchBibliography(request);
    case 'write_bibliography':
      return await writeResearchBibliography(request);
    default:
      throw new ResearchProcessError('research_operation_unknown');
  }
}

export async function runResearchJobCli(): Promise<number> {
  try {
    const result = await execute(await readRequest());
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof ResearchProcessError ? error.code
      : error instanceof Error && error.message.startsWith('research_') ? error.message
        : 'research_runtime_failed';
    process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code, type: error instanceof Error ? error.constructor.name : 'Error' } })}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runResearchJobCli();
}
