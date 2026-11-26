import { createHash } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { convertTexBundle } from './archive-utils.ts';

const MAX_BUNDLE_FILE = 512 * 1024 ** 2;
const MAX_BUNDLE_BYTES = 4 * 1024 ** 3;

function invalidBundle(cause?: unknown): Error {
  return new Error('research_tex_bundle_cache_invalid', { cause });
}

/**
 * The upstream tarball is pinned by SHA-256 before this is called. ZIP deflate
 * bytes may change between zlib versions, so verify the uncompressed payload
 * instead of comparing the whole generated ZIP to a machine-specific digest.
 * The SHA256SUM member is a digest of sorted "filename sha256" lines.
 */
export async function verifyTexBundleZip(path: string, fileList: readonly string[]): Promise<void> {
  const expected = new Set([...fileList, 'SHA256SUM']);
  if (expected.size !== fileList.length + 1 || !expected.has('tectonic-format-latex.tex')) {
    throw invalidBundle();
  }
  let zip: yauzl.ZipFile | undefined;
  try {
    zip = await yauzl.openPromise(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true });
    if (zip.entryCount !== expected.size) throw invalidBundle();
    const seen = new Set<string>();
    const digests: string[] = [];
    let recordedDigest: string | undefined;
    let totalBytes = 0;
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      if (!expected.has(name) || seen.has(name) || entry.compressionMethod !== 8
          || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
          || entry.uncompressedSize > MAX_BUNDLE_FILE
          || (name === 'SHA256SUM' && entry.uncompressedSize !== 65)) {
        throw invalidBundle();
      }
      seen.add(name);
      totalBytes += entry.uncompressedSize;
      if (totalBytes > MAX_BUNDLE_BYTES) throw invalidBundle();
      const stream = await new Promise<Readable>((resolve, reject) => {
        zip!.openReadStream(entry, (error, result) => error ? reject(error) : resolve(result!));
      });
      const hash = createHash('sha256');
      const metadata: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of stream) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.length;
        if (bytes > entry.uncompressedSize) throw invalidBundle();
        hash.update(data);
        if (name === 'SHA256SUM') metadata.push(data);
      }
      if (bytes !== entry.uncompressedSize) throw invalidBundle();
      if (name === 'SHA256SUM') recordedDigest = Buffer.concat(metadata).toString('ascii');
      else digests.push(`${name} ${hash.digest('hex')}`);
    }
    const contentDigest = `${createHash('sha256').update(digests.sort().join('\n')).digest('hex')}\n`;
    if (seen.size !== expected.size || recordedDigest !== contentDigest) throw invalidBundle();
  } catch (error) {
    throw invalidBundle(error);
  } finally {
    zip?.close();
  }
}

/** Recover a corrupted or stale cache using only a previously SHA-256-verified tarball. */
export async function ensureTexBundleZip(source: string, destination: string, fileList: readonly string[]): Promise<void> {
  let info;
  try {
    info = await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (info !== undefined && !info.isFile()) throw invalidBundle();
  if (info !== undefined) {
    try {
      await verifyTexBundleZip(destination, fileList);
      return;
    } catch {
      await rm(destination);
    }
  }
  await convertTexBundle(source, destination, fileList);
  try {
    await verifyTexBundleZip(destination, fileList);
  } catch (error) {
    await rm(destination);
    throw error;
  }
}
