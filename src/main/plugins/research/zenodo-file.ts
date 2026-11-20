import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {researchPath} from './research-files';

/** Hash bounded file bytes without buffering an export archive in memory. */
export async function hashZenodoFile(root: string, path: string, expected: {sha256: string; size: number},
  signal: AbortSignal): Promise<string> {
  const file = await open(await researchPath(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== expected.size || before.size > 512 * 1024 * 1024) throw new Error('research_zenodo_file_changed');
    const sha = createHash('sha256'), md5 = createHash('md5'), block = Buffer.alloc(1024 * 1024);
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const {bytesRead} = await file.read(block, 0, block.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > expected.size) throw new Error('research_zenodo_file_changed');
      sha.update(block.subarray(0, bytesRead)); md5.update(block.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (size !== expected.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
      sha.digest('hex') !== expected.sha256) throw new Error('research_zenodo_file_changed');
    return md5.digest('hex');
  } finally {await file.close();}
}
