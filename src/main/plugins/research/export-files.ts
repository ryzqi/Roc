import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import archiveSource from '../../../../resources/research-runtime/export-archive.py?raw';
import type { ResearchExportFile } from '../../../shared/schemas/research-exports';
import { runResearchProcess, ResearchProcessError } from './process-runner';
import { createResearchDirectory, readResearchFile, researchContentHash, researchPath, researchRelativePath } from './research-files';
import type { ResearchToolchain } from './toolchain';

export type ExportToolchain = Pick<ResearchToolchain, 'status' | 'identity' | 'experimentRuntime' | 'writeBibliography' | 'compile' | 'renderPdf'>;

export const exportFileLimit = 64 * 1024 * 1024;
export const exportTotalLimit = 512 * 1024 * 1024;
export const exportArchiveLimit = 600 * 1024 * 1024;
export { archiveSource };

export async function exportStorage(path: string | null): Promise<string> {
  if (path === null || !isAbsolute(path)) throw new Error('research_export_storage_unavailable');
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink()) throw new Error('research_export_storage_symlink');
  return await realpath(path);
}

export class ResearchExportFiles {
  private readonly records: ResearchExportFile[] = [];
  private readonly paths = new Set<string>();
  private total = 0;
  constructor(readonly root: string) {}

  list(): ResearchExportFile[] { return this.records.map((file) => ({ ...file })).sort((left, right) => left.path.localeCompare(right.path)); }

  async write(path: string, content: Buffer | string): Promise<ResearchExportFile> {
    researchRelativePath(path);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const key = path.normalize('NFC').toLowerCase();
    if (this.paths.has(key)) throw new Error('research_export_path_collision');
    if (bytes.length > exportFileLimit || this.total + bytes.length > exportTotalLimit || this.records.length >= 10000) throw new Error('research_export_file_limit');
    if (dirname(path) !== '.') await createResearchDirectory(this.root, dirname(path));
    await writeFile(join(this.root, path), bytes, { flag: 'wx', mode: 0o400 });
    const file = { path, sha256: researchContentHash(bytes), size: bytes.length };
    this.paths.add(key); this.total += bytes.length; this.records.push(file);
    return file;
  }

  async copy(sourceRoot: string, source: ResearchExportFile, destination: string): Promise<ResearchExportFile> {
    const bytes = await readResearchFile(sourceRoot, source.path, exportFileLimit);
    if (bytes.length !== source.size || researchContentHash(bytes) !== source.sha256) throw new Error('research_export_snapshot_changed');
    return await this.write(destination, bytes);
  }
}

export async function hashExportArchive(root: string, entry: ResearchExportFile, signal: AbortSignal): Promise<void> {
  const path = await researchPath(root, entry.path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== entry.size || before.size > exportArchiveLimit) throw new Error('research_export_snapshot_changed');
    const hash = createHash('sha256');
    let size = 0;
    const block = Buffer.alloc(1024 * 1024);
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(block, 0, block.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > entry.size) throw new Error('research_export_snapshot_changed');
      hash.update(block.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (size !== entry.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || hash.digest('hex') !== entry.sha256) throw new Error('research_export_snapshot_changed');
  } finally { await file.close(); }
}

export async function createExportArchive(input: { root: string; bundle: ResearchExportFiles; scratch: string; tools: ExportToolchain; signal: AbortSignal }): Promise<ResearchExportFile> {
  const output = await createResearchDirectory(input.root, 'archive');
  const manifest = join(input.scratch, 'archive-files.json');
  await writeFile(manifest, JSON.stringify(input.bundle.list()), { flag: 'wx', mode: 0o400 });
  const tools = await input.tools.experimentRuntime(input.scratch);
  const path = 'archive/export.zip';
  const result = await runResearchProcess({ command: tools.python, args: ['-I', '-B', '-c', archiveSource, input.bundle.root, join(input.root, path), manifest],
    cwd: input.scratch, readablePaths: [tools.root, input.bundle.root, manifest], writablePaths: [input.scratch, output], environment: tools.environment,
    timeoutMs: 180_000, signal: input.signal, allowOcrAcceleration: false, allowPosixSpawn: false, networkAccess: 'none' });
  if (result.exitCode !== 0) throw new ResearchProcessError('research_export_archive_failed', result.stdout, result.stderr);
  const metadata = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().positive().max(exportArchiveLimit) }).strict().parse(JSON.parse(result.stdout));
  const file = { path, ...metadata };
  await hashExportArchive(input.root, file, input.signal);
  return file;
}
