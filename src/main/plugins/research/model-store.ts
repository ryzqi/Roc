import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ResearchProcessError } from './process-runner';
import type { researchModelJobSchema, researchModelsStatusSchema } from '../../../shared/schemas/research-production';
import type { z } from 'zod';
import type { ResearchModelPack } from '../../../shared/schemas/research-production';
import { getModelAsset, getModelPackAssets, modelAssetPath, modelPackBytes, modelPackManifest, researchModelAssetIds } from './model-catalog';
import type { ResearchModelAsset, ResearchModelAssetId } from './model-catalog';
import { downloadVerified, fileSha256 } from '../../../../scripts/research/download-asset';

export type ResearchModelsStatus = z.infer<typeof researchModelsStatusSchema>;
type ModelJob = z.infer<typeof researchModelJobSchema>;
type PackStatus = ResearchModelsStatus['packs'][number];
export type ModelPreferences = { pack: ResearchModelPack };

export type ResearchModelFiles = {
  detection: string;
  recognition: string;
  dictionary: string;
  layout: string;
  table: string;
  formula?: string;
  formulaTokenizer?: string;
};

export type ResearchModelLease = {
  pack: ResearchModelPack;
  root: string;
  manifest: string;
  files: ResearchModelFiles;
};

type InspectedAsset = { asset: ResearchModelAsset; path: string; ready: boolean; installedBytes: number; error: string | null; signature: string | null };

type PersistPreferences = (next: ModelPreferences) => void;

/** Pinned PaddleOCR assets, integrity checks, resumable download, and active parse leases. */
export class ResearchModelStore {
  private job: ModelJob | null = null;
  private lastError: string | null = null;
  private readonly leases = new Map<ResearchModelPack, number>();
  private readonly verifiedAssets = new Map<ResearchModelAssetId, string>();
  private preferences: ModelPreferences;

  constructor(
    private readonly rootPath: string | null,
    preferences: Partial<ModelPreferences> = {},
    private readonly persist: PersistPreferences | null = null
  ) {
    this.preferences = { pack: isModelPack(preferences.pack) ? preferences.pack : 'compact' };
  }

  get selectedPack(): ResearchModelPack {
    return this.preferences.pack;
  }

  selectPack(pack: ResearchModelPack): void {
    if (this.preferences.pack === pack) return;
    this.preferences = { pack };
    this.persist?.(this.preferences);
  }

  async status(): Promise<ResearchModelsStatus> {
    if (this.rootPath === null || !isAbsolute(this.rootPath)) return this.unavailableStatus();
    const root = await this.existingRoot();
    if (root === null) return this.emptyStatus();
    const inspected = new Map<ResearchModelAssetId, InspectedAsset>();
    for (const id of researchModelAssetIds) {
      const asset = getModelAsset(id);
      inspected.set(id, await inspectAsset(root, asset, false));
    }
    const models = [...inspected.values()].map(({ asset, ready, installedBytes, error }) => ({
      id: asset.id, name: asset.name, kind: asset.kind, ready, bytes: installedBytes, error
    }));
    const packs: PackStatus[] = (['compact', 'complete'] as const).map((pack) => {
      const packAssets = getModelPackAssets(pack).map((asset) => inspected.get(asset.id));
      const ready = packAssets.every((asset) => asset?.ready === true);
      const firstError = packAssets.find((asset) => asset?.error !== null)?.error ?? null;
      const jobPhase = this.job?.pack === pack ? this.job.phase : null;
      let state: PackStatus['state'];
      if (jobPhase !== null) state = jobPhase;
      else if (ready) state = 'ready';
      else if (isAssetError(firstError)) state = 'incompatible';
      else state = 'missing';
      let error: string | null = null;
      if (!ready) {
        error = firstError;
        if (error === null && jobPhase === null) error = 'research_model_asset_missing';
      }
      return {
        pack,
        ready,
        bytes: modelPackBytes(pack),
        installedBytes: packAssets.reduce((sum, asset) => sum + (asset?.installedBytes ?? 0), 0),
        state,
        error,
        models: getModelPackAssets(pack).map((asset) => asset.id)
      };
    });
    const selected = packs.find((pack) => pack.pack === this.preferences.pack);
    return {
      ready: selected?.ready === true,
      downloading: this.job !== null,
      error: this.lastError ?? selected?.error ?? null,
      selectedPack: this.preferences.pack,
      job: this.job,
      packs,
      models
    };
  }

