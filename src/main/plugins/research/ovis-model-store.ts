import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {lstat, readFile, readdir, readlink, realpath} from 'node:fs/promises';
import {isAbsolute, join, relative, sep} from 'node:path';
import {z} from 'zod';
import {ovisModelIdentitySchema} from '../../../shared/schemas/research-ovis';
import type {OvisWorkerInstallation} from './ovis-worker';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const mode = z.number().int().min(0).max(0o7777);
const entrySchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('file'), mode, size: z.number().int().nonnegative(), sha256: digest}).strict(),
  z.object({type: z.literal('directory'), mode}).strict(),
  z.object({type: z.literal('symlink'), mode, target: z.string().min(1)}).strict()
]);
const receiptSchema = z.object({schemaVersion: z.literal(1), status: z.literal('converted-unvalidated'),
  python: z.object({basePrefix: z.string(), executable: z.string(), executableSha256: digest,
    sharedLibrary: z.string(), sharedLibrarySha256: digest, pythonVersion: z.literal('3.14.10'),
    implementation: z.literal('cpython'), machine: z.literal('arm64'), freeThreaded: z.literal(false)}),
  dependencies: z.record(z.string(), z.string()),
  conversion: z.object({quantization: z.object({bits: z.literal(8), group_size: z.literal(64), mode: z.literal('affine')}),
    visionDtype: z.literal('bfloat16'), visionTensors: z.number().int().positive(), quantizedLanguageModules: z.number().int().positive()}),
  files: z.record(z.string(), entrySchema)
});
const sameFile = (before: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>>): boolean =>
  before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
  before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.mode === after.mode;

async function verifyFile(path: string, sha256: string, signal: AbortSignal, size?: number): Promise<number> {
  signal.throwIfAborted();
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (size !== undefined && before.size !== size)) {
    throw new Error('research_ovis_installation_file_invalid');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, {signal, highWaterMark: 1024 * 1024})) hash.update(chunk);
  if (hash.digest('hex') !== sha256 || !sameFile(before, await lstat(path))) throw new Error('research_ovis_installation_changed');
  return before.size;
}

export type OvisInstallationInspection = {installation: OvisWorkerInstallation; entries: number; bytes: number;
  /** Integrity is separate from the full-cohort quality/release gate. */
  qualityQualified: false};

/** The expected receipt hash must come from a trusted preparation transaction, never from the inspected directory itself. */
export async function inspectOvisInstallation(input: OvisWorkerInstallation, signal: AbortSignal): Promise<OvisInstallationInspection> {
  const identity = ovisModelIdentitySchema.parse(input.identity);
  signal.throwIfAborted();
  if (!isAbsolute(input.root) || !isAbsolute(input.pythonBase) || !isAbsolute(input.inferenceScript)) {
    throw new Error('research_ovis_absolute_path_required');
  }
  const rootInfo = await lstat(input.root), root = await realpath(input.root), pythonBase = await realpath(input.pythonBase);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('research_ovis_installation_directory_invalid');
  const receiptPath = join(root, 'receipt.json');
  const receiptSize = (await lstat(receiptPath)).size;
  if (receiptSize > 16 * 1024 ** 2) throw new Error('research_ovis_installation_receipt_limit');
  await verifyFile(receiptPath, identity.installationReceiptSha256, signal, receiptSize);
  const bytes = await readFile(receiptPath);
  if (createHash('sha256').update(bytes).digest('hex') !== identity.installationReceiptSha256) {
    throw new Error('research_ovis_installation_changed');
  }
  const receipt = receiptSchema.parse(JSON.parse(bytes.toString('utf8')));
  const names = Object.keys(receipt.files), roots = new Set(names.map(name => name.split('/')[0]));
  if (names.length === 0 || names.length > 100_000 || ['model-8bit', 'runtime', 'source', 'spec', 'tools'].some(name => !roots.has(name)) ||
      roots.size !== 5 || names.some(name => name.split('/').some(part => !part || part === '.' || part === '..') ||
        isAbsolute(name) || name.includes('\\') || /[\u0000-\u001f]/u.test(name))) {
    throw new Error('research_ovis_installation_inventory_invalid');
  }
  if (await realpath(receipt.python.basePrefix) !== pythonBase || receipt.dependencies.mlx !== '0.32.5' ||
      receipt.dependencies['mlx-vlm'] !== '0.8.1') throw new Error('research_ovis_installation_runtime_invalid');
  const python = await realpath(receipt.python.executable);
  const inBase = (path: string): boolean => {const name = relative(pythonBase, path);
    return name !== '' && !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`);};
  if (!inBase(python) || !inBase(await realpath(receipt.python.sharedLibrary))) throw new Error('research_ovis_installation_runtime_invalid');
  await verifyFile(python, receipt.python.executableSha256, signal);
  await verifyFile(receipt.python.sharedLibrary, receipt.python.sharedLibrarySha256, signal);
  await verifyFile(input.inferenceScript, identity.inferenceSha256, signal);
  let installedBytes = 0;
  const seen = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    signal.throwIfAborted();
    for (const name of (await readdir(directory)).sort()) {
      if (directory === root && name === 'receipt.json') continue;
      const path = join(directory, name), key = relative(root, path).split(sep).join('/'), expected = receipt.files[key];
      if (!expected || seen.size >= 100_000) throw new Error('research_ovis_installation_inventory_changed');
      seen.add(key);
      const info = await lstat(path);
      if ((info.mode & 0o7777) !== expected.mode) throw new Error('research_ovis_installation_mode_changed');
      if (expected.type === 'symlink') {
        if (!info.isSymbolicLink() || await readlink(path) !== expected.target) throw new Error('research_ovis_installation_link_changed');
        const target = await realpath(path), name = relative(root, target);
        if (target !== python && (name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name))) {
          throw new Error('research_ovis_installation_link_escape');
        }
      } else if (expected.type === 'directory') {
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('research_ovis_installation_directory_invalid');
        await visit(path);
      } else {
        if (expected.size > 2 * 1024 ** 3 || installedBytes + expected.size > 6 * 1024 ** 3) {
          throw new Error('research_ovis_installation_size_limit');
        }
        installedBytes += await verifyFile(path, expected.sha256, signal, expected.size);
      }
    }
  };
  await visit(root);
  if (seen.size !== names.length) throw new Error('research_ovis_installation_inventory_changed');
  await verifyFile(receiptPath, identity.installationReceiptSha256, signal, receiptSize);
  const manifest = JSON.parse((await readFile(join(root, 'spec/manifest.json'))).toString('utf8'));
  if (manifest.model?.revision !== identity.revision) throw new Error('research_ovis_installation_model_invalid');
  return {installation: {root, pythonBase, inferenceScript: await realpath(input.inferenceScript), identity},
    entries: seen.size, bytes: installedBytes, qualityQualified: false};
}

/** Tracks active acquisitions without loading MLX. Mutations must check leases before touching installed bytes. */
export class OvisModelStore {
  private leases = 0;
  constructor(private readonly installation: OvisWorkerInstallation) {}

  get busy(): boolean {return this.leases !== 0;}

  async acquire(signal: AbortSignal): Promise<OvisInstallationInspection & {release: () => void}> {
    this.leases++;
    let released = false;
    const release = (): void => {if (!released) {released = true; this.leases--;}};
    try {return {...await inspectOvisInstallation(this.installation, signal), release};}
    catch (error) {release(); throw error;}
  }
}
