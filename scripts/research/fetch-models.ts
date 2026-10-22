import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { downloadVerified, fileSha256 } from './download-asset.ts';
import { decodeJson, decodeJsonOrNull } from '../lib/decode-json.ts';

export type ModelSource = {
  repoId: string;
  revision: string;
  directory: string;
  license: string;
  files: Record<string, string>;
};

export type ModelMarker = {
  repoId: string;
  revision: string;
  license: string;
};

type DownloadFn = (url: string, sha256: string, target: string) => Promise<string>;

function fail(code: string): never {
  throw new Error(code);
}

async function pathInfo(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function posixRelative(root: string, target: string): string {
  return relative(root, target).split(sep).join('/');
}

function sameMarker(left: unknown, right: ModelMarker): boolean {
  if (typeof left !== 'object' || left === null) return false;
  const value = left as Record<string, unknown>;
  return Object.keys(value).length === 3
    && value.repoId === right.repoId
    && value.revision === right.revision
    && value.license === right.license;
}

function assertModelFileName(filename: string): void {
  if (isAbsolute(filename) || filename.includes('\\') || filename === 'roc-source.json'
      || filename.split('/').some((part) => part === '' || part === '.' || part === '..' || part === '.cache')) {
    fail('research_model_file_path_invalid');
  }
}

export function huggingfaceResolveUrl(source: ModelSource, filename: string): string {
  const path = filename.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `https://huggingface.co/${source.repoId}/resolve/${source.revision}/${path}`;
}

export function readSources(value: unknown): ModelSource[] {
  if (typeof value !== 'object' || value === null) fail('research_models_lock_invalid');
  const lock = value as { schemaVersion?: unknown; models?: unknown };
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.models) || lock.models.length === 0) {
    fail('research_models_lock_invalid');
  }
  const sources: ModelSource[] = [];
  const directories = new Set<string>();
  for (const item of lock.models) {
    if (typeof item !== 'object' || item === null) fail('research_models_lock_invalid');
    const record = item as Record<string, unknown>;
    if (typeof record.repoId !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(record.repoId)) {
      fail('research_model_repo_invalid');
    }
    if (typeof record.revision !== 'string' || !/^[0-9a-f]{40}$/u.test(record.revision)) {
      fail('research_model_revision_invalid');
    }
    if (typeof record.directory !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(record.directory)) {
      fail('research_model_directory_invalid');
    }
    if (typeof record.license !== 'string' || record.license === '') fail('research_models_lock_invalid');
    if (typeof record.files !== 'object' || record.files === null || Array.isArray(record.files)
        || Object.keys(record.files).length === 0) {
      fail('research_model_files_required');
    }
    const files: Record<string, string> = {};
    for (const [filename, digest] of Object.entries(record.files as Record<string, unknown>)) {
      assertModelFileName(filename);
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest)) fail('research_model_digest_invalid');
      files[filename] = digest;
    }
    if (directories.has(record.directory)) fail('research_model_directory_duplicate');
    directories.add(record.directory);
    sources.push({
      repoId: record.repoId,
      revision: record.revision,
      directory: record.directory,
      license: record.license,
      files
    });
  }
  return sources;
}

export async function verifyFiles(root: string, source: ModelSource): Promise<void> {
  const allowed = new Set([...Object.keys(source.files), 'roc-source.json']);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail('research_model_symlink');
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!entry.isFile()) fail('research_model_symlink');
      const relativePath = posixRelative(root, full);
      if (!allowed.has(relativePath)) fail('research_model_unexpected_file');
    }
  };
  await visit(root);
  for (const [filename, expected] of Object.entries(source.files)) {
    const path = join(root, filename);
    const info = await pathInfo(path);
    if (info === null || info.isSymbolicLink() || !info.isFile() || await fileSha256(path) !== expected) {
      fail(`research_model_hash_mismatch:${source.directory}/${filename}`);
    }
  }
}