  /** Hash each pinned file before a parse, caching only unchanged inode/size/mtime signatures. */
  async requireReady(pack: ResearchModelPack = this.preferences.pack): Promise<ResearchModelLease> {
    const root = await this.requireRoot();
    for (const asset of getModelPackAssets(pack)) {
      const state = await inspectAsset(root, asset, false);
      if (!state.ready || state.signature === null) {
        throw new ResearchProcessError(state.error ?? 'research_model_asset_missing');
      }
      if (this.verifiedAssets.get(asset.id) !== state.signature) {
        const inspected = await inspectAsset(root, asset, true);
        if (!inspected.ready || inspected.signature === null) {
          throw new ResearchProcessError(inspected.error ?? 'research_model_asset_missing');
        }
        this.verifiedAssets.set(asset.id, inspected.signature);
      }
    }
    this.leases.set(pack, (this.leases.get(pack) ?? 0) + 1);
    return { pack, root, manifest: modelPackManifest(pack), files: this.modelFiles(root, pack) };
  }

  /** Use ready models when available; native PDF text/HTML parsing can proceed without weights. */
  async tryRequireReady(pack: ResearchModelPack = this.preferences.pack): Promise<ResearchModelLease | null> {
    const root = await this.existingRoot();
    if (root === null) return null;
    for (const asset of getModelPackAssets(pack)) {
      const inspected = await inspectAsset(root, asset, false);
      if (!inspected.ready) {
      if (inspected.error !== null && isAssetError(inspected.error)) throw new ResearchProcessError(inspected.error);
        return null;
      }
    }
    return await this.requireReady(pack);
  }

  release(pack: ResearchModelPack): void {
    const current = this.leases.get(pack) ?? 0;
    if (current <= 1) this.leases.delete(pack);
    else this.leases.set(pack, current - 1);
  }

  async download(pack: ResearchModelPack, signal?: AbortSignal): Promise<ResearchModelsStatus> {
    if (this.job !== null) throw new ResearchProcessError('research_model_download_locked');
    const root = await this.requireRoot();
    this.selectPack(pack);
    this.lastError = null;
    const assets = getModelPackAssets(pack);
    const startedAt = new Date().toISOString();
    this.job = { pack, phase: 'downloading', bytesDone: 0, bytesTotal: modelPackBytes(pack), startedAt };
    let reporting = false;
    const report = async (): Promise<void> => {
      if (this.job === null || reporting) return;
      reporting = true;
      try {
        const bytesDone = await downloadedBytes(root, assets);
        if (this.job !== null) this.job = { ...this.job, bytesDone };
      } finally {
        reporting = false;
      }
    };
    const timer = setInterval(() => {
      void report().catch((error: unknown) => { if (this.job !== null) this.lastError = errorCode(error); });
    }, 1_000);
    timer.unref();
    try {
      for (const asset of assets) {
        throwIfAborted(signal);
        const installedPath = modelAssetPath(root, asset.id);
        const installed = await inspectAsset(root, asset, true);
        if (installed.ready) {
          this.verifiedAssets.set(asset.id, installed.signature ?? '');
          continue;
        }
        if (installed.error !== 'research_model_asset_missing') await rm(installedPath, { force: true });
        const temporaryDirectory = await safeDirectory(root, '.downloads');
        const temporaryPath = join(temporaryDirectory, `${asset.id}.bin`);
        try {
          await downloadVerified(asset.url, asset.sha256, temporaryPath, { expectedSize: asset.bytes, signal });
        } catch (error) {
          if (isDownloadIntegrityError(error)) {
            await rm(temporaryPath, { force: true });
            await rm(`${temporaryPath}.parts`, { recursive: true, force: true });
          }
          throw error;
        }
        throwIfAborted(signal);
        await ensureAssetParent(root, asset);
        await rename(temporaryPath, installedPath);
        const verified = await inspectAsset(root, asset, true);
        if (!verified.ready || verified.signature === null) throw new ResearchProcessError(verified.error ?? 'research_model_asset_invalid');
        this.verifiedAssets.set(asset.id, verified.signature);
      }
      this.job = { pack, phase: 'verifying', bytesDone: modelPackBytes(pack), bytesTotal: modelPackBytes(pack), startedAt };
      for (const asset of assets) {
        const verified = await inspectAsset(root, asset, true);
        if (!verified.ready || verified.signature === null) throw new ResearchProcessError(verified.error ?? 'research_model_asset_invalid');
        this.verifiedAssets.set(asset.id, verified.signature);
      }
      this.lastError = null;
      this.job = null;
      return await this.status();
    } catch (error) {
      const failureCode = errorCode(error);
      if (failureCode === 'research_download_cancelled') {
        this.lastError = null;
        this.job = null;
        return await this.status();
      }
      this.lastError = failureCode;
      throw error;
    } finally {
      clearInterval(timer);
      this.job = null;
    }
  }

