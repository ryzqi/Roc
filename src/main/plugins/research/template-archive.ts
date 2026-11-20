import { close as closeFdCallback, constants, open as openFdCallback } from 'node:fs';
import type { EventEmitter } from 'node:events';
import { mkdir, open, lstat, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { Readable, Writable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import { ArchivePolicy, ArchivePolicyError } from './archive-policy';
import { ResearchProcessError } from './process-runner';
import { runResearchJob, type ResearchJobPaths } from './research-job';

const MAX_MEMBERS = 5000;
const MAX_UNCOMPRESSED = 256 * 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const SKIP_PARTS = new Set(['__MACOSX', '.git', '.DS_Store', '.roc-research', '.roc-build']);
const STORED = 0;
const DEFLATE = 8;
const ENCRYPTION_FLAGS = 0x0001 | 0x0020 | 0x0040 | 0x2000;

type PreparedEntry = { entry: yauzl.Entry; path: string; directory: boolean };
type ZipFileWithReader = yauzl.ZipFile & { reader: EventEmitter };

function openArchiveDescriptor(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    openFdCallback(path, constants.O_RDONLY | constants.O_NOFOLLOW, (error, fd) => {
      if (error !== null) reject(error);
      else resolve(fd);
    });
  });
}

function closeArchiveDescriptor(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    closeFdCallback(fd, (error) => {
      if (error === null || (error as NodeJS.ErrnoException).code === 'EBADF') resolve();
      else reject(error);
    });
  });
}

function archivePolicyError(error: unknown): never {
  if (!(error instanceof ArchivePolicyError)) throw error;
  if (error.failure === 'path_invalid') throw new ResearchProcessError('research_template_archive_entry_invalid');
  if (error.failure === 'path_collision') throw new ResearchProcessError('research_template_archive_path_collision');
  if (error.failure === 'file_limit' || error.failure === 'total_limit' || error.failure === 'member_limit') {
    throw new ResearchProcessError('research_template_archive_too_large');
  }
  throw new ResearchProcessError('research_template_archive_entry_invalid');
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ResearchProcessError('research_process_cancelled');
}

function hasValidUtf8Name(entry: yauzl.Entry): boolean {
  if ((entry.generalPurposeBitFlag & 0x0800) === 0) return true;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entry.fileNameRaw) === entry.fileName;
  } catch {
    return false;
  }
}

function hasZip64ExtraField(extraField: Buffer): boolean {
  let offset = 0;
  while (offset < extraField.length) {
    if (extraField.length - offset < 4) return true;
    const id = extraField.readUInt16LE(offset);
    const size = extraField.readUInt16LE(offset + 2);
    const end = offset + 4 + size;
    if (end > extraField.length || id === 0x0001) return true;
    offset = end;
  }
  return false;
}

