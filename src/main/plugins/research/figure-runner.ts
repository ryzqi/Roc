import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import figureRenderer from '../../../../resources/research-runtime/figure.py?raw';
import { researchFigureOutputCheckSchema, researchFigureValidationSchema, type ResearchFigureOptions } from '../../../shared/schemas/research-plotting';
import type { PreparedExperimentEnvironment } from './experiment-environment';
import { experimentFileLimit } from './experiment-files';
import { ResearchProcessError, type ResearchProcessRequest, type ResearchProcessResult } from './process-runner';
import { readResearchFile, researchContentHash } from './research-files';

export const figureRendererPath = '.roc/figure.py';
export const figureValidationPath = 'figure-validation.json';
export { figureRenderer };

export async function validateFigureOutput(prepared: PreparedExperimentEnvironment, options: ResearchFigureOptions,
  output: string, scratch: string, signal: AbortSignal, run: (input: ResearchProcessRequest) => Promise<ResearchProcessResult>): Promise<void> {
  // 固定内置解释器的新进程不加载绘图脚本，避免脚本修改验证器所用的模块。
  const result = await run({ command: prepared.python, args: ['-I', '-B', '-c', figureRenderer, 'verify', '', output, JSON.stringify(options)],
    cwd: scratch, readablePaths: [...prepared.readablePaths, output], writablePaths: [scratch], environment: prepared.environment,
    timeoutMs: 60_000, signal, allowOcrAcceleration: false, allowPosixSpawn: false, networkAccess: 'none' });
  if (result.exitCode !== 0) throw new ResearchProcessError('research_figure_validation_failed', '', result.stderr);
  let value: unknown;
  try { value = JSON.parse(result.stdout); }
  catch { throw new ResearchProcessError('research_figure_validation_invalid', '', result.stderr); }
  const report = researchFigureValidationSchema.parse({ ...researchFigureOutputCheckSchema.parse(value),
    rendererHash: researchContentHash(figureRenderer), options });
  for (const file of report.files) {
    const bytes = await readResearchFile(output, file.path, experimentFileLimit);
    if (bytes.length !== file.size || researchContentHash(bytes) !== file.sha256) throw new Error('research_figure_output_changed');
  }
  signal.throwIfAborted();
  await writeFile(join(output, figureValidationPath), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o400 });
}
