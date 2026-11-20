import {lstatSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {ScientificContextImage} from '../../../shared/schemas/research-scientific-context';
import {loadImage} from '@napi-rs/canvas';
import {readResearchFile, researchContentHash} from './research-files';
import type {ScientificContextImageReader} from './scientific-context-assembler';

type ImageFile = {storage: 'library' | 'project'; root: string; path: string;
  assetId: string | null; sha256: string | null; size: number | null};
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type ScientificVisualAsset = {image: ScientificContextImage; bytes: Buffer; assertCurrent: () => void};
type ImageSelector = (paper: Parameters<ScientificContextImageReader>[0], objectId: string) => Promise<ImageFile | null>;

/** Existing context callers receive receipts only; model input stays in the main process. */
export function scientificContextImageReader(select: ImageSelector): ScientificContextImageReader {
  const read = scientificVisualAssetReader(select);
  return async (...args) => {
    const result = await read(...args);
    return {image: result.asset?.image ?? null, reason: result.reason};
  };
}

/** The caller selects the owner's immutable output directory, never a caller-supplied path. */
export function scientificVisualAssetReader(select: ImageSelector):
  (...args: Parameters<ScientificContextImageReader>) => Promise<{asset: ScientificVisualAsset | null; reason: string | null}> {
  return async (paper, objectId, maxDimension, signal) => {
    signal.throwIfAborted();
    const figure = paper.ir.figures.find(f => f.id === objectId) ?? paper.ir.tables.find(t => t.id === objectId);
    if (!figure) throw new Error('research_scientific_context_image_object_invalid');
    const file = await select(paper, objectId);
    signal.throwIfAborted();
    if (!file) return {asset: null, reason: 'figure_asset_unavailable'};
    const stamp = () => {
      let path = file.root;
      for (const part of ['', ...file.path.split('/')]) {
        if (part) path = join(path, part);
        if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) {
          throw new Error('research_scientific_context_image_changed');
        }
      }
      const st = lstatSync(path, {bigint: true});
      if (!st.isFile()) throw new Error('research_scientific_context_image_changed');
      return {dev: st.dev, ino: st.ino, size: st.size, mtime: st.mtimeNs, ctime: st.ctimeNs};
    };
    const before = stamp();
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (!isDeepStrictEqual(before, stamp())) throw new Error('research_scientific_context_image_changed');
    };
    const bytes = await readResearchFile(file.root, file.path, 64 * 1024 * 1024);
    signal.throwIfAborted();
    const sha256 = researchContentHash(bytes);
    if (file.sha256 !== null && sha256 !== file.sha256 || file.size !== null && bytes.length !== file.size) {
      throw new Error('research_scientific_context_image_changed');
    }
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('research_scientific_context_image_invalid');
    }
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height) throw new Error('research_scientific_context_image_invalid');
    if (width > maxDimension || height > maxDimension) {
      return {asset: null, reason: 'image_dimension_budget_exceeded'};
    }
    const decoded = await loadImage(bytes);
    signal.throwIfAborted();
    if (decoded.width !== width || decoded.height !== height) {
      throw new Error('research_scientific_context_image_invalid');
    }
    if (researchContentHash(await readResearchFile(file.root, file.path, 64 * 1024 * 1024)) !== sha256) {
      throw new Error('research_scientific_context_image_changed');
    }
    signal.throwIfAborted();
    assertCurrent();
    return {asset: {bytes, assertCurrent, image: {storage: file.storage, assetId: file.assetId, path: file.path,
      sha256, size: bytes.length, width, height, sourceLocator: figure.sourceLocator}}, reason: null};
  };
}