async function verifyInstalledModel(root: string, source: ModelSource): Promise<void> {
  if ((await pathInfo(root))?.isSymbolicLink()) fail('research_model_symlink');
  const markerPath = join(root, 'roc-source.json');
  const markerInfo = await pathInfo(markerPath);
  const marker = markerInfo !== null && markerInfo.isFile() && !markerInfo.isSymbolicLink()
    ? decodeJsonOrNull<ModelMarker>(await readFile(markerPath, 'utf8'))
    : null;
  const expectedMarker: ModelMarker = { repoId: source.repoId, revision: source.revision, license: source.license };
  if (!sameMarker(marker, expectedMarker)) fail('research_models_unavailable');
  for (const filename of Object.keys(source.files)) {
    const path = join(root, filename);
    const info = await pathInfo(path);
    if (info === null || info.isSymbolicLink() || !info.isFile() || info.size < 1) fail('research_models_unavailable');
  }
}

export type InstalledModelStatus = {
  directory: string;
  repoId: string;
  ready: boolean;
};

export async function inspectInstalledModels(rootPath: string | null, lock: unknown, options: { verifyHashes?: boolean } = {}): Promise<{
  available: boolean;
  ready: boolean;
  error: string | null;
  models: InstalledModelStatus[];
}> {
  if (rootPath === null || !isAbsolute(rootPath)) {
    return { available: false, ready: false, error: 'research_models_unavailable', models: [] };
  }
  if ((await pathInfo(rootPath))?.isSymbolicLink()) fail('research_model_output_symlink');
  const models: InstalledModelStatus[] = [];
  for (const source of readSources(lock)) {
    const destination = join(rootPath, source.directory);
    const info = await pathInfo(destination);
    if (info === null) {
      models.push({ directory: source.directory, repoId: source.repoId, ready: false });
      continue;
    }
    try {
      if (options.verifyHashes === true) await verifyFiles(destination, source);
      else await verifyInstalledModel(destination, source);
      models.push({ directory: source.directory, repoId: source.repoId, ready: true });
    } catch (error) {
      const code = error instanceof Error ? error.message.split(':', 1)[0] : 'research_models_invalid';
      models.push({ directory: source.directory, repoId: source.repoId, ready: false });
      return { available: true, ready: false, error: code, models };
    }
  }
  const ready = models.length > 0 && models.every((model) => model.ready);
  return {
    available: true,
    ready,
    error: ready ? null : 'research_models_unavailable',
    models
  };
}

const DARWIN_O_EXLOCK = 0x20;

async function withDownloadLock(lockPath: string, work: () => Promise<void>): Promise<void> {
  if ((await pathInfo(lockPath))?.isSymbolicLink()) fail('research_model_download_lock_symlink');
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | DARWIN_O_EXLOCK;
  let handle;
  try {
    handle = await open(lockPath, flags, 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EAGAIN' || (error as NodeJS.ErrnoException).code === 'EWOULDBLOCK') {
      fail('research_model_download_locked');
    }
    throw error;
  }
  try {
    await work();
  } finally {
    await handle.close();
  }
}

