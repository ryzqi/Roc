// Frozen d3be194 scanner; benchmark/parity reference only.
import { lstat, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResearchProcessWriteLimit } from '../../src/main/plugins/research/process-runner';

export async function assertProcessWriteLimits(limits: readonly ResearchProcessWriteLimit[]): Promise<void> {
  for (const limit of limits) {
    const rootInfo = await lstat(limit.path);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('research_process_write_path_invalid');
    const root = await realpath(limit.path);
    const stack = [root];
    let entriesSeen = 0;
    let filesSeen = 0;
    let bytesSeen = 0;
    while (stack.length > 0) {
      const directory = stack.pop();
      if (directory === undefined) break;
      for await (const entry of await opendir(directory)) {
        entriesSeen += 1;
        if (entriesSeen > limit.maxEntries) throw new Error('research_process_write_entry_limit');
        const path = join(directory, entry.name);
        let info: Awaited<ReturnType<typeof lstat>>;
        try { info = await lstat(path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (info.isSymbolicLink()) throw new Error('research_process_write_symlink');
        if (info.isDirectory()) stack.push(path);
        else if (info.isFile()) {
          filesSeen += 1;
          bytesSeen += info.size;
          if (info.nlink !== 1 || !Number.isSafeInteger(bytesSeen) || filesSeen > limit.maxFiles || info.size > limit.maxFileBytes || bytesSeen > limit.maxTotalBytes) {
            throw new Error('research_process_write_limit');
          }
        } else throw new Error('research_process_write_entry_invalid');
      }
    }
  }
}
