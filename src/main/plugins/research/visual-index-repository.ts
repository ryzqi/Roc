import {randomUUID} from 'node:crypto';
import {constants, lstatSync, readFileSync, realpathSync, renameSync} from 'node:fs';
import {link, lstat, realpath, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {visualManifestSchema, type VisualManifest} from '../../../shared/schemas/research-visual-retrieval';
import {createResearchDirectory, readResearchFile, researchContentHash} from './research-files';
import {decodeVisualMatrix, encodeVisualMatrix, type VisualMatrix} from './visual-retrieval-adapter';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const pointerSchema = z.strictObject({active: hash, previous: hash.nullable()});
export type VisualIndex = {generation: string; manifest: VisualManifest; matrices: VisualMatrix[]};
/** Independently rebuildable artifacts; parser publications and historical revisions are never modified. */
export class VisualIndexRepository {
  constructor(private readonly root: string | null) {}
  private async directory(projectId: string): Promise<string> {
    if (this.root === null) throw new Error('research_visual_storage_unavailable');
    if ((await lstat(this.root)).isSymbolicLink() || await realpath(this.root) !== this.root) {
      throw new Error('research_visual_storage_invalid');
    }
    return await createResearchDirectory(this.root, `visual-index/${researchContentHash(projectId)}`);
  }
  private pointer(dir: string): z.infer<typeof pointerSchema> | null {
    if (realpathSync(dir) !== dir || lstatSync(dir).isSymbolicLink()) throw new Error('research_visual_storage_invalid');
    try {return pointerSchema.parse(JSON.parse(readFileSync(join(dir, 'active.json'), {encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW})));}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;}
  }
  async guardActive(projectId: string, generation: string): Promise<() => void> {
    const dir = await this.directory(projectId);
    return () => {if (this.pointer(dir)?.active !== generation) throw new Error('research_visual_index_changed');};
  }
  async active(projectId: string): Promise<VisualIndex | null> {
    const dir = await this.directory(projectId), pointer = this.pointer(dir);
    if (!pointer) return null;
    const bytes = await readResearchFile(dir, `${pointer.active}.json`, 8 * 1024 ** 2);
    if (researchContentHash(bytes) !== pointer.active) throw new Error('research_visual_index_changed');
    const manifest = visualManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (manifest.projectId !== projectId) throw new Error('research_visual_scope_invalid');
    const matrices: VisualMatrix[] = [];
    for (const entry of manifest.entries) {
      const buffer = await readResearchFile(dir, `${entry.matrix.sha256}.f32`, 8 * 1024 ** 2);
      if (researchContentHash(buffer) !== entry.matrix.sha256) throw new Error('research_visual_index_changed');
      matrices.push(decodeVisualMatrix(buffer, entry.matrix));
    }
    if (this.pointer(dir)?.active !== pointer.active) throw new Error('research_visual_index_changed');
    return {generation: pointer.active, manifest, matrices};
  }
  async publish(input: VisualManifest, matrices: VisualMatrix[], expected: string | null,
    assertCurrent: () => void): Promise<string> {
    const manifest = visualManifestSchema.parse(input), dir = await this.directory(manifest.projectId);
    if (matrices.length !== manifest.entries.length) throw new Error('research_visual_matrix_count_invalid');
    const immutable = async (name: string, bytes: Buffer) => {
      const temporary = join(dir, `.staging-${randomUUID()}`);
      await writeFile(temporary, bytes, {flag: 'wx', mode: 0o600});
      try {
        try {await link(temporary, join(dir, name));}
        catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}
        if (!(await readResearchFile(dir, name, bytes.length)).equals(bytes)) throw new Error('research_visual_index_changed');
      } finally {await unlink(temporary);}
    };
    for (const [i, matrix] of matrices.entries()) {
      assertCurrent();
      const bytes = encodeVisualMatrix(matrix), receipt = manifest.entries[i]!.matrix;
      if (researchContentHash(bytes) !== receipt.sha256 || matrix.tokens !== receipt.tokens || matrix.dimensions !== receipt.dimensions) {
        throw new Error('research_visual_matrix_receipt_invalid');
      }
      await immutable(`${receipt.sha256}.f32`, bytes);
    }
    const bytes = Buffer.from(JSON.stringify(manifest)), generation = researchContentHash(bytes);
    await immutable(`${generation}.json`, bytes);
    const temporary = join(dir, `.pointer-${randomUUID()}`);
    await writeFile(temporary, JSON.stringify({active: generation, previous: expected}), {flag: 'wx', mode: 0o600});
    try {
      if ((this.pointer(dir)?.active ?? null) !== expected) throw new Error('research_visual_index_changed');
      // No asynchronous gap between the caller's source/config fences and atomic activation.
      assertCurrent(); renameSync(temporary, join(dir, 'active.json'));
    } finally {await unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});}
    return generation;
  }
}
