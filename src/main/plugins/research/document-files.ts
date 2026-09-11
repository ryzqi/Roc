import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import type { z } from 'zod';
import { researchParsedDocumentSchema } from '../../../shared/schemas/research-production';
import type { StoredDocumentContent } from './document-repository';
import { readResearchFile, researchContentHash, researchRelativePath } from './research-files';

export const maximumDocumentBytes = 512 * 1024 * 1024;
export const documentMediaTypes: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf', '.html': 'text/html', '.htm': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp', '.webp': 'image/webp'
};

export async function documentStorageRoot(path: string | null): Promise<string> {
  if (path === null || !isAbsolute(path)) throw new Error('research_library_storage_unavailable');
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('research_library_storage_symlink'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error('research_library_storage_invalid');
  return await realpath(path);
}

export async function collectDocumentContent(root: string, output: string, input: z.infer<typeof researchParsedDocumentSchema>): Promise<StoredDocumentContent> {
  const parsed = researchParsedDocumentSchema.parse(input);
  if (parsed.assets.length > 5000 || new Set(parsed.blocks.map((block) => block.id)).size !== parsed.blocks.length) {
    throw new Error('research_document_structure_invalid');
  }
  if (parsed.content !== parsed.blocks.filter((block) => block.text.trim()).map((block) => block.text).join('\n\n')) {
    throw new Error('research_document_content_mismatch');
  }
  const assets: StoredDocumentContent['content']['assets'] = [];
  const files: Record<string, string> = {};
  const idsByPath = new Map<string, string>();
  let size = 0;
  for (const asset of parsed.assets) {
    const path = researchRelativePath(asset.path);
    if (idsByPath.has(path) || (asset.page !== null && asset.page > parsed.pageCount)) throw new Error('research_document_asset_invalid');
    const bytes = await readResearchFile(output, path, 64 * 1024 * 1024);
    size += bytes.length;
    if (size > maximumDocumentBytes) throw new Error('research_document_assets_too_large');
    if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('research_document_asset_format_invalid');
    const id = `asset_${assets.length}`;
    idsByPath.set(path, id);
    files[id] = path;
    assets.push({ id, kind: asset.kind, page: asset.page, size: bytes.length, sha256: researchContentHash(bytes) });
  }
  const blocks = parsed.blocks.map(({ imagePath, ...block }) => {
    if (!block.locator.trim() || block.locations.some((location) => location.page > parsed.pageCount)) throw new Error('research_document_location_invalid');
    const imageAssetId = imagePath === null ? null : idsByPath.get(imagePath);
    if (imageAssetId === undefined) throw new Error('research_document_asset_unlisted');
    return { ...block, imageAssetId };
  });
  return { outputPath: researchRelativePath(relative(root, output)), files,
    content: { sourceHash: parsed.sourceHash, parserVersion: parsed.parserVersion, pageCount: parsed.pageCount, content: parsed.content, warnings: parsed.warnings, blocks, assets } };
}
