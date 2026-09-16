import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, rm, symlink, type FileHandle } from 'node:fs/promises';
import { dirname, join, posix as posixPath, resolve } from 'node:path';
import { createGunzip, crc32, deflateRawSync } from 'node:zlib';

const MAX_ARCHIVE_MEMBERS = 100_000;
const MAX_ARCHIVE_BYTES = 4 * 1024 ** 3;
const MAX_BUNDLE_BYTES = 4 * 1024 ** 3;
const MAX_BUNDLE_FILE = 512 * 1024 ** 2;
const MAX_BUNDLE_MEMBERS = 200_000;
const BLOCK = 512;
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const VERSION = 20;
const ZIP64_VERSION = 45;
const CREATE_SYSTEM = 3;
const EXTERNAL_ATTR = (0o100644 << 16) >>> 0;
const DEFLATE = 8;

type TarKind = 'file' | 'dir' | 'symlink';

type TarMember = {
  name: string;
  type: TarKind;
  size: number;
  mode: number;
  linkname: string;
  data: Buffer;
};

class ByteReader {
  private pending: Buffer = Buffer.alloc(0);
  private ended = false;
  private readonly source: AsyncIterator<Buffer>;
  constructor(source: AsyncIterator<Buffer>) {
    this.source = source;
  }

  async read(size: number): Promise<Buffer> {
    while (this.pending.length < size && !this.ended) {
      const next = await this.source.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      this.pending = this.pending.length === 0 ? next.value : Buffer.concat([this.pending, next.value]);
    }
    if (this.pending.length < size) fail('research_archive_entry_invalid');
    const chunk = this.pending.subarray(0, size);
    this.pending = this.pending.subarray(size);
    return chunk;
  }

  async skip(size: number): Promise<void> {
    let remaining = size;
    if (this.pending.length > 0) {
      const take = Math.min(remaining, this.pending.length);
      this.pending = this.pending.subarray(take);
      remaining -= take;
    }
    while (remaining > 0 && !this.ended) {
      const next = await this.source.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      if (next.value.length <= remaining) {
        remaining -= next.value.length;
        continue;
      }
      this.pending = next.value.subarray(remaining);
      remaining = 0;
    }
    if (remaining !== 0) fail('research_archive_entry_invalid');
  }
}

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

function parseOctal(buffer: Buffer): number {
  const text = buffer.toString('latin1').replace(/\0.*$/u, '').trim();
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isInteger(value) || value < 0) fail('research_archive_entry_invalid');
  return value;
}

function parseTarNumber(buffer: Buffer): number {
  if (buffer.length > 0 && (buffer[0] & 0x80) !== 0) {
    let value = BigInt(buffer[0] & 0x7f);
    for (let index = 1; index < buffer.length; index += 1) {
      value = (value << 8n) | BigInt(buffer[index]);
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('research_archive_too_large');
    return Number(value);
  }
  return parseOctal(buffer);
}

function tarChecksum(header: Buffer): number {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : header[index];
  }
  return sum;
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function paddedSize(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

function joinTarName(prefix: string, name: string): string {
  if (prefix === '') return name;
  if (name === '') return prefix;
  return `${prefix}/${name}`;
}

function parsePax(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  const text = data.toString('utf8');
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) fail('research_archive_entry_invalid');
    const length = Number(text.slice(offset, space));
    if (!Number.isInteger(length) || length < 1) fail('research_archive_entry_invalid');
    const record = text.slice(offset, offset + length);
    const body = record.slice(space - offset + 1).replace(/\n$/u, '');
    const eq = body.indexOf('=');
    if (eq === -1) fail('research_archive_entry_invalid');
    records[body.slice(0, eq)] = body.slice(eq + 1);
    offset += length;
  }
  return records;
}

function kindFromFlag(flag: string): TarKind | 'meta' | null {
  if (flag === '0' || flag === '\0' || flag === '7') return 'file';
  if (flag === '5') return 'dir';
  if (flag === '2') return 'symlink';
  if (flag === 'x' || flag === 'g' || flag === 'L' || flag === 'K') return 'meta';
  return null;
}

function posixName(name: string): string {
  return name.replace(/\/+$/u, '');
}

function assertSafeTarName(name: string): string {
  const normalized = posixName(name);
  if (normalized === '' || normalized.startsWith('/')
      || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    fail('research_archive_entry_invalid');
  }
  return normalized;
}

