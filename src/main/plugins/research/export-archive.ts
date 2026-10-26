import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, unlink, type FileHandle } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createDeflateRaw } from 'node:zlib';
import type { ResearchExportFile } from '../../../shared/schemas/research-exports';
import { researchPath, researchRelativePath } from './research-files';

export const exportFileLimit = 64 * 1024 * 1024;
export const exportTotalLimit = 512 * 1024 * 1024;
export const exportArchiveLimit = 600 * 1024 * 1024;

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const VERSION = 20;
const CREATE_SYSTEM = 3;
const EXTERNAL_ATTR = (0o100444 << 16) >>> 0;
const DEFLATE = 8;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const UTF8_FLAG = 0x0800;

type ZipMember = {
  name: Buffer;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

type ArchiveWriter = {
  handle: FileHandle;
  hash: ReturnType<typeof createHash>;
  size: number;
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
  writeU32(header, 14, 0);
  writeU32(header, 18, 0);
  writeU32(header, 22, 0);
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
  writeU32(header, 20, member.compressedSize);
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

function dataDescriptor(member: ZipMember): Buffer {
  const descriptor = Buffer.alloc(16);
  writeU32(descriptor, 0, DATA_DESCRIPTOR_SIGNATURE);
  writeU32(descriptor, 4, member.crc);
  writeU32(descriptor, 8, member.compressedSize);
  writeU32(descriptor, 12, member.uncompressedSize);
  return descriptor;
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

async function writeAll(handle: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, null);
    if (bytesWritten === 0) throw new Error('research_export_archive_write_failed');
    offset += bytesWritten;
  }
}

async function writeArchiveChunk(writer: ArchiveWriter, data: Buffer, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (writer.size + data.length > exportArchiveLimit) throw new Error('research_export_file_limit');
  if (data.length === 0) return;
  await writeAll(writer.handle, data);
  writer.hash.update(data);
  writer.size += data.length;
}

async function writeBundleMember(
  writer: ArchiveWriter,
  root: string,
  entry: ResearchExportFile,
  member: ZipMember,
  signal: AbortSignal
): Promise<void> {
  const path = await researchPath(root, entry.path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > exportFileLimit || before.size !== entry.size) {
      throw new Error('research_export_snapshot_changed');
    }

    const sourceHash = createHash('sha256');
    let crc = 0;
    let uncompressedSize = 0;
    const validator = new Transform({
      transform(chunk, _encoding, callback) {
        try {
          signal.throwIfAborted();
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          uncompressedSize += data.length;
          if (uncompressedSize > before.size || uncompressedSize > exportFileLimit) {
            callback(new Error('research_export_snapshot_changed'));
            return;
          }
          sourceHash.update(data);
          crc = crc32(data, crc);
          callback(null, data);
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    const compressor = createDeflateRaw({ level: 6 });
    const input = file.createReadStream({ autoClose: false });
    let pipelineFailed = false;
    let pipelineError: unknown;
    const pipelineCompletion = pipeline(input, validator, compressor, { signal }).catch((error: unknown) => {
      pipelineFailed = true;
      pipelineError = error;
    });
    let outputError: unknown;
    try {
      for await (const chunk of compressor) {
        signal.throwIfAborted();
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        member.compressedSize += data.length;
        await writeArchiveChunk(writer, data, signal);
      }
    } catch (error) {
      outputError = error;
      compressor.destroy();
    }
    await pipelineCompletion;
    if (outputError !== undefined) throw outputError;
    if (pipelineFailed) throw pipelineError;

    signal.throwIfAborted();
    const after = await file.stat();
    if (uncompressedSize !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || uncompressedSize !== entry.size || sourceHash.digest('hex') !== entry.sha256) {
      throw new Error('research_export_snapshot_changed');
    }
    member.crc = crc >>> 0;
    member.uncompressedSize = uncompressedSize;
  } finally {
    await file.close();
  }
}

export async function createExportZipArchive(
  root: string,
  destination: string,
  entries: readonly ResearchExportFile[],
  signal: AbortSignal
): Promise<{ sha256: string; size: number }> {
  if (entries.length === 0 || entries.length > 10000) throw new Error('research_export_file_limit');
  const seen = new Set<string>();
  const files: ResearchExportFile[] = [];
  let total = 0;
  for (const entry of entries) {
    signal.throwIfAborted();
    const path = researchRelativePath(entry.path);
    if (seen.has(path)) throw new Error('research_export_path_invalid');
    seen.add(path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > exportFileLimit) {
      throw new Error('research_export_snapshot_changed');
    }
    total += entry.size;
    if (total > exportTotalLimit) throw new Error('research_export_file_limit');
    files.push({ ...entry, path });
  }

  const handle = await open(destination, 'wx', 0o400);
  let createdIdentity: { dev: number; ino: number } | null = null;
  try {
    const createdStat = await handle.stat();
    createdIdentity = { dev: createdStat.dev, ino: createdStat.ino };
    const writer: ArchiveWriter = { handle, hash: createHash('sha256'), size: 0 };
    const members: ZipMember[] = [];

    for (const entry of files) {
      signal.throwIfAborted();
      const utf8 = !isAscii(entry.path);
      const member: ZipMember = {
        name: Buffer.from(entry.path, 'utf8'),
        flags: (utf8 ? UTF8_FLAG : 0) | DATA_DESCRIPTOR_FLAG,
        crc: 0,
        compressedSize: 0,
        uncompressedSize: 0,
        localOffset: writer.size
      };
      await writeArchiveChunk(writer, localHeader(member), signal);
      await writeBundleMember(writer, root, entry, member, signal);
      await writeArchiveChunk(writer, dataDescriptor(member), signal);
      members.push(member);
    }

    const centralStart = writer.size;
    for (const member of members) await writeArchiveChunk(writer, centralHeader(member), signal);
    await writeArchiveChunk(writer, endOfCentralDirectory(members.length, writer.size - centralStart, centralStart), signal);
    const result = { sha256: writer.hash.digest('hex'), size: writer.size };
    await handle.close();
    return result;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    await handle.close().catch((closeError: unknown) => cleanupErrors.push(closeError));
    if (createdIdentity === null) {
      cleanupErrors.push(new Error('research_export_archive_cleanup_identity_unavailable'));
    } else {
      try {
        const current = await lstat(destination);
        if (current.dev === createdIdentity.dev && current.ino === createdIdentity.ino) await unlink(destination);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'research_export_archive_cleanup_failed', { cause: error });
    }
    throw error;
  }
}
