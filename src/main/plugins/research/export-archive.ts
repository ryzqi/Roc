import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, unlink, type FileHandle } from 'node:fs/promises';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yazl from 'yazl';
import type { ResearchExportFile } from '../../../shared/schemas/research-exports';
import { ArchivePolicy, ArchivePolicyError } from './archive-policy';
import { researchPath } from './research-files';

export const exportFileLimit = 64 * 1024 * 1024;
export const exportTotalLimit = 512 * 1024 * 1024;
export const exportArchiveLimit = 600 * 1024 * 1024;

const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0);
const ZIP_MODE = 0o100444;
const ZIP_COMPRESSION_LEVEL = 6;

export const archiveBuilderProvenance = {
  schemaVersion: 1,
  libraries: {
    yazl: {
      version: '3.3.1',
      lockfileIntegrity: 'sha512-BbETDVWG+VcMUle37k5Fqp//7SDOK2/1+T7X8TD96M3D9G8jK5VLUdQVdVjGi8im7FGkazX7kk5hkU8X4L5Bng=='
    },
    yauzl: {
      version: '3.4.0',
      lockfileIntegrity: 'sha512-jIH9yLR9wqr0wOS0TpBvo/g/2UgZH5qePVbjgRliiF0BYvOZyaBknKsF+x9Iht0O6sqgnB93rCICdOZFecJuDw=='
    }
  },
  writer: {
    library: 'yazl',
    ordering: 'ascending Unicode code-point order',
    timestamp: '1980-01-01 00:00:00 DOS time',
    mode: ZIP_MODE,
    compression: { method: 'deflate', level: ZIP_COMPRESSION_LEVEL },
    zip64: false,
    forceDosTimestamp: true,
    fileComment: ''
  },
  reader: {
    library: 'yauzl',
    lazyEntries: true,
    validateEntrySizes: false,
    strictFileNames: true,
    actualSizeValidation: 'streamed uncompressed bytes counted and checked against central-directory size',
    crcValidation: 'streamed uncompressed data checked against central-directory CRC-32'
  }
} as const;

type ArchiveWriterState = {
  handle: FileHandle;
  identity: { dev: number; ino: number };
  hash: ReturnType<typeof createHash>;
  size: number;
};

