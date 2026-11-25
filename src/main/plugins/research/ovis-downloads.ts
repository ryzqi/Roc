import {createHash} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {z} from 'zod';
import sourceLock from '../../../../resources/ovis-ocr/manifest.json';
import wheelLock from '../../../../resources/ovis-downloads/wheels.lock.json';
import {downloadVerified, fileSha256, type DownloadProgress} from '../../../../scripts/research/download-asset';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const filename = z.string().regex(/^[A-Za-z0-9_.+-]+\.whl$/u);
const lockSchema = z.strictObject({schemaVersion: z.literal(1),
  target: z.strictObject({python: z.literal('3.14.10'), implementation: z.literal('cpython'), abi: z.literal('cp314'),
    system: z.literal('Darwin'), machine: z.literal('arm64'), minimumMacOS: z.literal('15.0')}),
  requirementsSha256: digest, bytes: z.number().int().positive(),
  wheels: z.array(z.strictObject({name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u), version: z.string().min(1),
    filename, url: z.string().url(), size: z.number().int().positive().max(512 * 1024 ** 2), sha256: digest})).length(67)
});
const pinned = lockSchema.parse(wheelLock);

export type OvisDownloadAsset = {path: string; url: string; size: number; sha256: string};
export type OvisDownloadProgress = DownloadProgress & {asset: string; phase: 'downloading' | 'verifying'};
export const ovisDownloadTarget = Object.freeze({...pinned.target});

function validateAsset(asset: OvisDownloadAsset): void {
  const parts = asset.path.split('/'), url = new URL(asset.url);
  if (!['source', 'wheels'].includes(parts[0]) || parts.length < 2 ||
      parts.some(part => !/^[A-Za-z0-9_.+-]+$/u.test(part) || part === '.' || part === '..') ||
      url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      !digest.safeParse(asset.sha256).success || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 2 * 1024 ** 3 ||
      (parts[0] === 'wheels' ? parts.length !== 2 || !filename.safeParse(parts[1]).success ||
        url.hostname !== 'files.pythonhosted.org' || url.pathname.split('/').at(-1) !== parts[1]
        : url.hostname !== 'huggingface.co' || url.pathname !==
          `/${sourceLock.model.repository}/resolve/${sourceLock.model.revision}/${parts.slice(1).join('/')}`)) {
    throw new Error('research_ovis_download_asset_invalid');
  }
}

/** Derived wheel URLs must still name exactly the existing hash-locked packages. */
export function verifyOvisRequirements(bytes: Uint8Array): void {
  if (createHash('sha256').update(bytes).digest('hex') !== pinned.requirementsSha256) {
    throw new Error('research_ovis_requirements_changed');
  }
  const packages = new Map<string, {version: string; hashes: Set<string>}>();
  for (const line of Buffer.from(bytes).toString('utf8').replace(/\\\n/gu, ' ').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([a-z0-9][a-z0-9-]*)==([^\s;]+)((?:\s+--hash=sha256:[a-f0-9]{64})+)\s*$/u.exec(line.trim());
    if (!match || packages.has(match[1])) throw new Error('research_ovis_requirements_invalid');
    packages.set(match[1], {version: match[2], hashes: new Set([...match[3].matchAll(/sha256:([a-f0-9]{64})/gu)].map(item => item[1]))});
  }
  if (packages.size !== pinned.wheels.length || pinned.wheels.some(wheel =>
    packages.get(wheel.name)?.version !== wheel.version || !packages.get(wheel.name)?.hashes.has(wheel.sha256))) {
    throw new Error('research_ovis_wheel_lock_mismatch');
  }
}

export function ovisDownloadAssets(): readonly OvisDownloadAsset[] {
  const assets: OvisDownloadAsset[] = [
    ...sourceLock.model.files.map(file => ({path: `source/${file.path}`, size: file.size, sha256: file.sha256,
      url: `https://huggingface.co/${sourceLock.model.repository}/resolve/${sourceLock.model.revision}/${file.path}`})),
    ...pinned.wheels.map(wheel => ({path: `wheels/${wheel.filename}`, size: wheel.size, sha256: wheel.sha256, url: wheel.url}))
  ];
  if (new Set(pinned.wheels.map(wheel => wheel.name)).size !== pinned.wheels.length ||
      pinned.bytes !== pinned.wheels.reduce((total, wheel) => total + wheel.size, 0)) {
    throw new Error('research_ovis_wheel_lock_invalid');
  }
  assets.forEach(validateAsset);
  return assets;
}

type Download = typeof downloadVerified;
type Bundle = {root: string; assets: readonly OvisDownloadAsset[]; bytes: number};

/** Main-only transaction: no executable package is run during download. The consumer
 * finishes before this call removes its private bundle; failed supervision retains it. */
export async function withOvisDownloads<T>(input: {parent: string; assets: readonly OvisDownloadAsset[];
  signal: AbortSignal; onProgress?: (progress: OvisDownloadProgress) => void},
  consume: (bundle: Bundle) => Promise<T>, download: Download = downloadVerified): Promise<T> {
  input.signal.throwIfAborted();
  const assets = input.assets.map(asset => ({...asset}));
  assets.forEach(validateAsset);
  const bytes = assets.reduce((total, asset) => total + asset.size, 0);
  if (!assets.length || assets.length > 128 || bytes > 4 * 1024 ** 3 ||
      new Set(assets.map(asset => asset.path.toLowerCase())).size !== assets.length || !isAbsolute(input.parent)) {
    throw new Error('research_ovis_download_request_invalid');
  }
  const parentInfo = await lstat(input.parent), parent = await realpath(input.parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('research_ovis_download_parent_invalid');
  const root = await mkdtemp(join(parent, 'ovis-download-')), owner = await lstat(root);
  let retain = false, completed = 0;
  try {
    for (const asset of assets) {
      input.signal.throwIfAborted();
      const path = join(root, asset.path);
      const directories = asset.path.split('/').slice(0, -1);
      let directory = root;
      for (const part of directories) {
        directory = join(directory, part);
        await mkdir(directory, {recursive: true, mode: 0o700});
        if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) {
          throw new Error('research_ovis_download_directory_changed');
        }
      }
      await download(asset.url, asset.sha256, path, {expectedSize: asset.size, signal: input.signal,
        onProgress: progress => input.onProgress?.({phase: 'downloading', asset: asset.path,
          bytesDone: completed + progress.bytesDone, bytesTotal: bytes})});
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== asset.size ||
          await fileSha256(path, input.signal) !== asset.sha256) throw new Error('research_ovis_download_integrity_failed');
      // Each verified file no longer needs its resumable chunks.
      await rm(`${path}.parts`, {recursive: true, force: true});
      completed += asset.size;
      input.onProgress?.({phase: 'verifying', asset: asset.path, bytesDone: completed, bytesTotal: bytes});
    }
    input.signal.throwIfAborted();
    return await consume({root, assets, bytes});
  } catch (error) {
    retain = error instanceof Error && 'code' in error && ['research_process_kill_failed',
      'research_process_supervision_failed', 'research_process_completion_failed'].includes(String(error.code));
    throw error;
  } finally {
    if (!retain) {
      const current = await lstat(root);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino ||
          await realpath(root) !== root) throw new Error('research_ovis_download_cleanup_identity_changed');
      await rm(root, {recursive: true});
    }
  }
}

export async function verifyOvisRequirementsFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('research_ovis_requirements_invalid');
  verifyOvisRequirements(await readFile(path));
}
