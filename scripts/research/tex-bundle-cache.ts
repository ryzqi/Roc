import { createHash } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import { convertTexBundle, readTexBundleFileDigests, type TexBundleFileDigest } from './archive-utils.ts';

const MAX_BUNDLE_FILE = 512 * 1024 ** 2;
const MAX_BUNDLE_BYTES = 4 * 1024 ** 3;

function invalidBundle(cause?: unknown): Error {
  return new Error('research_tex_bundle_cache_invalid', { cause });
}

/**
 * The upstream tarball is pinned by SHA-256 before this is called. ZIP deflate
 * bytes may change between zlib versions, so compare each uncompressed payload
 * with that source. The ZIP's SHA256SUM is checked for internal consistency,
 * but is never trusted as its own source identity.
 */
export async function verifyTexBundleZip(path: string, fileList: readonly string[], source: string): Promise<void> {
  try {
    await verifyZipContents(path, await readTexBundleFileDigests(source, fileList));
  } catch (error) {
    throw invalidBundle(error);
  }
}

async function verifyZipContents(path: string, sourceFiles: ReadonlyMap<string, TexBundleFileDigest>): Promise<void> {
  const expected = new Set([...sourceFiles.keys(), 'SHA256SUM']);
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
      const sourceFile = sourceFiles.get(name);
      if (!expected.has(name) || seen.has(name) || entry.compressionMethod !== 8
          || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
          || entry.uncompressedSize > MAX_BUNDLE_FILE
          || (name === 'SHA256SUM' ? entry.uncompressedSize !== 65 : entry.uncompressedSize !== sourceFile?.size)) {
        throw invalidBundle();
      }
      const localHeader = await zip.readLocalFileHeaderPromise(entry);
      if (localHeader.crc32 !== entry.crc32 || localHeader.compressionMethod !== entry.compressionMethod
          || localHeader.generalPurposeBitFlag !== entry.generalPurposeBitFlag
          || localHeader.fileName.toString('utf8') !== name) throw invalidBundle();
      seen.add(name);
      totalBytes += entry.uncompressedSize;
      if (totalBytes > MAX_BUNDLE_BYTES) throw invalidBundle();
      const stream = await zip.openReadStreamPromise(entry);
      const hash = createHash('sha256');
      const metadata: Buffer[] = [];
      let bytes = 0;
      let crc = 0;
      for await (const chunk of stream) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.length;
        if (bytes > entry.uncompressedSize) throw invalidBundle();
        hash.update(data);
        crc = crc32(data, crc);
        if (name === 'SHA256SUM') metadata.push(data);
      }
      if (bytes !== entry.uncompressedSize || crc !== entry.crc32) throw invalidBundle();
      if (name === 'SHA256SUM') recordedDigest = Buffer.concat(metadata).toString('ascii');
      else {
        const digest = hash.digest('hex');
        if (digest !== sourceFile?.sha256) throw invalidBundle();
        digests.push(`${name} ${digest}`);
      }
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
  const sourceFiles = await readTexBundleFileDigests(source, fileList);
  let info;
  try {
    info = await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (info !== undefined && !info.isFile()) throw invalidBundle();
  if (info !== undefined) {
    try {
      await verifyZipContents(destination, sourceFiles);
      return;
    } catch {
      await rm(destination);
    }
  }
  await convertTexBundle(source, destination, fileList);
  try {
    await verifyZipContents(destination, sourceFiles);
  } catch (error) {
    await rm(destination);
    throw error;
  }
}