  /** Import only the selected pack's pinned relative paths. */
  async importDirectory(directory: string, pack: ResearchModelPack): Promise<ResearchModelsStatus> {
    if (this.job !== null) throw new ResearchProcessError('research_model_download_locked');
    if ((this.leases.get(pack) ?? 0) > 0) throw new ResearchProcessError('research_model_in_use');
    if (!isAbsolute(directory)) throw new ResearchProcessError('research_model_import_path_invalid');
    const root = await this.requireRoot();
    const source = await realpathDirectory(directory);
    const assets = getModelPackAssets(pack);
    const staging = await mkdtemp(join(root, '.import-'));
    this.selectPack(pack);
    this.lastError = null;
    this.job = { pack, phase: 'importing', bytesDone: 0, bytesTotal: modelPackBytes(pack), startedAt: new Date().toISOString() };
    try {
      for (const asset of assets) {
        const sourcePath = modelAssetPath(source, asset.id);
        const inspected = await inspectFile(source, asset, sourcePath, true);
        if (!inspected.ready) throw new ResearchProcessError(inspected.error ?? 'research_model_import_missing_asset');
        const stagedPath = modelAssetPath(staging, asset.id);
        await mkdir(join(stagedPath, '..'), { recursive: true, mode: 0o700 });
        await copyFile(sourcePath, stagedPath);
        const staged = await inspectFile(staging, asset, stagedPath, true);
        if (!staged.ready) throw new ResearchProcessError(staged.error ?? 'research_model_asset_invalid');
        this.job = { ...this.job, bytesDone: this.job.bytesDone + asset.bytes };
      }
      for (const asset of assets) {
        const stagedPath = modelAssetPath(staging, asset.id);
        const target = modelAssetPath(root, asset.id);
        await ensureAssetParent(root, asset);
        await rename(stagedPath, target);
        const inspected = await inspectAsset(root, asset, true);
        if (!inspected.ready || inspected.signature === null) throw new ResearchProcessError(inspected.error ?? 'research_model_asset_invalid');
        this.verifiedAssets.set(asset.id, inspected.signature);
      }
      this.lastError = null;
      this.job = null;
      return await this.status();
    } finally {
      this.job = null;
      await rm(staging, { recursive: true, force: true });
    }
  }

  async remove(pack: ResearchModelPack): Promise<ResearchModelsStatus> {
    if (this.job !== null) throw new ResearchProcessError('research_model_download_locked');
    if ((this.leases.get(pack) ?? 0) > 0) throw new ResearchProcessError('research_model_in_use');
    const root = await this.requireRoot();
    const otherPack = pack === 'compact' ? 'complete' : 'compact';
    const otherReady = (this.leases.get(otherPack) ?? 0) > 0 || (await this.status()).packs.find((entry) => entry.pack === otherPack)?.ready === true;
    for (const asset of getModelPackAssets(pack)) {
      const usedElsewhere = otherReady && getModelPackAssets(otherPack).some((other) => other.id === asset.id);
      if (usedElsewhere) continue;
      await rm(modelAssetPath(root, asset.id), { force: true });
      this.verifiedAssets.delete(asset.id);
    }
    this.lastError = null;
    return await this.status();
  }