export async function createExportZipArchive(
  root: string,
  destination: string,
  entries: readonly ResearchExportFile[],
  signal: AbortSignal
): Promise<{ sha256: string; size: number }> {
  if (entries.length === 0 || entries.length > 10000) throw new Error('research_export_file_limit');
  const policy = new ArchivePolicy({ members: 10000, fileBytes: exportFileLimit, totalBytes: exportTotalLimit });
  const files: ResearchExportFile[] = [];
  try {
    for (const entry of entries) {
      signal.throwIfAborted();
      const { path } = policy.add({ name: entry.path, uncompressedSize: entry.size });
      files.push({ ...entry, path });
    }
  } catch (error) {
    throwExportPolicyFailure(error);
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));

  signal.throwIfAborted();
  const handle = await open(destination, 'wx', 0o400);
  let identity: { dev: number; ino: number } | null = null;
  const activeSources = new Set<Readable>();
  const sourceCleanup = new Map<Readable, Promise<void>>();
  try {
    const createdStat = await handle.stat();
    identity = { dev: createdStat.dev, ino: createdStat.ino };
    const writer: ArchiveWriterState = {
      handle,
      identity,
      hash: createHash('sha256'),
      size: 0
    };
    const zipFile = new yazl.ZipFile();
    zipFile.on('error', (error: Error) => {
      for (const source of activeSources) source.destroy();
      (zipFile.outputStream as Readable).destroy(error);
    });

    const output = new Transform({
      transform(chunk, _encoding, callback) {
        try {
          signal.throwIfAborted();
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (writer.size + data.length > exportArchiveLimit) {
            callback(new Error('research_export_file_limit'));
            return;
          }
          writer.hash.update(data);
          writer.size += data.length;
          callback(null, data);
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    const destinationStream = new Writable({
      write(chunk, _encoding, callback) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        writeAll(handle, data).then(() => callback(), callback);
      }
    });

    for (const entry of files) {
      zipFile.addReadStreamLazy(entry.path, {
        size: entry.size,
        mtime: ZIP_MTIME,
        mode: ZIP_MODE,
        compress: true,
        compressionLevel: ZIP_COMPRESSION_LEVEL,
        forceZip64Format: false,
        forceDosTimestamp: true,
        fileComment: ''
      }, (callback) => callback(null, createBundleReadStream(root, entry, signal, policy, activeSources, sourceCleanup, zipFile)));
    }
    zipFile.end({ forceZip64Format: false, comment: '' });
    await pipeline(zipFile.outputStream as Readable, output, destinationStream, { signal });
    signal.throwIfAborted();
    const result = { sha256: writer.hash.digest('hex'), size: writer.size };
    await handle.close();
    return result;
  } catch (error) {
    const cleanup = [...activeSources].map((source) => sourceCleanup.get(source)).filter((value): value is Promise<void> => value !== undefined);
    for (const source of activeSources) source.destroy();
    await Promise.all(cleanup);
    const cleanupErrors: unknown[] = [];
    await handle.close().catch((closeError: unknown) => cleanupErrors.push(closeError));
    if (identity !== null) {
      try {
        const current = await lstat(destination);
        if (current.dev === identity.dev && current.ino === identity.ino) await unlink(destination);
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

async function writeAll(handle: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, null);
    if (bytesWritten === 0) throw new Error('research_export_archive_write_failed');
    offset += bytesWritten;
  }
}

function createBundleReadStream(
  root: string,
  entry: ResearchExportFile,
  signal: AbortSignal,
  policy: ArchivePolicy,
  activeSources: Set<Readable>,
  sourceCleanup: Map<Readable, Promise<void>>,
  zipFile: yazl.ZipFile
): Readable {
  const source = Readable.from((async function* () {
    let file: FileHandle | null = null;
    try {
      signal.throwIfAborted();
      const path = await researchPath(root, entry.path);
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await file.stat();
      if (!before.isFile() || before.size > exportFileLimit || before.size !== entry.size) {
        throw new Error('research_export_snapshot_changed');
      }
      const hash = createHash('sha256');
      let size = 0;
      const input = file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
      for await (const chunk of input) {
        signal.throwIfAborted();
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += data.length;
        if (size > before.size || size > exportFileLimit) throw new Error('research_export_snapshot_changed');
        try {
          policy.addOutputBytes(data.length);
        } catch (error) {
          throwExportPolicyFailure(error);
        }
        hash.update(data);
        yield data;
      }
      signal.throwIfAborted();
      const after = await file.stat();
      if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
          || size !== entry.size || hash.digest('hex') !== entry.sha256) {
        throw new Error('research_export_snapshot_changed');
      }
    } finally {
      await file?.close();
    }
  })(), { objectMode: false, highWaterMark: 64 * 1024 });
  let settleCleanup!: () => void;
  const cleanupComplete = new Promise<void>((resolve) => { settleCleanup = resolve; });
  const settled = (): void => {
    activeSources.delete(source);
    sourceCleanup.delete(source);
    settleCleanup();
  };
  activeSources.add(source);
  sourceCleanup.set(source, cleanupComplete);
  source.on('error', (error) => zipFile.emit('error', error));
  source.once('end', settled);
  source.once('close', settled);
  return source;
}

function throwExportPolicyFailure(error: unknown): never {
  if (!(error instanceof ArchivePolicyError)) throw error;
  if (error.failure === 'path_collision') throw new Error('research_export_path_collision');
  if (error.failure === 'path_invalid') throw new Error('research_export_path_invalid');
  throw new Error('research_export_file_limit');
}
