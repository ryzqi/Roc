import {constants} from 'node:fs';
import {open, realpath} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import type {Stats} from 'node:fs';
import type {ZoteroAttachmentGrant} from '../../../shared/schemas/research-zotero-attachment';
import {maximumDocumentBytes} from './document-files';

const identity = (info: Stats) => ({device: info.dev, inode: info.ino, size: info.size, modifiedMs: info.mtimeMs, changedMs: info.ctimeMs});

/** Opens only an already verified owned grant; validates the descriptor before and after its byte read. */
export async function readZoteroGrantedFile(grant: ZoteroAttachmentGrant, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if (await realpath(grant.selectedPath) !== grant.selectedPath) throw new Error('zotero_attachment_file_changed');
  const file = await open(grant.selectedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    signal.throwIfAborted();
    const before = await file.stat();
    if (!before.isFile() || before.size > maximumDocumentBytes || !isDeepStrictEqual(identity(before), grant.identity)) {
      throw new Error('zotero_attachment_file_changed');
    }
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal.throwIfAborted();
      const result = await file.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    signal.throwIfAborted();
    const after = await file.stat();
    if (offset !== before.size || !isDeepStrictEqual(identity(after), grant.identity)) throw new Error('zotero_attachment_file_changed');
    return buffer.subarray(0, offset);
  } finally {await file.close();}
}
