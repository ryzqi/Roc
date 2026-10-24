import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { fileSha256 } from './download-asset.ts';
import { decodeJson } from '../lib/decode-json.ts';

/**
 * MinerU 模型清单与就绪校验。
 *
 * MinerU 的模型仓库里**有权重之外的官方标记文件**（`.mineru_complete`、`.gitattributes`），
 * 而本地来源就绪检查（`_verify_paths`）只认这几条：目录或文件存在即可，不看内容摘要。所以：
 *
 * 1. 清单逐文件列出**全部**内容（含官方标记），并由 Roc 记录 SHA-256；
 * 2. 下载走官方入口 `mineru-kit models download`，标记由官方生成，Roc 不手写；
 * 3. 下载后由 Roc 逐文件核对摘要，任何未在清单内的文件都判为失败。
 *
 * 就绪判定只做「存在 + 摘要」，因此解析进程在模型目录只读时仍能工作。
 */

export type ModelFile = { bytes: number; sha256: string };

export type ModelSource = {
  /** MinerU 官方模型仓库名（`MinerU-4_models_torch` 等），也是本地目录名。 */
  name: string;
  kind: 'torch' | 'gguf';
  license: string;
  files: Record<string, ModelFile>;
};

export type ModelsLock = {
  schemaVersion: 2;
  engine: 'mineru';
  engineVersion: string;
  models: ModelSource[];
};

/** 模型仓库标识：与官方 CLI 的 `--tier`/仓库名一致。 */
export type ModelPack = 'basic' | 'standard' | 'advanced' | 'flash';

/** 每个配置包需要的仓库集合（advanced 与 standard 共用权重）。 */
export const PACK_REPOS: Readonly<Record<ModelPack, readonly string[]>> = {
  basic: ['MinerU-4_models_torch'],
  standard: ['MinerU-4_models_torch', 'MinerU2.5-Pro-2605-1.2B-GGUF'],
  advanced: ['MinerU-4_models_torch', 'MinerU2.5-Pro-2605-1.2B-GGUF'],
  // Flash 走 HTML 快速路径；扫描件仍需小模型，因此仍要求 torch 仓库。
  flash: ['MinerU-4_models_torch']
};

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

/**
 * 清单内的相对路径必须是仓库内的普通路径。
 *
 * 官方标记文件（`.mineru_complete`、`.gitattributes`）是合法条目，但 `.cache` 是
 * HuggingFace 的下载元数据，随下载源变化，不能进受控清单。
 */
function assertModelFileName(filename: string): void {
  if (isAbsolute(filename) || filename.includes('\\')
      || filename.split('/').some((part) => part === '' || part === '.' || part === '..' || part === '.cache')) {
    fail('research_model_file_path_invalid');
  }
}

export function readSources(value: unknown): ModelSource[] {
  if (typeof value !== 'object' || value === null) fail('research_models_lock_invalid');
  const lock = value as { schemaVersion?: unknown; models?: unknown };
  if (lock.schemaVersion !== 2 || !Array.isArray(lock.models) || lock.models.length === 0) {
    fail('research_models_lock_invalid');
  }
  const sources: ModelSource[] = [];
  const names = new Set<string>();
  for (const item of lock.models) {
    if (typeof item !== 'object' || item === null) fail('research_models_lock_invalid');
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string' || !/^[A-Za-z0-9_.-]+$/u.test(record.name)) fail('research_model_name_invalid');
    if (record.kind !== 'torch' && record.kind !== 'gguf') fail('research_model_kind_invalid');
    if (typeof record.license !== 'string' || record.license === '') fail('research_models_lock_invalid');
    if (typeof record.files !== 'object' || record.files === null || Array.isArray(record.files)
        || Object.keys(record.files).length === 0) {
      fail('research_model_files_required');
    }
    const files: Record<string, ModelFile> = {};
    for (const [filename, entry] of Object.entries(record.files as Record<string, unknown>)) {
      assertModelFileName(filename);
      if (typeof entry !== 'object' || entry === null) fail('research_model_digest_invalid');
      const file = entry as Record<string, unknown>;
      if (Object.keys(file).length !== 2) fail('research_model_digest_invalid');
      if (typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
        fail('research_model_digest_invalid');
      }
      if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(file.sha256)) fail('research_model_digest_invalid');
      files[filename] = { bytes: file.bytes, sha256: file.sha256 };
    }
    if (names.has(record.name)) fail('research_model_name_duplicate');
    names.add(record.name);
    sources.push({ name: record.name, kind: record.kind, license: record.license, files });
  }
  return sources;
}

/** 清单内某个配置包需要的仓库与总字节数（用于 UI 展示真实下载量）。 */
export function packBytes(lock: ModelsLock, pack: ModelPack): number {
  const wanted = new Set(PACK_REPOS[pack]);
  return readSources(lock)
    .filter((source) => wanted.has(source.name))
    .flatMap((source) => Object.values(source.files))
    .reduce((total, file) => total + file.bytes, 0);
}

