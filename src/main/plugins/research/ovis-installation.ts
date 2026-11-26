import {hasUnprovenResearchProcessExit} from './process-exit-state';
import {constants} from 'node:fs';
import {copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {isAbsolute, join, relative, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {fileSha256} from '../../../../scripts/research/download-asset';
import runtimePin from '../../../../resources/research-runtime/python-tools.lock.json';
import sourcePin from '../../../../resources/ovis-ocr/prequantized.lock.json';
import {ovisDownloadAssets, withOvisDownloads, verifyOvisRequirementsFile, type OvisDownloadProgress} from './ovis-downloads';
import {installOvisPackages} from './ovis-package-installer';
import {inspectOvisInstallation, type OvisInstallationInspection} from './ovis-model-store';
import type {ManagedPythonRuntime} from './python-runtime-store';

type InventoryEntry = {type: 'file'; mode: number; size: number; sha256: string} |
  {type: 'directory'; mode: number} | {type: 'symlink'; mode: number; target: string};
const inside = (root: string, path: string): boolean => {
  const name = relative(root, path);
  return name === '' || !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`);
};
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function inventory(root: string, python: string, signal: AbortSignal): Promise<Record<string, InventoryEntry>> {
  const entries: Record<string, InventoryEntry> = {};
  let bytes = 0, count = 0;
  const visit = async (path: string): Promise<void> => {
    for (const name of (await readdir(path)).sort()) {
      signal.throwIfAborted();
      if (++count > 100_000) throw new Error('research_ovis_installation_inventory_limit');
      const child = join(path, name), key = relative(root, child).split(sep).join('/');
      const info = await lstat(child), mode = info.mode & 0o7777;
      if (info.isSymbolicLink()) {
        const target = await realpath(child);
        if (target !== python && !inside(root, target)) throw new Error('research_ovis_installation_link_escape');
        entries[key] = {type: 'symlink', mode, target: await readlink(child)};
      } else if (info.isDirectory()) {
        if (await realpath(child) !== child) throw new Error('research_ovis_installation_directory_invalid');
        entries[key] = {type: 'directory', mode}; await visit(child);
      } else if (info.isFile() && info.nlink === 1) {
        bytes += info.size;
        if (info.size > 2 * 1024 ** 3 || bytes > 6 * 1024 ** 3) throw new Error('research_ovis_installation_size_limit');
        const sha256 = await fileSha256(child, signal), after = await lstat(child);
        if (info.dev !== after.dev || info.ino !== after.ino || info.size !== after.size || info.mode !== after.mode ||
            info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw new Error('research_ovis_installation_changed');
        entries[key] = {type: 'file', mode, size: info.size, sha256};
      } else throw new Error('research_ovis_installation_file_invalid');
    }
  };
  await visit(root);
  return entries;
}

export type OvisInstallationProgress = {phase: 'creating_runtime' | 'installing_wheels' | 'verifying'} |
  OvisDownloadProgress;
export type OvisInstallationInput = {
  /** Caller serializes preparations and supplies the freshly verified managed interpreter. */
  runtime: ManagedPythonRuntime; parent: string; specification: string; projectId: string; signal: AbortSignal;
  onProgress?: (value: OvisInstallationProgress) => void;
};

/** A complete private generation is returned only after its receipt and all bytes verify.
 * The returned root/hash are the caller's trusted publication handle. Existing generations
 * are never updated or replaced. Quality qualification is intentionally separate. */
export async function prepareOvisInstallation(input: OvisInstallationInput,
  download?: Parameters<typeof withOvisDownloads>[2]): Promise<OvisInstallationInspection> {
  const {runtime, signal} = input;
  signal.throwIfAborted();
  for (const path of [input.parent, input.specification]) {
    const info = await lstat(path);
    if (!isAbsolute(path) || !info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
      throw new Error('research_ovis_installation_directory_invalid');
    }
  }
  if (inside(input.parent, runtime.prefix) || inside(runtime.prefix, input.parent) ||
      inside(input.parent, input.specification) || inside(input.specification, input.parent)) {
    throw new Error('research_ovis_installation_overlapping_paths');
  }
  await verifyOvisRequirementsFile(join(input.specification, 'requirements.lock'));
  const specification = new Map<string, {bytes: Buffer; sha256: string}>();
  for (const name of ['prequantized.lock.json', 'requirements.in', 'requirements.lock', 'parse.py']) {
    const path = join(input.specification, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 ** 2) {
      throw new Error('research_ovis_installation_spec_invalid');
    }
    const bytes = await readFile(path); specification.set(name, {bytes, sha256: hash(bytes)});
  }
  const root = await mkdtemp(join(input.parent, 'ovis-install-')), owner = await lstat(root);
  let completed = false, retain = false;
  try {
    const result = await withOvisDownloads({parent: input.parent, assets: ovisDownloadAssets(), signal,
      onProgress: input.onProgress}, async bundle => {
      const installed = await installOvisPackages({runtime, destination: root, wheelhouse: join(bundle.root, 'wheels'),
        requirements: join(input.specification, 'requirements.lock'), signal, projectId: input.projectId,
        onPhase: phase => input.onProgress?.({phase})});
      // The supervised installer has exited; its disposable uv cache is not part of the generation.
      await rm(join(root, 'scratch'), {recursive: true});
      // All source bytes belong to this transaction; the bundle no longer needs them.
      await rename(join(bundle.root, 'model-8bit'), join(root, 'model-8bit'));
      const spec = join(root, 'spec'); await mkdir(spec, {mode: 0o700});
      for (const [name, file] of specification) await writeFile(join(spec, name), file.bytes, {flag: 'wx', mode: 0o600});
      await mkdir(join(root, 'tools'), {mode: 0o700});
      await copyFile(runtime.uv, join(root, 'tools/uv'), constants.COPYFILE_EXCL);
      if (await fileSha256(join(root, 'tools/uv'), signal) !== runtimePin.uv.binarySha256) {
        throw new Error('research_ovis_installation_uv_changed');
      }
      signal.throwIfAborted();
      input.onProgress?.({phase: 'verifying'});
      const library = join(runtime.prefix, 'lib/libpython3.14.dylib');
      const libraryInfo = await lstat(library);
      if (!libraryInfo.isFile() || libraryInfo.isSymbolicLink() || libraryInfo.nlink !== 1) {
        throw new Error('research_ovis_installation_runtime_invalid');
      }
      const receipt = {schemaVersion: 2, status: 'installed', createdAt: new Date().toISOString(),
        python: {basePrefix: runtime.prefix, executable: runtime.executable, executableSha256: runtimePin.python.executable.sha256,
          sharedLibrary: library, sharedLibrarySha256: await fileSha256(library, signal),
          pythonVersion: runtime.version, implementation: 'cpython', machine: 'arm64', freeThreaded: false},
        managedRuntimeReceiptSha256: runtime.receiptHash, dependencies: installed.packages,
        specSha256: Object.fromEntries([...specification].map(([name, file]) => [name, file.sha256])),
        model: {repository: sourcePin.model.repository, revision: sourcePin.model.revision,
          quantization: sourcePin.model.quantization, visionDtype: sourcePin.model.visionDtype}, files: await inventory(root, runtime.executable, signal)};
      const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
      signal.throwIfAborted();
      await writeFile(join(root, 'receipt.json'), bytes, {flag: 'wx', mode: 0o600});
      const inspected = await inspectOvisInstallation({root, pythonBase: runtime.prefix,
        inferenceScript: join(spec, 'parse.py'), identity: {engine: 'ovisocr3-mlx', revision: sourcePin.model.revision as
          '702a71f233a208be050b12779ee29fdd1eb2dab3', quantization: '8bit', groupSize: 64, visionPrecision: 'bfloat16', device: 'metal',
          installationReceiptSha256: hash(bytes), inferenceSha256: specification.get('parse.py')!.sha256,
          promptSha256: '1b6139ec72888e087c8af75f2e2dfb78b425e15ae1c1529940b96137613d1db1'}}, signal);
      signal.throwIfAborted();
      return inspected;
    }, download);
    signal.throwIfAborted();
    completed = true;
    return result;
  } catch (error) {
    retain = hasUnprovenResearchProcessExit(error);
    if (retain && error instanceof Error) Object.assign(error, {retainedInstallation: root});
    throw error;
  } finally {
    if (!completed && !retain) {
      const current = await lstat(root);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino ||
          await realpath(root) !== root) throw new Error('research_ovis_installation_cleanup_identity_changed');
      await rm(root, {recursive: true});
    }
  }
}
