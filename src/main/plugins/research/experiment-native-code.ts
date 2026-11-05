import { constants, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, opendir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { researchContentHash } from './research-files';
import { nativeCodeLimits, nativeCodeSnapshotSchema, type NativeCodeEntry, type NativeCodeSnapshot } from './experiment-native-code-schema';

/** Hash bytes and link topology of every declared native code tree; never trust mtimes as identity. */
export async function captureNativeCode(paths: readonly string[], signal: AbortSignal): Promise<NativeCodeSnapshot> {
  signal.throwIfAborted();
  const roots = [...new Set(await Promise.all(paths.map(path => realpath(path))))].sort();
  const entries: NativeCodeEntry[] = [];
  let totalBytes = 0;
  let metadataBytes = 0;
  const add = (entry: NativeCodeEntry): void => {
    metadataBytes += Buffer.byteLength(JSON.stringify(entry));
    if (entries.length >= nativeCodeLimits.maxEntries || metadataBytes > nativeCodeLimits.maxMetadataBytes) throw new Error('research_experiment_native_code_limit');
    entries.push(entry);
  };
  const visit = async (root: string, path: string): Promise<void> => {
    signal.throwIfAborted();
    const before = await lstat(path, { bigint: true });
    const identity = { root, path: relative(root, path), mode: Number(before.mode & 0o7777n) };
    if (before.isSymbolicLink()) {
      const target = await readlink(path), resolved = await realpath(path);
      if (!roots.some(scope => within(scope, resolved))) throw new Error('research_experiment_native_code_outside_scope');
      add({ ...identity, type: 'symlink', target, resolved });
    } else if (before.isDirectory()) {
      add({ ...identity, type: 'directory' });
      for await (const entry of await opendir(path)) await visit(root, join(path, entry.name));
    } else if (before.isFile()) {
      const size = Number(before.size);
      totalBytes += size;
      if (size > nativeCodeLimits.maxFileBytes || totalBytes > nativeCodeLimits.maxTotalBytes) throw new Error('research_experiment_native_code_limit');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!sameVersion(before, await file.stat({ bigint: true }))) throw new Error('research_experiment_native_code_changed');
        const hash = createHash('sha256');
        let bytesRead = 0;
        for await (const bytes of file.createReadStream({ autoClose: false, start: 0, highWaterMark: 1024 * 1024, signal })) {
          bytesRead += bytes.length;
          if (bytesRead > size) throw new Error('research_experiment_native_code_changed');
          hash.update(bytes);
        }
        if (bytesRead !== size || !sameVersion(before, await file.stat({ bigint: true }))) throw new Error('research_experiment_native_code_changed');
        add({ ...identity, type: 'file', size, sha256: hash.digest('hex') });
      } finally { await file.close(); }
    } else throw new Error('research_experiment_native_code_entry_invalid');
    if (!sameVersion(before, await lstat(path, { bigint: true }))) throw new Error('research_experiment_native_code_changed');
  };
  for (const root of roots) {
    if (!(await lstat(root)).isDirectory()) throw new Error('research_experiment_native_code_directory_required');
    // Nested declared roots are already inventoried by their containing root.
    if (!roots.some(other => other !== root && within(other, root))) await visit(root, root);
  }
  entries.sort((left, right) => left.root < right.root ? -1 : left.root > right.root ? 1 : left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const body = { contractVersion: 1, limits: nativeCodeLimits, roots, entries };
  return nativeCodeSnapshotSchema.parse({ ...body, hash: researchContentHash(JSON.stringify(body)) });
}

function within(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === '' || value !== '..' && !value.startsWith('../') && !isAbsolute(value);
}
function sameVersion(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