/**
 * 逐文件核对一个已安装仓库。
 *
 * `strict` 为真时（用户显式校验/首次发布），仓库内出现的清单外文件也判失败：
 * 未经验证的文件不能进入 ready。宽松模式只核对清单内文件，用于解析前的快速探针。
 */
export async function verifyModelRepository(root: string, source: ModelSource, options: { strict?: boolean } = {}): Promise<void> {
  const rootInfo = await pathInfo(root);
  if (rootInfo === null) fail('research_models_unavailable');
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail('research_model_symlink');
  if (options.strict === true) {
    const allowed = new Set(Object.keys(source.files));
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        const relativePath = posixRelative(root, full);
        if (entry.isSymbolicLink()) fail('research_model_symlink');
        if (entry.isDirectory()) {
          // `.cache` 是下载器自己的元数据目录，不参与内容校验，也不当作模型文件。
          if (entry.name === '.cache') continue;
          await visit(full);
          continue;
        }
        if (!entry.isFile()) fail('research_model_symlink');
        if (!allowed.has(relativePath)) fail(`research_model_unexpected_file:${source.name}/${relativePath}`);
      }
    };
    await visit(root);
  }
  for (const [filename, expected] of Object.entries(source.files)) {
    const path = join(root, filename);
    const info = await pathInfo(path);
    if (info === null || info.isSymbolicLink() || !info.isFile()) {
      fail(`research_model_missing:${source.name}/${filename}`);
    }
    if (info.size !== expected.bytes) fail(`research_model_hash_mismatch:${source.name}/${filename}`);
    if (await fileSha256(path) !== expected.sha256) fail(`research_model_hash_mismatch:${source.name}/${filename}`);
  }
}

export type InstalledModelStatus = { name: string; kind: 'torch' | 'gguf'; ready: boolean; bytes: number; error: string | null };

export type InstalledModelsStatus = {
  available: boolean;
  ready: boolean;
  error: string | null;
  models: InstalledModelStatus[];
};

/**
 * 检查模型根下每个仓库的状态。
 *
 * `verifyHashes` 为假时只做存在性与大小检查：摘要全量校验要读 2 GB，不适合放在
 * 每次打开设置页的路径上。解析前的确证走 `verifyHashes: true`。
 */
