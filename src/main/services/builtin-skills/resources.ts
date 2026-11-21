import {existsSync, lstatSync, readFileSync, readdirSync} from 'node:fs';
import {join, posix} from 'node:path';
import type {BuiltinSkillSourceSpec} from './catalog';
import {skillReferenceTargets} from './links';

export function isBuiltinSkillResource(path: string, source: BuiltinSkillSourceSpec): boolean {
  return !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.')) &&
    (source.supportDirs.some(directory => path === `_bundles/${source.id}/${directory}` || path.startsWith(`_bundles/${source.id}/${directory}/`)) ||
      source.referenceDirs.some(directory => path === directory || path.startsWith(`${directory}/`)));
}

/** Installation records existing explicit references, not illustrative or excluded upstream paths. */
export function collectBuiltinSkillResources(root: string, skillId: string, source: BuiltinSkillSourceSpec): string[] {
  const files = new Set<string>(), visited = new Set<string>();
  let bytes = 0;
  const visit = (path: string): void => {
    if (visited.has(path)) return;
    visited.add(path);
    if (visited.size > 2000 || path.split('/').length > 32) throw new Error('skill_resource_size_limit');
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('skill_resource_symlink');
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) if (!name.startsWith('.')) visit(`${path}/${name}`);
      return;
    }
    if (!stat.isFile()) throw new Error('skill_resource_file_type');
    if (isBuiltinSkillResource(path, source)) files.add(path);
    if (!/\.(?:md|markdown|mdx|txt)$/iu.test(path)) return;
    bytes += stat.size;
    if (bytes > 64 * 1024 * 1024) throw new Error('skill_resource_size_limit');
    for (const token of skillReferenceTargets(readFileSync(absolute, 'utf8'))) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(token)) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), token.split(/[?#]/u)[0]));
      if (isBuiltinSkillResource(target, source) && existsSync(join(root, target))) visit(target);
    }
  };
  visit(skillId);
  return [...files].sort();
}
