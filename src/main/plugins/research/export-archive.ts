import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { crc32, deflateRawSync } from 'node:zlib';
import type { ResearchExportFile } from '../../../shared/schemas/research-exports';
import { researchPath, researchRelativePath } from './research-files';

export const exportFileLimit = 64 * 1024 * 1024;
export const exportTotalLimit = 512 * 1024 * 1024;
export const exportArchiveLimit = 600 * 1024 * 1024;

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const VERSION = 20;
const CREATE_SYSTEM = 3;
const EXTERNAL_ATTR = (0o100444 << 16) >>> 0;
const DEFLATE = 8;

type ZipMember = {
  name: Buffer;
  flags: number;
  crc: number;
  compressed: Buffer;
  uncompressedSize: number;
  localOffset: number;
};

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 127) return false;
  }
  return true;
}

function writeU16(target: Buffer, offset: number, value: number): void {
  target.writeUInt16LE(value, offset);
}

function writeU32(target: Buffer, offset: number, value: number): void {
  target.writeUInt32LE(value >>> 0, offset);
}

function localHeader(member: ZipMember): Buffer {
  const header = Buffer.alloc(30 + member.name.length);
  writeU32(header, 0, LOCAL_SIGNATURE);
  header[4] = VERSION;
  header[5] = 0;
  writeU16(header, 6, member.flags);
  writeU16(header, 8, DEFLATE);
  writeU16(header, 10, DOS_TIME);
  writeU16(header, 12, DOS_DATE);
  writeU32(header, 14, member.crc);
  writeU32(header, 18, member.compressed.length);
  writeU32(header, 22, member.uncompressedSize);
  writeU16(header, 26, member.name.length);
  writeU16(header, 28, 0);
  member.name.copy(header, 30);
  return header;
}

function centralHeader(member: ZipMember): Buffer {
  const header = Buffer.alloc(46 + member.name.length);
  writeU32(header, 0, CENTRAL_SIGNATURE);
  header[4] = VERSION;
  header[5] = CREATE_SYSTEM;
  header[6] = VERSION;
  header[7] = 0;
  writeU16(header, 8, member.flags);
  writeU16(header, 10, DEFLATE);
  writeU16(header, 12, DOS_TIME);
  writeU16(header, 14, DOS_DATE);
  writeU32(header, 16, member.crc);
  writeU32(header, 20, member.compressed.length);
  writeU32(header, 24, member.uncompressedSize);
  writeU16(header, 28, member.name.length);
  writeU16(header, 30, 0);
  writeU16(header, 32, 0);
  writeU16(header, 34, 0);
  writeU16(header, 36, 0);
  writeU32(header, 38, EXTERNAL_ATTR);
  writeU32(header, 42, member.localOffset);
  member.name.copy(header, 46);
  return header;
}

function endOfCentralDirectory(count: number, size: number, offset: number): Buffer {
  const header = Buffer.alloc(22);
  writeU32(header, 0, EOCD_SIGNATURE);
  writeU16(header, 4, 0);
  writeU16(header, 6, 0);
  writeU16(header, 8, count);
  writeU16(header, 10, count);
  writeU32(header, 12, size);
  writeU32(header, 16, offset);
  writeU16(header, 20, 0);
  return header;
}

async function readBundleFile(root: string, entry: ResearchExportFile): Promise<Buffer> {
  const path = await researchPath(root, entry.path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > exportFileLimit || before.size !== entry.size) {
      throw new Error('research_export_snapshot_changed');
    }
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await file.stat();
    const data = bytes.subarray(0, offset);
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || data.length !== entry.size || createHash('sha256').update(data).digest('hex') !== entry.sha256) {
      throw new Error('research_export_snapshot_changed');
    }
    return data;
  } finally {
    await file.close();
  }
}

export function buildExportZip(entries: Array<{ path: string; data: Buffer }>): Buffer {
  const members: ZipMember[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const utf8 = !isAscii(entry.path);
    const member: ZipMember = {
      name: Buffer.from(entry.path, 'utf8'),
      flags: utf8 ? 0x800 : 0,
      crc: crc32(entry.data),
      compressed: deflateRawSync(entry.data, { level: 6 }),
      uncompressedSize: entry.data.length,
      localOffset: offset
    };
    const header = localHeader(member);
    chunks.push(header, member.compressed);
    offset += header.length + member.compressed.length;
    members.push(member);
  }
  const centralStart = offset;
  for (const member of members) {
    const header = centralHeader(member);
    chunks.push(header);
    offset += header.length;
  }
  chunks.push(endOfCentralDirectory(members.length, offset - centralStart, centralStart));
  return Buffer.concat(chunks);
}

export async function createExportZipArchive(
  root: string,
  destination: string,
  entries: readonly ResearchExportFile[],
  signal: AbortSignal
): Promise<{ sha256: string; size: number }> {
  if (entries.length === 0 || entries.length > 10000) throw new Error('research_export_file_limit');
  const seen = new Set<string>();
  const files: Array<{ path: string; data: Buffer }> = [];
  let total = 0;
  for (const entry of entries) {
    signal.throwIfAborted();
    const path = researchRelativePath(entry.path);
    if (seen.has(path)) throw new Error('research_export_path_invalid');
    seen.add(path);
    const data = await readBundleFile(root, { ...entry, path });
    total += data.length;
    if (total > exportTotalLimit) throw new Error('research_export_file_limit');
    files.push({ path, data });
  }
  const zip = buildExportZip(files);
  if (zip.length > exportArchiveLimit) throw new Error('research_export_file_limit');
  const handle = await open(destination, 'wx', 0o400);
  try {
    await handle.writeFile(zip);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await handle.close();
  return { sha256: createHash('sha256').update(zip).digest('hex'), size: zip.length };
}