function closeArchiveReader(zip: yauzl.ZipFile): Promise<void> {
  if (!zip.isOpen) return Promise.resolve();
  return new Promise((resolve, reject) => {
    // Yauzl suppresses ZipFile errors after the first one; listen to its reader too.
    const reader = (zip as ZipFileWithReader).reader;
    let settled = false;
    const cleanup = (): void => {
      zip.off('error', onError);
      zip.off('close', onClose);
      reader.off('error', onError);
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    zip.on('error', onError);
    zip.once('close', onClose);
    reader.on('error', onError);
    try {
      zip.close();
    } catch (error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
  });
}

function preserveArchiveCloseError(primaryError: unknown, closeError: unknown): unknown {
  if (primaryError instanceof Error) {
    try {
      const previous = (primaryError as Error & { cleanupErrors?: unknown[] }).cleanupErrors ?? [];
      Object.defineProperty(primaryError, 'cleanupErrors', {
        value: [...previous, closeError], enumerable: true, configurable: true
      });
      return primaryError;
    } catch {
      // Fall through to an aggregate when the primary error cannot carry cleanup details.
    }
  }
  const aggregate = new AggregateError([primaryError, closeError], 'research_template_archive_cleanup_failed', { cause: primaryError });
  if (primaryError instanceof Error && 'code' in primaryError && typeof primaryError.code === 'string') {
    Object.defineProperty(aggregate, 'code', { value: primaryError.code, enumerable: true });
  }
  Object.defineProperty(aggregate, 'cleanupErrors', { value: [closeError], enumerable: true, configurable: true });
  return aggregate;
}

async function collectAndValidateEntries(zip: yauzl.ZipFile, signal: AbortSignal): Promise<PreparedEntry[]> {
  if (zip.entryCount > MAX_MEMBERS) throw new ResearchProcessError('research_template_archive_too_large');
  const policy = new ArchivePolicy({ members: MAX_MEMBERS, fileBytes: MAX_FILE, totalBytes: MAX_UNCOMPRESSED });
  const entries: PreparedEntry[] = [];
  try {
    for await (const entry of zip.eachEntry()) {
      throwIfCancelled(signal);
      if (entries.length >= MAX_MEMBERS) throw new ResearchProcessError('research_template_archive_too_large');
      const localHeader = await zip.readLocalFileHeaderPromise(entry);
      throwIfCancelled(signal);
      const directory = entry.fileName.endsWith('/');
      const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const dosAttributes = entry.externalFileAttributes & 0xffff;
      if ((entry.generalPurposeBitFlag & ENCRYPTION_FLAGS) !== 0
          || (entry.compressionMethod !== STORED && entry.compressionMethod !== DEFLATE)
          || !entry.canDecodeFileData()
          || !hasValidUtf8Name(entry)
          || entry.extraFields.some((field) => field.id === 0x0001)
          || hasZip64ExtraField(localHeader.extraField)
          || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0
          || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
          || !Number.isSafeInteger(entry.relativeOffsetOfLocalHeader) || entry.relativeOffsetOfLocalHeader < 0
          || (dosAttributes & 0x0400) !== 0
          || ((dosAttributes & 0x0010) !== 0 && !directory)) {
        throw new ResearchProcessError('research_template_archive_entry_invalid');
      }
      let normalized: { path: string; directory: boolean };
      try {
        normalized = policy.add({ name: entry.fileName, uncompressedSize: entry.uncompressedSize, directory, unixMode });
      } catch (error) {
        archivePolicyError(error);
      }
      entries.push({ entry, path: normalized.path, directory: normalized.directory });
    }
  } catch (error) {
    if (error instanceof ResearchProcessError) throw error;
    if (signal.aborted) throw new ResearchProcessError('research_process_cancelled');
    throw new ResearchProcessError('research_template_archive_entry_invalid');
  }
  if (entries.length !== zip.entryCount) throw new ResearchProcessError('research_template_archive_entry_invalid');
  return entries;
}

function skipMember(path: string): boolean {
  return path.split('/').some((part) => SKIP_PARTS.has(part));
}

async function ensureOutputDirectory(outputRoot: string, relativeDirectory: string): Promise<void> {
  let current = outputRoot;
  for (const part of relativeDirectory.split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new ResearchProcessError('research_template_archive_entry_invalid');
  }
}

async function writeEntryStream(
  zip: yauzl.ZipFile,
  prepared: PreparedEntry,
  outputPath: string | null,
  policy: ArchivePolicy,
  signal: AbortSignal
): Promise<void> {
  let source: Readable | undefined;
  let handle: FileHandle | undefined;
  let archiveStreamError: unknown;
  try {
    throwIfCancelled(signal);
    try {
      source = await zip.openReadStreamPromise(prepared.entry);
    } catch {
      throw new ResearchProcessError('research_template_archive_entry_invalid');
    }
    source.on('error', (error) => { archiveStreamError ??= error; });
    let destination: NodeJS.WritableStream;
    let outputError: unknown;
    if (outputPath !== null) {
      handle = await open(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      destination = new Writable({
        write(chunk, _encoding, callback) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          writeAll(handle!, data).then(() => callback(), callback);
        }
      });
      destination.on('error', (error: NodeJS.ErrnoException) => {
        if (error.syscall === 'write') outputError = error;
      });
    } else {
      destination = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    }

    let uncompressedBytes = 0;
    let checksum = 0;
    const validate = new Transform({
      transform(chunk, _encoding, callback) {
        try {
          throwIfCancelled(signal);
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          uncompressedBytes += data.length;
          if (uncompressedBytes > MAX_FILE) throw new ResearchProcessError('research_template_archive_too_large');
          if (uncompressedBytes > prepared.entry.uncompressedSize) throw new ResearchProcessError('research_template_archive_entry_invalid');
          try {
            policy.addOutputBytes(data.length);
          } catch (error) {
            archivePolicyError(error);
          }
          checksum = crc32(data, checksum) >>> 0;
          callback(null, data);
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
      flush(callback) {
        if (uncompressedBytes !== prepared.entry.uncompressedSize) {
          callback(new ResearchProcessError('research_template_archive_entry_invalid'));
        } else if (checksum !== prepared.entry.crc32) {
          callback(new ResearchProcessError('research_template_archive_crc_mismatch'));
        } else {
          callback();
        }
      }
    });

    try {
      await pipeline(source, validate, destination, { signal });
      if (archiveStreamError !== undefined) throw new ResearchProcessError('research_template_archive_entry_invalid');
    } catch (error) {
      if (signal.aborted) throw new ResearchProcessError('research_process_cancelled');
      if (error instanceof ResearchProcessError) throw error;
      if (outputError !== undefined) throw outputError;
      if (archiveStreamError !== undefined) throw new ResearchProcessError('research_template_archive_entry_invalid');
      throw new ResearchProcessError('research_template_archive_entry_invalid');
    }
  } finally {
    source?.destroy();
    if (handle !== undefined) await handle.close();
  }
}

async function writeAll(handle: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, null);
    if (bytesWritten === 0) throw new Error('research_template_archive_write_failed');
    offset += bytesWritten;
  }
}

async function extractArchive(job: ResearchJobPaths, signal: AbortSignal): Promise<{ fileCount: number }> {
  let sourceFd: number | undefined;
  let zip: yauzl.ZipFile | undefined;
  let extracted = 0;
  let operationFailed = false;
  let operationError: unknown;
  let result: { fileCount: number } | undefined;
  try {
    throwIfCancelled(signal);
    sourceFd = await openArchiveDescriptor(job.source);
    zip = await yauzl.fromFdPromise(sourceFd, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: false,
      strictFileNames: true
    });
    const entries = await collectAndValidateEntries(zip, signal);
    const policy = new ArchivePolicy({ members: MAX_MEMBERS, fileBytes: MAX_FILE, totalBytes: MAX_UNCOMPRESSED });
    for (const item of entries) {
      throwIfCancelled(signal);
      if (item.directory) {
        if (!skipMember(item.path)) await ensureOutputDirectory(job.output, item.path);
        await writeEntryStream(zip, item, null, policy, signal);
        continue;
      }
      const skipped = skipMember(item.path);
      const path = join(job.output, ...item.path.split('/'));
      if (!skipped) await ensureOutputDirectory(job.output, dirname(item.path) === '.' ? '' : dirname(item.path));
      await writeEntryStream(zip, item, skipped ? null : path, policy, signal);
      if (!skipped) extracted += 1;
    }
    throwIfCancelled(signal);
    result = { fileCount: extracted };
  } catch (error) {
    operationFailed = true;
    operationError = error instanceof ResearchProcessError
      ? error
      : signal.aborted
        ? new ResearchProcessError('research_process_cancelled')
        : zip === undefined
          ? new ResearchProcessError('research_template_archive_entry_invalid')
          : error;
  }

  let closeFailed = false;
  let closeError: unknown;
  try {
    if (zip !== undefined) await closeArchiveReader(zip);
    else if (sourceFd !== undefined) await closeArchiveDescriptor(sourceFd);
  } catch (error) {
    closeFailed = true;
    closeError = error;
  }
  if (!operationFailed && signal.aborted) {
    operationFailed = true;
    operationError = new ResearchProcessError('research_process_cancelled');
  }
  if (operationFailed) {
    if (closeFailed) operationError = preserveArchiveCloseError(operationError, closeError);
    throw operationError;
  }
  if (closeFailed) throw closeError;
  return result as { fileCount: number };
}

export async function extractResearchTemplate(input: {
  projectRoot: string;
  sourcePath: string;
  outputDir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ fileCount: number; sourceHash: string }> {
  return await runResearchJob(
    { ...input, maxSourceBytes: MAX_UNCOMPRESSED, sourceExtensions: ['.zip'], sourceExtensionError: 'research_template_zip_required',
      timeoutMs: input.timeoutMs ?? 60_000, awaitOperationCleanupOnAbort: true },
    extractArchive
  );
}
