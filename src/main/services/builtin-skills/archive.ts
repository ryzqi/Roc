import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzipSync } from 'node:zlib';

const gunzipAsync = promisify(gunzip);

/**
 * Minimal tar reader for GitHub's `codeload` archives.
 *
 * Roc has no zip/tar dependency and the built-in skill sync must not add one, so this walks the
 * ustar/PAX headers directly. Only regular files and directories are materialised: symlinks and
 * hardlinks are skipped because the vendored repositories use symlinks for intra-repo aliases
 * (`skills/<id> -> ../<id>`) that are resolved from the real directories instead.
 *
 * Limits are deliberate: a downloaded archive is untrusted input, so entry count and total
 * extracted bytes are bounded and every path is resolved inside the destination root.
 */

export type ArchiveLimits = {
  maxEntries: number;
  maxTotalBytes: number;
};

const defaultArchiveLimits: ArchiveLimits = {
  maxEntries: 60_000,
  maxTotalBytes: 1_024 * 1024 * 1024
};

const blockSize = 512;

type TarHeader = {
  path: string;
  size: number;
  type: string;
  mode: number;
};

export async function extractTarGz(
  archive: Buffer,
  destination: string,
  options: { filter?: (path: string) => boolean; limits?: ArchiveLimits; stripTopLevel?: boolean } = {}
): Promise<number> {
  const tar = await gunzipAsync(archive);
  const limits = options.limits ?? defaultArchiveLimits;
  const root = resolve(destination);
  mkdirSync(root, { recursive: true });

  let offset = 0;
  let entries = 0;
  let totalBytes = 0;
  let pendingLongPath: string | null = null;
  const paxOverrides = new Map<string, string>();

  while (offset + blockSize <= tar.length) {
    const header = readHeader(tar, offset);
    if (header === null) {
      // Two consecutive zero blocks terminate the archive; a single one is padding.
      break;
    }
    offset += blockSize;

    const dataBlocks = header.size === 0 ? 0 : Math.ceil(header.size / blockSize);
    const dataStart = offset;
    offset += dataBlocks * blockSize;

    if (header.type === 'x' || header.type === 'X') {
      const payload = tar.subarray(dataStart, dataStart + header.size).toString('utf8');
      for (const [key, value] of parsePax(payload)) {
        paxOverrides.set(key, value);
      }
      continue;
    }
    if (header.type === 'g') {
      continue;
    }
    if (header.type === 'L') {
      pendingLongPath = readString(tar.subarray(dataStart, dataStart + header.size));
      continue;
    }

    const rawPath = pendingLongPath ?? paxOverrides.get('path') ?? header.path;
    const sizeOverride = paxOverrides.get('size');
    const size = sizeOverride === undefined ? header.size : Number.parseInt(sizeOverride, 10);
    pendingLongPath = null;
    paxOverrides.clear();

    if (rawPath.length === 0 || Number.isNaN(size) || size < 0) {
      continue;
    }

    const normalized = normalizeArchivePath(rawPath);
    if (normalized === null) {
      continue;
    }
    if (options.filter !== undefined && !options.filter(normalized)) {
      continue;
    }
    const relativePath = options.stripTopLevel === true ? stripArchivePrefix(normalized) : normalized;
    if (relativePath.length === 0) {
      continue;
    }

    entries += 1;
    if (entries > limits.maxEntries) {
      throw new Error(`builtin_skills_archive_too_many_entries:${limits.maxEntries}`);
    }

    if (header.type === '5') {
      mkdirSync(join(root, relativePath), { recursive: true });
      continue;
    }
    if (header.type !== '0' && header.type !== '\u0000' && header.type !== '7') {
      // Symlink / hardlink / device / fifo: not part of a materialised skill tree.
      continue;
    }

    totalBytes += size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(`builtin_skills_archive_too_large:${limits.maxTotalBytes}`);
    }

    const target = resolve(root, relativePath);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`builtin_skills_archive_path_escape:${rawPath}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, tar.subarray(dataStart, dataStart + size), {
      mode: header.mode === 0 ? 0o644 : header.mode & 0o777
    });
  }

  return entries;
}

function readHeader(tar: Buffer, offset: number): TarHeader | null {
  const block = tar.subarray(offset, offset + blockSize);
  if (block.length < blockSize) {
    return null;
  }
  if (block.every((byte) => byte === 0)) {
    return null;
  }
  const name = readString(block.subarray(0, 100));
  const mode = readOctal(block.subarray(100, 108));
  const size = readOctal(block.subarray(124, 136));
  const type = String.fromCharCode(block[156] ?? 0);
  const prefix = readString(block.subarray(345, 500));
  const path = prefix.length === 0 ? name : `${prefix}/${name}`;
  if (path.length === 0) {
    return null;
  }
  return {
    path,
    size,
    type,
    mode
  };
}

function readString(buffer: Buffer): string {
  const end = buffer.indexOf(0);
  const slice = end === -1 ? buffer : buffer.subarray(0, end);
  return slice.toString('utf8').trim();
}

function readOctal(buffer: Buffer): number {
  const text = readString(buffer);
  if (text.length === 0) {
    return 0;
  }
  const parsed = Number.parseInt(text, 8);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parsePax(payload: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  let cursor = 0;
  while (cursor < payload.length) {
    const space = payload.indexOf(' ', cursor);
    if (space === -1) {
      break;
    }
    const length = Number.parseInt(payload.slice(cursor, space), 10);
    if (Number.isNaN(length) || length <= 0) {
      break;
    }
    const record = payload.slice(space + 1, cursor + length - 1);
    const equals = record.indexOf('=');
    if (equals > 0) {
      entries.push([record.slice(0, equals), record.slice(equals + 1)]);
    }
    cursor += length;
  }
  return entries;
}

function normalizeArchivePath(path: string): string | null {
  const replaced = path.replaceAll('\\', '/');
  const parts: string[] = [];
  for (const part of replaced.split('/')) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join('/');
}

/** Strips the single top-level directory `codeload` archives wrap the repository in. */
export function stripArchivePrefix(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? '' : path.slice(slash + 1);
}

/**
 * Writes a deterministic `.tar.gz` of a directory tree.
 *
 * The bundled snapshot is shipped as an archive rather than a source tree: upstream repositories
 * contain their own Python/JS tooling, and vendoring it as loose files would drag third-party lint
 * and type errors into Roc's workspace scans. The archive is opaque to analysis while still being
 * a byte-for-byte copy that the installer extracts and verifies by sha256.
 */
export function createTarGz(sourceDir: string): Buffer {
  const entries: Array<{ path: string; data: Buffer; mode: number }> = [];
  collectFiles(sourceDir, '', entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));

  const blocks: Buffer[] = [];
  for (const entry of entries) {
    writeEntry(blocks, entry.path, entry.data, entry.mode);
  }
  blocks.push(Buffer.alloc(blockSize * 2));
  return gzipSync(Buffer.concat(blocks));
}

function collectFiles(
  root: string,
  relative: string,
  out: Array<{ path: string; data: Buffer; mode: number }>
): void {
  const absolute = relative.length === 0 ? root : join(root, relative);
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const childRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      collectFiles(root, childRelative, out);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    out.push({
      path: childRelative,
      data: readFileSync(join(root, childRelative)),
      mode: 0o644
    });
  }
}

function writeEntry(blocks: Buffer[], path: string, data: Buffer, mode: number): void {
  const header = Buffer.alloc(blockSize);
  const long = Buffer.byteLength(path) > 100;
  const { name, prefix } = long ? { name: '', prefix: '' } : splitUstarPath(path);
  if (long) {
    const payload = paxRecord('path', path);
    const paxHeader = Buffer.alloc(blockSize);
    writeString(paxHeader, 0, 100, 'PaxHeader');
    writeOctal(paxHeader, 100, 8, 0o644);
    writeOctal(paxHeader, 108, 8, 0);
    writeOctal(paxHeader, 116, 8, 0);
    writeOctal(paxHeader, 124, 12, payload.length);
    writeOctal(paxHeader, 136, 12, 0);
    paxHeader[156] = 'x'.charCodeAt(0);
    writeString(paxHeader, 257, 6, 'ustar');
    writeString(paxHeader, 263, 2, '00');
    writeChecksum(paxHeader);
    blocks.push(paxHeader, payload);
    padToBlock(blocks, payload.length);
  }
  writeString(header, 0, 100, long ? path.slice(0, 100) : name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, 0);
  header[156] = '0'.charCodeAt(0);
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  if (!long) {
    writeString(header, 345, 155, prefix);
  }
  writeChecksum(header);
  blocks.push(header, data);
  padToBlock(blocks, data.length);
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) {
    return { name: path, prefix: '' };
  }
  const parts = path.split('/');
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const prefix = parts.slice(0, index).join('/');
    const name = parts.slice(index).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  return { name: path, prefix: '' };
}

function paxRecord(key: string, value: string): Buffer {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 3;
  while (String(length).length + 1 + Buffer.byteLength(body) !== length) {
    length = String(length).length + 1 + Buffer.byteLength(body);
  }
  return Buffer.from(`${length} ${body}`, 'utf8');
}

function padToBlock(blocks: Buffer[], size: number): void {
  const remainder = size % blockSize;
  if (remainder !== 0) {
    blocks.push(Buffer.alloc(blockSize - remainder));
  }
}

function writeString(target: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value, 'utf8').subarray(0, length);
  encoded.copy(target, offset);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  writeString(target, offset, length, `${text}\u0000`);
}

function writeChecksum(header: Buffer): void {
  header.fill(' '.charCodeAt(0), 148, 156);
  let sum = 0;
  for (const byte of header) {
    sum += byte;
  }
  writeString(header, 148, 8, `${sum.toString(8).padStart(6, '0')}\u0000 `);
}