async function fetchLocked(
  source: ModelSource,
  output: string,
  downloads: string,
  options: { resolveUrl: (source: ModelSource, filename: string) => string; download: DownloadFn }
): Promise<void> {
  const destination = join(output, source.directory);
  const markerPath = join(destination, 'roc-source.json');
  const expectedMarker: ModelMarker = { repoId: source.repoId, revision: source.revision, license: source.license };
  const destinationInfo = await pathInfo(destination);
  if (destinationInfo !== null) {
    const markerInfo = await pathInfo(markerPath);
    const marker = markerInfo !== null && markerInfo.isFile() && !markerInfo.isSymbolicLink()
      ? decodeJsonOrNull<ModelMarker>(await readFile(markerPath, 'utf8'))
      : null;
    if (destinationInfo.isSymbolicLink() || markerInfo?.isSymbolicLink() || !sameMarker(marker, expectedMarker)) {
      fail(`research_model_existing_directory_conflict:${destination}`);
    }
    await verifyFiles(destination, source);
    console.log(`已校验 ${source.repoId}`);
    return;
  }
  const staging = join(downloads, `${source.directory}-${source.revision}`);
  if ((await pathInfo(staging))?.isSymbolicLink()) fail('research_model_download_staging_symlink');
  await mkdir(staging, { recursive: true });
  console.log(`下载 ${source.repoId}@${source.revision}`);
  for (const [filename, digest] of Object.entries(source.files)) {
    const target = join(staging, filename);
    await mkdir(dirname(target), { recursive: true });
    await options.download(options.resolveUrl(source, filename), digest, target);
    await rm(`${target}.parts`, { recursive: true, force: true });
  }
  const cache = join(staging, '.cache');
  const cacheInfo = await pathInfo(cache);
  if (cacheInfo !== null) {
    if (cacheInfo.isSymbolicLink()) fail('research_model_cache_path_invalid');
    const resolvedCache = await realpath(cache);
    const resolvedStaging = await realpath(staging);
    if (resolvedCache !== resolvedStaging && !resolvedCache.startsWith(`${resolvedStaging}${sep}`)) {
      fail('research_model_cache_path_invalid');
    }
    await rm(cache, { recursive: true, force: true });
  }
  await verifyFiles(staging, source);
  const marker = await open(join(staging, 'roc-source.json'), 'w');
  try {
    await marker.writeFile(`${JSON.stringify(expectedMarker, null, 2)}\n`, 'utf8');
  } finally {
    await marker.close();
  }
  await rename(staging, destination);
  console.log(`已固定 ${source.repoId}`);
}

export async function fetchModel(
  source: ModelSource,
  output: string,
  options: {
    resolveUrl?: (source: ModelSource, filename: string) => string;
    download?: DownloadFn;
  } = {}
): Promise<void> {
  const downloads = join(output, '.downloads');
  if ((await pathInfo(downloads))?.isSymbolicLink()) fail('research_model_download_cache_symlink');
  await mkdir(downloads, { recursive: true });
  await withDownloadLock(join(downloads, `${source.directory}.lock`), () => fetchLocked(source, output, downloads, {
    resolveUrl: options.resolveUrl ?? huggingfaceResolveUrl,
    download: options.download ?? downloadVerified
  }));
}

export async function fetchModels(
  lockPath: string,
  outputPath: string,
  options: {
    resolveUrl?: (source: ModelSource, filename: string) => string;
    download?: DownloadFn;
  } = {}
): Promise<void> {
  if ((await pathInfo(outputPath))?.isSymbolicLink()) fail('research_model_output_symlink');
  const output = resolve(outputPath);
  await mkdir(output, { recursive: true });
  await installModels(
    decodeJson<unknown>(await readFile(lockPath, 'utf8'), 'research_model_lock_corrupt'),
    output,
    options
  );
}

export async function installModels(
  lock: unknown,
  outputPath: string,
  options: {
    resolveUrl?: (source: ModelSource, filename: string) => string;
    download?: DownloadFn;
  } = {}
): Promise<void> {
  if ((await pathInfo(outputPath))?.isSymbolicLink()) fail('research_model_output_symlink');
  const output = resolve(outputPath);
  await mkdir(output, { recursive: true });
  for (const source of readSources(lock)) await fetchModel(source, output, options);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { lock: { type: 'string' }, output: { type: 'string' } },
    strict: true
  });
  if (values.lock === undefined || values.lock === '' || values.output === undefined || values.output === '') {
    fail('research_models_lock_invalid');
  }
  await fetchModels(values.lock, values.output);
}

if (process.argv[1] !== undefined && /(?:^|\/)fetch-models\.[cm]?[jt]s$/u.test(process.argv[1].replaceAll('\\', '/'))) {
  await main();
}
