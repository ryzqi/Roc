import { lstat, open, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fileSha256 } from './download-asset.ts';
import { decodeJson } from '../lib/decode-json.ts';

export type ManifestFileEntry = {
  path: string;
  type: 'file';
  size: number;
  sha256: string;
  executable: boolean;
};

export type ManifestSymlinkEntry = {
  path: string;
  type: 'symlink';
  target: string;
};

export type ManifestEntry = ManifestFileEntry | ManifestSymlinkEntry;

export type Manifest = {
  schemaVersion: 1;
  platform: 'darwin';
  architecture: string;
  versions: Record<string, string>;
  lockHashes: Record<string, string>;
  entries: ManifestEntry[];
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

function assertInside(root: string, target: string, relativePath: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) {
    fail(`research_toolchain_external_symlink:${relativePath}`);
  }
}

async function collect(root: string, directory: string, entries: Array<{ path: string; full: string }>): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    const relativePath = relative(root, full).split(sep).join('/');
    if (relativePath === 'manifest.json') continue;
    entries.push({ path: relativePath, full });
    if (entry.isDirectory() && !entry.isSymbolicLink()) await collect(root, full, entries);
  }
}

export async function inventory(rootPath: string): Promise<ManifestEntry[]> {
  const root = await realpath(rootPath);
  const found: Array<{ path: string; full: string }> = [];
  await collect(root, root, found);
  found.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const entries: ManifestEntry[] = [];
  for (const item of found) {
    const info = await lstat(item.full);
    if (info.isSymbolicLink()) {
      const target = await readlink(item.full);
      if (isAbsolute(target)) fail(`research_toolchain_external_symlink:${item.path}`);
      assertInside(root, await realpath(item.full), item.path);
      entries.push({ path: item.path, type: 'symlink', target });
      continue;
    }
    if (info.isFile()) {
      entries.push({
        path: item.path,
        type: 'file',
        size: info.size,
        sha256: await fileSha256(item.full),
        executable: (info.mode & 0o100) !== 0
      });
      continue;
    }
    if (!info.isDirectory()) fail(`research_toolchain_file_type_invalid:${item.path}`);
  }
  return entries;
}

export async function writeManifest(
  root: string,
  options: { architecture: string; versions: Record<string, string>; lockHashes: Record<string, string> }
): Promise<Manifest> {
  const manifest: Manifest = {
    schemaVersion: 1,
    platform: 'darwin',
    architecture: options.architecture,
    versions: options.versions,
    lockHashes: options.lockHashes,
    entries: await inventory(root)
  };
  const handle = await open(join(root, 'manifest.json'), 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  return manifest;
}

function sameEntry(left: ManifestEntry, right: unknown): boolean {
  if (typeof right !== 'object' || right === null) return false;
  const entry = right as ManifestEntry;
  if (left.path !== entry.path || left.type !== entry.type) return false;
  if (left.type === 'symlink') return entry.type === 'symlink' && left.target === entry.target;
  return entry.type === 'file' && left.size === entry.size && left.sha256 === entry.sha256 && left.executable === entry.executable;
}

function sameEntries(actual: ManifestEntry[], recorded: unknown): boolean {
  if (!Array.isArray(recorded) || recorded.length !== actual.length) return false;
  return actual.every((entry, index) => sameEntry(entry, recorded[index]));
}

export async function verifyManifest(root: string): Promise<Manifest> {
  const marker = join(root, 'manifest.json');
  if ((await pathInfo(marker))?.isSymbolicLink()) fail('research_toolchain_manifest_symlink');
  const manifest = decodeJson<Manifest>(await readFile(marker, 'utf8'), 'research_toolchain_manifest_corrupt');
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'darwin'
      || (manifest.architecture !== 'arm64' && manifest.architecture !== 'x64')) {
    fail('research_toolchain_manifest_invalid');
  }
  if (!sameEntries(await inventory(root), manifest.entries)) fail('research_toolchain_integrity_mismatch');
  return manifest;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { root: { type: 'string' } }, strict: true });
  if (values.root === undefined || values.root === '') fail('research_toolchain_root_required');
  const result = await verifyManifest(values.root);
  console.log(`科研工具链校验通过：${result.architecture}，${result.entries.length} 个文件或链接`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
