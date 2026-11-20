import {constants, lstatSync, realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {lstat, open, readdir, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {VisualModel} from '../../../shared/schemas/research-visual-retrieval';
import {readResearchFile, researchContentHash} from './research-files';

/** Plain Transformers retrieval checkpoints only: no local custom modules or pickle weights. */
export async function inspectVisualModel(path: string, family: VisualModel['family'], signal: AbortSignal):
  Promise<{sha256: string; assertCurrent: () => void}> {
  signal.throwIfAborted();
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw new Error('research_visual_model_path_invalid');
  const files: Array<{path: string; sha256: string; size: number}> = [];
  const guards: Array<() => void> = [];
  let total = 0, count = 0;
  const stamp = (p: string) => {
    const s = lstatSync(p, {bigint: true});
    if (s.isSymbolicLink() || realpathSync(p) !== p) throw new Error('research_visual_model_symlink');
    return {dev: s.dev, ino: s.ino, size: s.size, mtime: s.mtimeNs, ctime: s.ctimeNs};
  };
  const visit = async (relative: string): Promise<void> => {
    signal.throwIfAborted();
    if (++count > 1024) throw new Error('research_visual_model_budget_exceeded');
    const p = join(path, relative), before = stamp(p), s = await lstat(p);
    guards.push(() => {if (!isDeepStrictEqual(before, stamp(p))) throw new Error('research_visual_model_changed');});
    if (s.isDirectory()) {
      for (const child of (await readdir(p)).sort()) await visit(relative ? `${relative}/${child}` : child);
    } else if (s.isFile()) {
      if (!/\.(json|safetensors|txt|model|jinja|md)$/u.test(relative) ||
        /(^|\/)(modules\.json|config_sentence_transformers\.json)$/u.test(relative)) {
        throw new Error('research_visual_model_file_unsupported');
      }
      total += s.size;
      if (s.size > 8 * 1024 ** 3 || total > 16 * 1024 ** 3) throw new Error('research_visual_model_budget_exceeded');
      const file = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW), hash = createHash('sha256');
      let size = 0;
      try {
        for await (const bytes of file.createReadStream({autoClose: false, highWaterMark: 1024 ** 2, signal})) {
          size += bytes.length; if (size > s.size) throw new Error('research_visual_model_changed'); hash.update(bytes);
        }
      } finally {await file.close();}
      if (size !== s.size) throw new Error('research_visual_model_changed');
      files.push({path: relative, sha256: hash.digest('hex'), size});
    } else throw new Error('research_visual_model_file_unsupported');
  };
  await visit('');
  const config: unknown = JSON.parse((await readResearchFile(path, 'config.json', 1024 ** 2)).toString('utf8'));
  const expected = family === 'colpali' ? 'ColPaliForRetrieval' : 'ColQwen2ForRetrieval';
  if (!config || typeof config !== 'object' || !('architectures' in config) ||
    JSON.stringify(config.architectures) !== JSON.stringify([expected]) || 'auto_map' in config ||
    !files.some(f => f.path.endsWith('.safetensors'))) throw new Error('research_visual_model_architecture_unsupported');
  const assertCurrent = () => {signal.throwIfAborted(); for (const guard of guards) guard();};
  assertCurrent(); return {sha256: researchContentHash(JSON.stringify(files)), assertCurrent};
}
