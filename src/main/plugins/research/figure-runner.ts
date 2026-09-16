import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import figureRenderer from '../../../../resources/research-runtime/figure.py?raw';
import type { ResearchExperimentExecution } from '../../../shared/schemas/research-experiments';
import { researchFigureOutputCheckSchema, researchFigureValidationSchema, type ResearchFigureOptions } from '../../../shared/schemas/research-plotting';
import { inspectFigureOutput } from './figure-validation';
import { experimentFileLimit } from './experiment-files';
import type { PreparedExperimentEnvironment } from './experiment-environment';
import { ResearchProcessError } from './process-runner';
import { readResearchFile, researchContentHash } from './research-files';

export const figureRendererPath = '.roc/figure.py';
export const figureValidationPath = 'figure-validation.json';
export { figureRenderer };

export async function validateFigureOutput(
  output: string,
  options: ResearchFigureOptions,
  signal: AbortSignal
): Promise<void> {
  let report;
  try {
    const value = await inspectFigureOutput(output, options, signal);
    report = researchFigureValidationSchema.parse({
      ...researchFigureOutputCheckSchema.parse(value),
      rendererHash: researchContentHash(figureRenderer),
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

export function figureGeneratedInputs(): Record<string, string> {
  return { [figureRendererPath]: figureRenderer };
}

export function assertFigureEnvironment(packages: Array<{ name: string }>): void {
  if (!packages.some((entry) => entry.name.toLowerCase() === 'matplotlib')) throw new Error('research_figure_matplotlib_required');
}

export function figureProcessCommand(
  run: ResearchExperimentExecution,
  prepared: PreparedExperimentEnvironment,
  input: string,
  output: string
): { command: string; args: string[]; environment: Record<string, string> } {
  if (run.request.engine !== 'matplotlib' || run.request.figure === undefined) throw new Error('research_figure_options_invalid');
  const executable = prepared.snapshot.executable;
  return {
    command: executable,
    args: ['-B', '-s', join(input, figureRendererPath), 'render', join(input, run.request.sourcePath), output, JSON.stringify(run.request.figure), ...run.request.arguments],
    environment: { SOURCE_DATE_EPOCH: '0', PYTHONHASHSEED: '0' }
  };
}

export async function finishFigureOutput(
  run: ResearchExperimentExecution,
  output: string,
  signal: AbortSignal
): Promise<void> {
  if (run.request.figure === undefined) throw new Error('research_figure_options_invalid');
  await validateFigureOutput(output, run.request.figure, signal);
}