  private modelFiles(root: string, pack: ResearchModelPack): ResearchModelFiles {
    return {
      detection: modelAssetPath(root, 'ocr-det'),
      recognition: modelAssetPath(root, 'ocr-rec'),
      dictionary: modelAssetPath(root, 'ocr-dictionary'),
      layout: modelAssetPath(root, 'layout'),
      table: modelAssetPath(root, 'table'),
      ...(pack === 'complete' ? {
        formula: modelAssetPath(root, 'formula'),
        formulaTokenizer: modelAssetPath(root, 'formula-tokenizer')
      } : {})
    };
  }

  private async requireRoot(): Promise<string> {
    if (this.rootPath === null || !isAbsolute(this.rootPath)) throw new ResearchProcessError('research_models_unavailable');
    const info = await lstatIfExists(this.rootPath);
    if (info?.isSymbolicLink()) throw new ResearchProcessError('research_model_root_symlink');
    if (info === null) await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    return await realpath(this.rootPath);
  }

  private async existingRoot(): Promise<string | null> {
    if (this.rootPath === null || !isAbsolute(this.rootPath)) return null;
    const info = await lstatIfExists(this.rootPath);
    if (info === null) return null;
    if (info.isSymbolicLink() || !info.isDirectory()) throw new ResearchProcessError('research_model_root_invalid');
    return await realpath(this.rootPath);
  }

  private unavailableStatus(): ResearchModelsStatus {
    const packs: PackStatus[] = (['compact', 'complete'] as const).map((pack) => ({
      pack, ready: false, bytes: modelPackBytes(pack), installedBytes: 0, state: 'missing',
      error: 'research_models_unavailable', models: getModelPackAssets(pack).map((asset) => asset.id)
    }));
    return {
      ready: false, downloading: false, error: 'research_models_unavailable', selectedPack: this.preferences.pack,
      job: null, packs, models: []
    };
  }

  private emptyStatus(): ResearchModelsStatus {
    const models = researchModelAssetIds.map((id) => {
      const asset = getModelAsset(id);
      return { id, name: asset.name, kind: asset.kind, ready: false, bytes: 0, error: 'research_model_asset_missing' };
    });
    const packs: PackStatus[] = (['compact', 'complete'] as const).map((pack) => ({
      pack, ready: false, bytes: modelPackBytes(pack), installedBytes: 0, state: 'missing',
      error: 'research_model_asset_missing', models: getModelPackAssets(pack).map((asset) => asset.id)
    }));
    return {
      ready: false, downloading: this.job !== null, error: this.lastError ?? 'research_model_asset_missing', selectedPack: this.preferences.pack,
      job: this.job, packs, models
    };
  }
}

async function inspectAsset(root: string, asset: ResearchModelAsset, verifyHash: boolean): Promise<InspectedAsset> {
  return await inspectFile(root, asset, modelAssetPath(root, asset.id), verifyHash);
}

async function inspectFile(root: string, asset: ResearchModelAsset, path: string, verifyHash: boolean): Promise<InspectedAsset> {
  try {
    const info = await safeFileStat(root, asset.file);
    if (info === null) return { asset, path, ready: false, installedBytes: 0, error: 'research_model_asset_missing', signature: null };
    if (!info.isFile()) throw new ResearchProcessError('research_model_asset_invalid');
    const signature = fileSignature(info);
    if (info.size !== asset.bytes) return { asset, path, ready: false, installedBytes: Math.min(info.size, asset.bytes), error: 'research_model_asset_size_mismatch', signature };
    if (verifyHash && await fileSha256(path) !== asset.sha256) {
      return { asset, path, ready: false, installedBytes: info.size, error: 'research_model_asset_hash_mismatch', signature };
    }
    return { asset, path, ready: true, installedBytes: info.size, error: null, signature };
  } catch (error) {
    return { asset, path, ready: false, installedBytes: 0, error: errorCode(error), signature: null };
  }
}

