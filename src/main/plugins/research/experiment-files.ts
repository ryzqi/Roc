import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { ResearchExperimentEnvironment, ResearchExperimentFile, ResearchExperimentStart } from '../../../shared/schemas/research-experiments';
import { createResearchDirectory, readResearchFile, researchContentHash, researchRelativePath } from './research-files';

export const experimentFileLimit = 64 * 1024 * 1024;
const experimentTotalLimit = 256 * 1024 * 1024;

export async function experimentStorage(path: string | null): Promise<string> {
  if (path === null || !isAbsolute(path)) throw new Error('research_experiment_storage_unavailable');
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink()) throw new Error('research_experiment_storage_symlink');
  return await realpath(path);
}

export async function snapshotExperimentInputs(workspace: string, target: string, request: ResearchExperimentStart,
  environment: ResearchExperimentEnvironment, signal: AbortSignal, generatedInputs: Record<string, string> = {}): Promise<{ files: ResearchExperimentFile[]; hash: string }> {
  const paths = [...new Set([request.sourcePath, ...request.inputPaths, ...environment.lockFiles.map((file) => file.path)])].sort();
  if (Object.keys(generatedInputs).some((path) => paths.includes(path))) throw new Error('research_experiment_reserved_input');
  const files: ResearchExperimentFile[] = [];
  let total = 0;
  for (const path of paths) {
    signal.throwIfAborted();
    const bytes = await readResearchFile(workspace, path, experimentFileLimit);
    total += bytes.length;
    if (total > experimentTotalLimit) throw new Error('research_experiment_input_limit');
    const parent = dirname(path);
    if (parent !== '.') await createResearchDirectory(target, parent);
    await writeFile(join(target, path), bytes, { flag: 'wx', mode: 0o400 });
    files.push({ area: 'input', path, size: bytes.length, sha256: researchContentHash(bytes) });
  }
  for (const file of files) {
    signal.throwIfAborted();
    if (researchContentHash(await readResearchFile(workspace, file.path, experimentFileLimit)) !== file.sha256) throw new Error('research_experiment_input_changed');
    const lock = environment.lockFiles.find((entry) => entry.path === file.path);
    if (lock !== undefined && lock.sha256 !== file.sha256) throw new Error('research_experiment_environment_changed');
  }
  for (const [path, content] of Object.entries(generatedInputs).sort(([left], [right]) => left.localeCompare(right))) {
    signal.throwIfAborted();
    researchRelativePath(path);
    const bytes = Buffer.from(content, 'utf8');
    total += bytes.length;
    if (bytes.length > experimentFileLimit || total > experimentTotalLimit) throw new Error('research_experiment_input_limit');
    const parent = dirname(path);
    if (parent !== '.') await createResearchDirectory(target, parent);
    await writeFile(join(target, path), bytes, { flag: 'wx', mode: 0o400 });
    files.push({ area: 'input', path, size: bytes.length, sha256: researchContentHash(bytes) });
  }
  return { files, hash: researchContentHash(JSON.stringify({ engine: request.engine, source: request.sourcePath, files,
    arguments: request.arguments, parameters: Object.entries(request.parameters).sort(([left], [right]) => left.localeCompare(right)), environment: environment.hash, network: request.network,
    ...(request.figure === undefined ? {} : { figure: request.figure }) })) };
}

export async function collectExperimentFiles(root: string, area: ResearchExperimentFile['area']): Promise<ResearchExperimentFile[]> {
  const files: ResearchExperimentFile[] = [];
  let total = 0;
  let entries = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 2000) throw new Error('research_experiment_output_limit');
      const path = researchRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      if (entry.isDirectory()) await visit(join(directory, entry.name), path);
      else {
        if (!entry.isFile() || files.length >= 1000) throw new Error('research_experiment_output_invalid');
        const bytes = await readResearchFile(root, path, experimentFileLimit);
        total += bytes.length;
        if (total > experimentTotalLimit) throw new Error('research_experiment_output_limit');
        files.push({ area, path, size: bytes.length, sha256: researchContentHash(bytes) });
      }
    }
  }
  await visit(root, '');
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