export async function inspectInstalledModels(
  rootPath: string | null,
  lock: unknown,
  options: { verifyHashes?: boolean; packs?: readonly ModelPack[] } = {}
): Promise<InstalledModelsStatus> {
  if (rootPath === null || !isAbsolute(rootPath)) {
    return { available: false, ready: false, error: 'research_models_unavailable', models: [] };
  }
  const rootInfo = await pathInfo(rootPath);
  if (rootInfo === null) return { available: true, ready: false, error: 'research_models_unavailable', models: [] };
  if (rootInfo.isSymbolicLink()) fail('research_model_output_symlink');
  const required = options.packs === undefined ? null : new Set(options.packs.flatMap((pack) => PACK_REPOS[pack]));
  const models: InstalledModelStatus[] = [];
  for (const source of readSources(lock)) {
    if (required !== null && !required.has(source.name)) continue;
    const directory = join(rootPath, source.name);
    const bytes = Object.values(source.files).reduce((total, file) => total + file.bytes, 0);
    const info = await pathInfo(directory);
    if (info === null) {
      models.push({ name: source.name, kind: source.kind, ready: false, bytes, error: 'research_model_missing' });
      continue;
    }
    try {
      await verifyModelRepository(directory, source, { strict: options.verifyHashes === true });
      models.push({ name: source.name, kind: source.kind, ready: true, bytes, error: null });
    } catch (error) {
      const code = error instanceof Error ? error.message.split(':', 1)[0] : 'research_models_invalid';
      // 逐个仓库记录错误，不再提前返回：一个坏的仓库不该让其余仓库的状态消失。
      models.push({ name: source.name, kind: source.kind, ready: false, bytes, error: code });
    }
  }
  const ready = models.length > 0 && models.every((model) => model.ready);
  const firstError = models.find((model) => model.error !== null)?.error ?? null;
  return { available: true, ready, error: ready ? null : (firstError ?? 'research_models_unavailable'), models };
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

/**
 * 已经落盘的字节数（只数清单内的文件，不数 `.cache`）。
 *
 * 用真字节而不是百分比：官方下载器自己管 staging，Roc 只能看磁盘。
 * 包含 staging（`.downloads/<repo>`）与已发布目录，所以下载中途也不会回退。
 */
async function downloadedBytes(root: string, repos: readonly ModelSource[]): Promise<number> {
  let total = 0;
  for (const repo of repos) {
    for (const [filename, expected] of Object.entries(repo.files)) {
      // 官方 CLI 下载中落在 `.downloads/<repo>/models/<repo>/<file>`，发布前重命名到
      // `.downloads/<repo>/<repo>/<file>`，发布后在 `<repo>/<file>`。三个位置都要数，
      // 否则下载中途的进度会始终是 0。
      const candidates = [
        join(root, repo.name, filename),
        join(root, '.downloads', repo.name, repo.name, filename),
        join(root, '.downloads', repo.name, 'models', repo.name, filename)
      ];
      for (const candidate of candidates) {
        const info = await pathInfo(candidate);
        if (info === null || !info.isFile()) continue;
        total += Math.min(info.size, expected.bytes);
        break;
      }
    }
  }
  return total;
}

/** 下载任务的外部信号：进度来自磁盘，取消由 AbortSignal 传入。 */
export type DownloadContext = { signal?: AbortSignal; onProgress?: (bytesDone: number) => void };

/** 官方下载入口：`mineru-kit models download <repo> --source <source>`。 */
export type OfficialDownloader = (source: ModelSource, staging: string, context: DownloadContext) => Promise<void>;

/**
 * 从官方入口下载一个仓库到 staging，再逐文件核对后发布。
 *
 * 不自己拼 HuggingFace URL：官方入口负责 `.mineru_complete` 之类的就绪标记，
 * 清单里不含这些路径以外的东西，但标记文件本身必须是官方产物（见文件头注释）。
 */
export async function fetchModel(
  source: ModelSource,
  output: string,
  options: { download?: OfficialDownloader; skipVerify?: boolean; context?: DownloadContext } = {}
): Promise<void> {
  if ((await pathInfo(output))?.isSymbolicLink()) fail('research_model_output_symlink');
  await mkdir(output, { recursive: true });
  await mkdir(join(output, '.locks'), { recursive: true });
  await withDownloadLock(join(output, '.locks', `${source.name}.lock`), async () => {
    const destination = join(output, source.name);
    const existing = await pathInfo(destination);
    if (existing !== null) {
      // 已发布仓库不再重下：`ready` 的唯一含义是逐文件摘要已核对通过。
      await verifyModelRepository(destination, source, { strict: true });
      return;
    }
    const downloads = join(output, '.downloads');
    if ((await pathInfo(downloads))?.isSymbolicLink()) fail('research_model_download_cache_symlink');
    await mkdir(downloads, { recursive: true });
    // 不删 staging：官方下载器按文件跳过已完成项，删掉就等于取消断点续传。
    // 发布成功后由下面的 `rm` 清理，取消/失败时保留给下一次重试。
    const staging = join(downloads, source.name);
    await mkdir(join(staging, '.locks'), { recursive: true });
    await (options.download ?? failOfficialDownloader)(source, staging, options.context ?? {});
    if (options.skipVerify !== true) await verifyModelRepository(join(staging, source.name), source, { strict: true });
    await rename(join(staging, source.name), destination);
    await rm(staging, { recursive: true, force: true });
  });
}

function failOfficialDownloader(): never {
  fail('research_model_downloader_unavailable');
}

export async function installModels(
  lock: unknown,
  outputPath: string,
  options: { download?: OfficialDownloader; packs?: readonly ModelPack[]; skipVerify?: boolean; context?: DownloadContext } = {}
): Promise<void> {
  if ((await pathInfo(outputPath))?.isSymbolicLink()) fail('research_model_output_symlink');
  const output = resolve(outputPath);
  await mkdir(output, { recursive: true });
  const required = options.packs === undefined ? null : new Set(options.packs.flatMap((pack) => PACK_REPOS[pack]));
  for (const source of readSources(lock)) {
    if (required !== null && !required.has(source.name)) continue;
    await fetchModel(source, output, options);
  }
}

/** 导出给模型管理：用真实文件大小报告进度，而不是估算值。 */
export async function downloadedBytesFor(root: string, lock: ModelsLock, pack: ModelPack): Promise<number> {
  const wanted = new Set(PACK_REPOS[pack]);
  return await downloadedBytes(root, readSources(lock).filter((source) => wanted.has(source.name)));
}

export async function totalBytes(path: string): Promise<number> {
  const info = await pathInfo(path);
  if (info === null) return 0;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === '.cache') continue;
    total += await totalBytes(join(path, entry.name));
  }
  return total;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { lock: { type: 'string' }, output: { type: 'string' }, verify: { type: 'boolean' }, pack: { type: 'string' } },
    strict: true
  });
  if (values.lock === undefined || values.lock === '' || values.output === undefined || values.output === '') {
    fail('research_models_lock_invalid');
  }
  const lock = decodeJson<unknown>(await readFile(values.lock, 'utf8'), 'research_model_lock_corrupt');
  if (values.verify === true) {
    const status = await inspectInstalledModels(values.output, lock, { verifyHashes: true });
    console.log(JSON.stringify(status, null, 2));
    if (!status.ready) process.exitCode = 1;
    return;
  }
  if (values.pack !== undefined) {
    // CLI 下载由 prepare.ts 注入官方下载器；这里只支持校验模式。
    fail('research_model_downloader_unavailable');
  }
  const status = await inspectInstalledModels(values.output, lock, {});
  console.log(JSON.stringify(status, null, 2));
  if (!status.ready) process.exitCode = 1;
}

if (process.argv[1] !== undefined && /(?:^|\/)fetch-models\.[cm]?[jt]s$/u.test(process.argv[1].replaceAll('\\', '/'))) {
  await main();
}
