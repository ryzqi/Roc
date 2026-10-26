import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { researchFigureOutputCheckSchema, researchFigureValidationSchema, type ResearchFigureOptions } from '../../../shared/schemas/research-plotting';
import { inspectFigureOutput } from './figure-validation';
import { experimentFileLimit } from './experiment-files';
import { ResearchProcessError } from './process-runner';
import { readResearchFile, researchContentHash } from './research-files';

export const figureValidationPath = 'figure-validation.json';

export async function validateFigureOutput(
  output: string,
  options: ResearchFigureOptions,
  rendererHash: string,
  signal: AbortSignal
): Promise<void> {
  let report;
  try {
    const value = await inspectFigureOutput(output, options, signal);
    report = researchFigureValidationSchema.parse({
      ...researchFigureOutputCheckSchema.parse(value),
      rendererHash,
      options
    });
  } catch (error) {
    if (signal.aborted || (error instanceof Error && (error.name === 'AbortError' || error.message === 'research_process_cancelled'))) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : 'research_figure_validation_invalid';
    throw new ResearchProcessError('research_figure_validation_failed', '', detail);
  }
  for (const file of report.files) {
    const bytes = await readResearchFile(output, file.path, experimentFileLimit);
    if (bytes.length !== file.size || researchContentHash(bytes) !== file.sha256) throw new Error('research_figure_output_changed');
  }
  signal.throwIfAborted();
  await writeFile(join(output, figureValidationPath), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o400 });
}

export async function finishFigureOutput(
  output: string,
  options: ResearchFigureOptions,
  rendererHash: string,
  signal: AbortSignal
): Promise<void> {
  await validateFigureOutput(output, options, rendererHash, signal);
}
