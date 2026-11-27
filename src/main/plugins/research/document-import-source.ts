import {createHash} from 'node:crypto';
import {constants, type Stats} from 'node:fs';
import {lstat, open, rename, rm} from 'node:fs/promises';
import {basename, dirname, extname, isAbsolute, join} from 'node:path';
import {documentMediaTypes, documentStorageRoot, maximumDocumentBytes} from './document-files';
import {createResearchDirectory, researchPath, researchWorkspace} from './research-files';

function stamp(info: Stats): string {
  if (!info.isFile()) throw new Error('research_document_source_invalid');
  if (info.size === 0 || info.size > maximumDocumentBytes) throw new Error('research_file_size_invalid');
  return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
}

export async function documentImportStamp(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('research_absolute_path_required');
  if (!documentMediaTypes[extname(path).toLowerCase()]) throw new Error('research_source_format_unsupported');
  return stamp(await lstat(path));
}

export async function documentImportLocation(rootPath: string | null, id: string, filename: string) {
  const extension = extname(filename).toLowerCase();
  const mediaType = documentMediaTypes[extension];
  if (!mediaType) throw new Error('research_source_format_unsupported');
  const root = await documentStorageRoot(rootPath);
  const directory = await createResearchDirectory(root, `documents/${id}`);
  return {id, root, directory, sourcePath: join(directory, `source${extension}`), mediaType};
}

async function digest(path: string, expected: string, signal: AbortSignal, consume?: (bytes: Buffer) => Promise<void>) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (stamp(before) !== expected) throw new Error('research_document_source_changed');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let size = 0;
    while (size < before.size) {
      signal.throwIfAborted();
      const {bytesRead} = await file.read(buffer, 0, Math.min(buffer.length, before.size - size), size);
      if (!bytesRead) throw new Error('research_document_source_changed');
      size += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await consume?.(chunk);
    }
    if (stamp(await file.stat()) !== expected || stamp(await lstat(path)) !== expected) {
      throw new Error('research_document_source_changed');
    }
    signal.throwIfAborted();
    return {sourceHash: hash.digest('hex'), size};
  } finally {await file.close();}
}

/** A final filename means the complete source was copied. A partial file is always replaced on recovery. */
export async function receiveDocumentImport(sourcePath: string, inputStamp: string, destination: string, signal: AbortSignal) {
  let finished: Stats | null = null;
  try {finished = await lstat(destination);}
  catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  if (finished) return await digest(destination, stamp(finished), signal);

  const source = await researchPath(await researchWorkspace(dirname(sourcePath)), basename(sourcePath));
  const partial = `${destination}.part`;
  await rm(partial, {force: true});
  const file = await open(partial, 'wx', 0o600);
  try {
    const receipt = await digest(source, inputStamp, signal, chunk => file.writeFile(chunk));
    await file.sync();
    await file.close();
    signal.throwIfAborted();
    await rename(partial, destination);
    const directory = await open(dirname(destination), 'r');
    try {await directory.sync();}
    finally {await directory.close();}
    return receipt;
  } finally {
    await file.close();
    await rm(partial, {force: true});
  }
}