async function safeFileStat(root: string, relativePath: string) {
  const segments = relativePath.split('/');
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    const info = await lstatIfExists(current);
    if (info === null) return null;
    if (info.isSymbolicLink()) throw new ResearchProcessError('research_model_asset_symlink');
    if (index < segments.length - 1 && !info.isDirectory()) throw new ResearchProcessError('research_model_asset_path_invalid');
    if (index === segments.length - 1) return info;
  }
  return null;
}

async function ensureAssetParent(root: string, asset: ResearchModelAsset): Promise<void> {
  const parts = asset.file.split('/');
  parts.pop();
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstatIfExists(current);
    if (info?.isSymbolicLink()) throw new ResearchProcessError('research_model_asset_symlink');
    if (info !== null && !info.isDirectory()) throw new ResearchProcessError('research_model_asset_path_invalid');
    if (info === null) await mkdir(current, { mode: 0o700 });
  }
}

async function safeDirectory(root: string, relativePath: string): Promise<string> {
  const target = join(root, relativePath);
  const info = await lstatIfExists(target);
  if (info?.isSymbolicLink()) throw new ResearchProcessError('research_model_asset_symlink');
  if (info !== null && !info.isDirectory()) throw new ResearchProcessError('research_model_asset_path_invalid');
  if (info === null) await mkdir(target, { mode: 0o700 });
  return target;
}

async function downloadedBytes(root: string, assets: readonly ResearchModelAsset[]): Promise<number> {
  let total = 0;
  for (const asset of assets) {
    const installed = await inspectAsset(root, asset, false);
    if (installed.ready) {
      total += asset.bytes;
      continue;
    }
    const temporary = join(await safeDirectory(root, '.downloads'), `${asset.id}.bin`);
    const temporaryInfo = await lstatIfExists(temporary);
    if (temporaryInfo !== null) {
      if (temporaryInfo.isSymbolicLink() || !temporaryInfo.isFile()) throw new ResearchProcessError('research_model_asset_path_invalid');
      total += Math.min(temporaryInfo.size, asset.bytes);
      continue;
    }
    const parts = `${temporary}.parts`;
    const partsInfo = await lstatIfExists(parts);
    if (partsInfo === null) continue;
    if (partsInfo.isSymbolicLink() || !partsInfo.isDirectory()) throw new ResearchProcessError('research_model_asset_path_invalid');
    let partial = 0;
    for (const entry of await readdir(parts, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.part')) continue;
      const partPath = join(parts, entry.name);
      const partInfo = await lstatIfExists(partPath);
      if (partInfo?.isSymbolicLink()) throw new ResearchProcessError('research_model_asset_symlink');
      if (partInfo?.isFile()) partial += partInfo.size;
    }
    total += Math.min(asset.bytes, partial);
  }
  return Math.min(total, assets.reduce((sum, asset) => sum + asset.bytes, 0));
}

async function lstatIfExists(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function realpathDirectory(path: string): Promise<string> {
  let resolved: string;
  try { resolved = await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ResearchProcessError('research_model_import_missing');
    throw error;
  }
  const info = await lstat(resolved);
  if (!info.isDirectory()) throw new ResearchProcessError('research_model_import_invalid');
  return resolved;
}

function fileSignature(info: { dev: number; ino: number; size: number; mtimeMs: number }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}

function isAssetError(error: string | null): boolean {
  return error !== null && error !== 'research_model_asset_missing';
}

function isDownloadIntegrityError(error: unknown): boolean {
  const message = errorCode(error);
  return message.startsWith('research_download_hash_mismatch') || message === 'research_download_size_mismatch';
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const code = message.split(':', 1)[0];
  return /^research_[a-z_]+$/u.test(code) ? code : 'research_model_operation_failed';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ResearchProcessError('research_download_cancelled');
}

function isModelPack(value: unknown): value is ResearchModelPack {
  return value === 'compact' || value === 'complete';
}
