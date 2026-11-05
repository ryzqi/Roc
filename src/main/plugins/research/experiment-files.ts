import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { notebookExperimentPaths, researchPythonSourcePath,
  type ResearchExperimentEnvironment, type ResearchExperimentFile, type ResearchExperimentStart } from '../../../shared/schemas/research-experiments';
import type { ResearchFigureRendererEnvironment, ResearchFigureStart } from '../../../shared/schemas/research-figures';
import { createResearchDirectory, readResearchFile, researchContentHash, researchRelativePath } from './research-files';

type SnapshotEnvironment = Pick<ResearchExperimentEnvironment, 'hash' | 'lockFiles'> | ResearchFigureRendererEnvironment;
type SnapshotRequest = ResearchExperimentStart | ResearchFigureStart;

export const experimentFileLimit = 64 * 1024 * 1024;
export const experimentInputTotalLimit = 256 * 1024 * 1024;
export const experimentOutputTotalLimit = 128 * 1024 * 1024;
export const experimentCsvRowLimit = 100_000;
export const experimentRunnerRequestLimit = 4 * 1024 * 1024;
export const experimentFileCountLimit = 1000;
export const experimentDirectoryEntryLimit = 2000;

export async function experimentStorage(path: string | null): Promise<string> {
  if (path === null || !isAbsolute(path)) throw new Error('research_experiment_storage_unavailable');
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink()) throw new Error('research_experiment_storage_symlink');
  return await realpath(path);
}

export async function snapshotExperimentInputs(workspace: string, target: string, request: SnapshotRequest,
  environment: SnapshotEnvironment, signal: AbortSignal, generatedInputs: Record<string, Buffer>): Promise<{ files: ResearchExperimentFile[]; hash: string }> {
  const lockFiles = 'lockFiles' in environment ? environment.lockFiles : [];
  const notebook = request.engine === 'python' && request.source.kind === 'notebook';
  const sourcePath = request.engine === 'python' ? researchPythonSourcePath(request.source) : request.sourcePath;
  const generatedPaths = Object.keys(generatedInputs);
  const requiredGenerated = notebook ? Object.values(notebookExperimentPaths) : [];
  if (generatedPaths.length !== requiredGenerated.length || requiredGenerated.some(path => !generatedPaths.includes(path))) {
    throw new Error('research_experiment_generated_source_required');
  }
  const workspacePaths = [...new Set([...(notebook ? [] : [sourcePath]), ...request.inputPaths, ...lockFiles.map((file) => file.path)])];
  if (workspacePaths.some(path => generatedPaths.includes(path))) throw new Error('research_experiment_reserved_input');
  const paths = [...workspacePaths, ...generatedPaths]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const files: ResearchExperimentFile[] = [];
  let total = 0;
  for (const path of paths) {
    signal.throwIfAborted();
    const bytes = generatedPaths.includes(path) ? generatedInputs[path]! : await readResearchFile(workspace, path, experimentFileLimit);
    total += bytes.length;
    if (bytes.length > experimentFileLimit || total > experimentInputTotalLimit) throw new Error('research_experiment_input_limit');
    const parent = dirname(path);
    if (parent !== '.') await createResearchDirectory(target, parent);
    await writeFile(join(target, path), bytes, { flag: 'wx', mode: 0o400 });
    files.push({ area: 'input', path, size: bytes.length, sha256: researchContentHash(bytes) });
  }
  for (const file of files) {
    if (generatedPaths.includes(file.path)) continue;
    signal.throwIfAborted();
    if (researchContentHash(await readResearchFile(workspace, file.path, experimentFileLimit)) !== file.sha256) throw new Error('research_experiment_input_changed');
    const lock = lockFiles.find((entry) => entry.path === file.path);
    if (lock !== undefined && lock.sha256 !== file.sha256) throw new Error('research_experiment_environment_changed');
  }
  const identity = (() => {
    switch (request.engine) {
      case 'vega-lite': return { kind: 'figure' as const, engine: request.engine, sourceVersion: request.sourceVersion, figure: request.figure };
      case 'typescript': return { kind: 'experiment' as const, engine: request.engine, sourceVersion: request.sourceVersion, network: request.network };
      case 'python': return { kind: 'experiment' as const, engine: request.engine, sourceVersion: request.sourceVersion, seed: request.seed, network: request.network };
      case 'r':
      case 'julia': return { kind: 'experiment' as const, engine: request.engine, network: request.network };
      default: throw new Error('research_experiment_engine_unsupported');
    }
  })();
  const argumentsList = 'arguments' in request ? request.arguments : [];
  const parameters = 'parameters' in request ? Object.entries(request.parameters).sort(([left], [right]) => left.localeCompare(right)) : [];
  return { files, hash: researchContentHash(JSON.stringify({ ...identity, source: request.engine === 'python' ? request.source : sourcePath, files,
    arguments: argumentsList, parameters, environment: environment.hash })) };
}

export async function collectExperimentFiles(root: string, area: ResearchExperimentFile['area']): Promise<ResearchExperimentFile[]> {
  const files: ResearchExperimentFile[] = [];
  let total = 0;
  let entries = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > experimentDirectoryEntryLimit) throw new Error('research_experiment_output_limit');
      const path = researchRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      if (entry.isDirectory()) await visit(join(directory, entry.name), path);
      else {
        if (!entry.isFile() || files.length >= experimentFileCountLimit) throw new Error('research_experiment_output_invalid');
        const bytes = await readResearchFile(root, path, experimentFileLimit);
        total += bytes.length;
        if (total > (area === 'output' ? experimentOutputTotalLimit : experimentInputTotalLimit)) throw new Error('research_experiment_output_limit');
        files.push({ area, path, size: bytes.length, sha256: researchContentHash(bytes) });
      }
    }
  }
  await visit(root, '');
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