function fileMode(mode: number): number {
  let next = mode & 0o755;
  if ((next & 0o100) === 0) next &= ~0o111;
  return next | 0o600;
}

function assertInside(root: string, target: string, code: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}/`)) fail(code);
}

async function tarStream(path: string): Promise<AsyncIterable<Buffer>> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(2);
    const { bytesRead } = await handle.read(head, 0, 2, 0);
    const gzip = bytesRead === 2 && head[0] === 0x1f && head[1] === 0x8b;
    const stream = createReadStream(path);
    return gzip ? stream.pipe(createGunzip()) : stream;
  } finally {
    await handle.close();
  }
}

function parseHeader(block: Buffer): {
  kind: TarKind | 'meta';
  flag: string;
  name: string;
  prefix: string;
  size: number;
  mode: number;
  linkname: string;
} {
  const checksum = parseOctal(block.subarray(148, 156));
  if (tarChecksum(block) !== checksum) fail('research_archive_entry_invalid');
  const flag = block.subarray(156, 157).toString('latin1');
  const kind = kindFromFlag(flag);
  if (kind === null) fail('research_archive_entry_invalid');
  return {
    kind,
    flag,
    name: block.subarray(0, 100).toString('latin1').replace(/\0.*$/u, ''),
    prefix: block.subarray(345, 500).toString('latin1').replace(/\0.*$/u, ''),
    size: parseTarNumber(block.subarray(124, 136)),
    mode: parseOctal(block.subarray(100, 108)),
    linkname: block.subarray(157, 257).toString('latin1').replace(/\0.*$/u, '')
  };
}

async function readTarMembers(
  path: string,
  onMember: (member: TarMember) => Promise<void>,
  limits: { maxMembers: number; maxBytes: number; sanitize: boolean; tooLarge: string }
): Promise<void> {
  const reader = new ByteReader((await tarStream(path))[Symbol.asyncIterator]());
  let pendingPax: Record<string, string> | null = null;
  let longName: string | null = null;
  let longLink: string | null = null;
  let seenEnd = false;
  let count = 0;
  let total = 0;
  while (true) {
    const header = await reader.read(BLOCK).catch((error: unknown) => {
      if (seenEnd && error instanceof Error && error.message === 'research_archive_entry_invalid') return null;
      throw error;
    });
    if (header === null) break;
    if (isZeroBlock(header)) {
      if (seenEnd) break;
      seenEnd = true;
      continue;
    }
    seenEnd = false;
    const parsed = parseHeader(header);
    const data = parsed.size > 0 ? await reader.read(parsed.size) : Buffer.alloc(0);
    const padding = paddedSize(parsed.size) - parsed.size;
    if (padding > 0) await reader.skip(padding);
    if (parsed.flag === 'x') {
      pendingPax = parsePax(data);
      continue;
    }
    if (parsed.flag === 'g') continue;
    if (parsed.flag === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/u, '');
      continue;
    }
    if (parsed.flag === 'K') {
      longLink = data.toString('utf8').replace(/\0.*$/u, '');
      continue;
    }
    if (parsed.kind === 'meta') fail('research_archive_entry_invalid');
    let name = longName ?? joinTarName(parsed.prefix, parsed.name);
    let linkname = longLink ?? parsed.linkname;
    let size = parsed.kind === 'file' ? parsed.size : 0;
    longName = null;
    longLink = null;
    if (pendingPax !== null) {
      if (pendingPax.path !== undefined) name = pendingPax.path;
      if (pendingPax.linkpath !== undefined) linkname = pendingPax.linkpath;
      if (pendingPax.size !== undefined) {
        const next = Number(pendingPax.size);
        if (!Number.isInteger(next) || next < 0) fail('research_archive_entry_invalid');
        size = parsed.kind === 'file' ? next : 0;
      }
      pendingPax = null;
    }
    count += 1;
    total += size;
    if (count > limits.maxMembers || total > limits.maxBytes) fail(limits.tooLarge);
    await onMember({
      name: limits.sanitize ? assertSafeTarName(name) : name,
      type: parsed.kind,
      size,
      mode: parsed.mode,
      linkname,
      data: parsed.kind === 'file' ? data.subarray(0, size) : Buffer.alloc(0)
    });
  }
}

export async function extractToolArchive(archive: string, destination: string): Promise<void> {
  if (await pathInfo(destination) !== null) fail('research_archive_destination_exists');
  await mkdir(destination, { recursive: true });
  try {
    await readTarMembers(archive, async (member) => {
      const target = join(destination, ...member.name.split('/'));
      assertInside(destination, target, 'research_archive_entry_invalid');
      if (member.type === 'dir') {
        await mkdir(target, { recursive: true });
        return;
      }
      await mkdir(dirname(target), { recursive: true });
      if (member.type === 'symlink') {
        if (member.linkname === '' || posixPath.isAbsolute(member.linkname)) fail('research_archive_entry_invalid');
        const linkTarget = resolve(dirname(target), member.linkname);
        assertInside(destination, linkTarget, 'research_archive_link_outside');
        if (await pathInfo(target) !== null) fail('research_archive_entry_invalid');
        await symlink(member.linkname, target);
        return;
      }
      if (await pathInfo(target) !== null) fail('research_archive_entry_invalid');
      const handle = await open(target, 'wx', fileMode(member.mode));
      try {
        await handle.writeFile(member.data);
      } finally {
        await handle.close();
      }
    }, { maxMembers: MAX_ARCHIVE_MEMBERS, maxBytes: MAX_ARCHIVE_BYTES, sanitize: true, tooLarge: 'research_archive_too_large' });
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

function writeU16(target: Buffer, offset: number, value: number): void {
  target.writeUInt16LE(value, offset);
}

function writeU32(target: Buffer, offset: number, value: number): void {
  target.writeUInt32LE(value >>> 0, offset);
}

function writeU64(target: Buffer, offset: number, value: number): void {
  target.writeBigUInt64LE(BigInt(value), offset);
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 127) return false;
  }
  return true;
}

type ZipMember = {
  name: Buffer;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  zip64: boolean;
};

function zip64Extra(member: ZipMember, includeOffset: boolean): Buffer {
  const extra = Buffer.alloc(includeOffset ? 28 : 20);
  writeU16(extra, 0, 1);
  writeU16(extra, 2, includeOffset ? 24 : 16);
  writeU64(extra, 4, member.uncompressedSize);
  writeU64(extra, 12, member.compressedSize);
  if (includeOffset) writeU64(extra, 20, member.localOffset);
  return extra;
}

function localHeader(member: ZipMember): Buffer {
  const extra = member.zip64 ? zip64Extra(member, false) : Buffer.alloc(0);
  const header = Buffer.alloc(30 + member.name.length + extra.length);
  writeU32(header, 0, LOCAL_SIGNATURE);
  header[4] = member.zip64 ? ZIP64_VERSION : VERSION;
  header[5] = 0;
  writeU16(header, 6, member.flags);
  writeU16(header, 8, DEFLATE);
  writeU16(header, 10, DOS_TIME);
  writeU16(header, 12, DOS_DATE);
  writeU32(header, 14, member.crc);
  writeU32(header, 18, member.zip64 ? 0xffffffff : member.compressedSize);
  writeU32(header, 22, member.zip64 ? 0xffffffff : member.uncompressedSize);
  writeU16(header, 26, member.name.length);
  writeU16(header, 28, extra.length);
  member.name.copy(header, 30);
  extra.copy(header, 30 + member.name.length);
  return header;
}

function centralHeader(member: ZipMember): Buffer {
  const extra = member.zip64 ? zip64Extra(member, true) : Buffer.alloc(0);
  const header = Buffer.alloc(46 + member.name.length + extra.length);
  writeU32(header, 0, CENTRAL_SIGNATURE);
  header[4] = member.zip64 ? ZIP64_VERSION : VERSION;
  header[5] = CREATE_SYSTEM;
  header[6] = member.zip64 ? ZIP64_VERSION : VERSION;
  header[7] = 0;
  writeU16(header, 8, member.flags);
  writeU16(header, 10, DEFLATE);
  writeU16(header, 12, DOS_TIME);
  writeU16(header, 14, DOS_DATE);
  writeU32(header, 16, member.crc);
  writeU32(header, 20, member.zip64 ? 0xffffffff : member.compressedSize);
  writeU32(header, 24, member.zip64 ? 0xffffffff : member.uncompressedSize);
  writeU16(header, 28, member.name.length);
  writeU16(header, 30, extra.length);
  writeU16(header, 32, 0);
  writeU16(header, 34, 0);
  writeU16(header, 36, 0);
  writeU32(header, 38, EXTERNAL_ATTR);
  writeU32(header, 42, member.zip64 ? 0xffffffff : member.localOffset);
  member.name.copy(header, 46);
  extra.copy(header, 46 + member.name.length);
  return header;
}

function endRecords(count: number, size: number, offset: number): Buffer {
  const zip64 = count >= 0xffff || size >= 0xffffffff || offset >= 0xffffffff;
  const chunks: Buffer[] = [];
  if (zip64) {
    const eocd = Buffer.alloc(56);
    writeU32(eocd, 0, ZIP64_EOCD_SIGNATURE);
    writeU64(eocd, 4, 44);
    writeU16(eocd, 12, ZIP64_VERSION);
    writeU16(eocd, 14, ZIP64_VERSION);
    writeU32(eocd, 16, 0);
    writeU32(eocd, 20, 0);
    writeU64(eocd, 24, count);
    writeU64(eocd, 32, count);
    writeU64(eocd, 40, size);
    writeU64(eocd, 48, offset);
    const locator = Buffer.alloc(20);
    writeU32(locator, 0, ZIP64_LOCATOR_SIGNATURE);
    writeU32(locator, 4, 0);
    writeU64(locator, 8, offset + size);
    writeU32(locator, 16, 1);
    chunks.push(eocd, locator);
  }
  const eocd = Buffer.alloc(22);
  writeU32(eocd, 0, EOCD_SIGNATURE);
  writeU16(eocd, 4, 0);
  writeU16(eocd, 6, 0);
  writeU16(eocd, 8, Math.min(count, 0xffff));
  writeU16(eocd, 10, Math.min(count, 0xffff));
  writeU32(eocd, 12, Math.min(size, 0xffffffff));
  writeU32(eocd, 16, Math.min(offset, 0xffffffff));
  writeU16(eocd, 20, 0);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

async function writeAll(file: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await file.write(data, offset, data.length - offset);
    if (bytesWritten === 0) fail('research_tex_bundle_entry_invalid');
    offset += bytesWritten;
  }
}

function assertBundleName(name: string, names: Set<string>): void {
  if (name.includes('\\') || name.includes('/') || name === '' || name === '.' || name === '..' || names.has(name)) {
    fail('research_tex_bundle_entry_invalid');
  }
}

export async function convertTexBundle(source: string, destination: string): Promise<void> {
  if (await pathInfo(destination) !== null) fail('research_tex_bundle_destination_exists');
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), '.tex-bundle-'));
  try {
    const zipPath = join(staging, 'bundle.zip');
    const handle = await open(zipPath, 'wx');
    const members: ZipMember[] = [];
    const names = new Set<string>();
    let offset = 0;
    let total = 0;
    try {
      await readTarMembers(source, async (member) => {
        if (member.type !== 'file') fail('research_tex_bundle_entry_invalid');
        assertBundleName(member.name, names);
        names.add(member.name);
        total += member.size;
        if (total > MAX_BUNDLE_BYTES || member.size > MAX_BUNDLE_FILE || names.size >= MAX_BUNDLE_MEMBERS) {
          fail('research_tex_bundle_too_large');
        }
        const utf8 = !isAscii(member.name);
        const compressed = deflateRawSync(member.data, { level: 6 });
        const zip64 = member.data.length >= 0xffffffff || compressed.length >= 0xffffffff || offset >= 0xffffffff;
        const record: ZipMember = {
          name: Buffer.from(member.name, 'utf8'),
          flags: utf8 ? 0x800 : 0,
          crc: crc32(member.data),
          compressedSize: compressed.length,
          uncompressedSize: member.data.length,
          localOffset: offset,
          zip64
        };
        const header = localHeader(record);
        await writeAll(handle, header);
        await writeAll(handle, compressed);
        offset += header.length + compressed.length;
        members.push(record);
      }, { maxMembers: MAX_BUNDLE_MEMBERS, maxBytes: MAX_BUNDLE_BYTES, sanitize: false, tooLarge: 'research_tex_bundle_too_large' });
      if (!names.has('SHA256SUM') || !names.has('tectonic-format-latex.tex')) fail('research_tex_bundle_metadata_missing');
      const centralStart = offset;
      for (const member of members) {
        const header = centralHeader(member);
        await writeAll(handle, header);
        offset += header.length;
      }
      await writeAll(handle, endRecords(members.length, offset - centralStart, centralStart));
    } finally {
      await handle.close();
    }
    await link(zipPath, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
