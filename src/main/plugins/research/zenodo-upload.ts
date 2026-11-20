import {constants} from 'node:fs';
import {open, mkdtemp, chmod, unlink, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import type {z} from 'zod';
import type {zenodoUploadFileSchema} from '../../../shared/schemas/research-zenodo';
import {researchPath} from './research-files';

/** Upload only a complete verified copy, held by an unlinked readonly descriptor. */
export async function uploadZenodoFile(root: string, expected: z.infer<typeof zenodoUploadFileSchema>,
  signal: AbortSignal, verifyCurrent: () => Promise<void>,
  send: (stream: ReadableStream<Uint8Array>, size: number) => Promise<unknown>): Promise<unknown> {
  signal.throwIfAborted();
  const source = await open(await researchPath(root, expected.path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await source.stat();
    if (!before.isFile() || before.size !== expected.size || before.size > 512 * 1024 * 1024) {
      throw new Error('research_zenodo_file_changed');
    }
    const directory = await mkdtemp(join(tmpdir(), 'roc-zenodo-upload-'));
    try {
      await chmod(directory, 0o700);
      const path = join(directory, 'payload'), target = await open(path, 'wx', 0o600);
      try {
        const sha = createHash('sha256'), md5 = createHash('md5'), block = Buffer.alloc(1024 * 1024);
        let size = 0;
        while (true) {
          signal.throwIfAborted();
          const {bytesRead} = await source.read(block, 0, block.length, null);
          if (bytesRead === 0) break;
          size += bytesRead;
          if (size > expected.size) throw new Error('research_zenodo_file_changed');
          const bytes = block.subarray(0, bytesRead);
          sha.update(bytes); md5.update(bytes);
          let written = 0;
          while (written < bytesRead) {
            signal.throwIfAborted();
            const result = await target.write(bytes, written, bytesRead - written, null);
            if (result.bytesWritten === 0) throw new Error('research_zenodo_staging_write_failed');
            written += result.bytesWritten;
          }
        }
        const after = await source.stat();
        if (size !== expected.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
          sha.digest('hex') !== expected.sha256 || md5.digest('hex') !== expected.md5) {
          throw new Error('research_zenodo_file_changed');
        }
        await target.chmod(0o400);
      } finally {await target.close();}
      const staged = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await unlink(path);
        await verifyCurrent();
        signal.throwIfAborted();
        const stream = staged.createReadStream({autoClose: false, signal, highWaterMark: 1024 * 1024});
        try {return await send(Readable.toWeb(stream) as ReadableStream<Uint8Array>, expected.size);}
        finally {stream.destroy();}
      } finally {await staged.close();}
    } finally {await rm(directory, {recursive: true, force: true});}
  } finally {await source.close();}
}
