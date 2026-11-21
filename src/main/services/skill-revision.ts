import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readSkillState, skillStateFileName } from './skill-state';
import {defaultBuiltinSkillSources} from './builtin-skills/catalog';
import {isBuiltinSkillResource} from './builtin-skills/resources';

export type SkillResourceRevision = {path: string; contentHash: string; license: string; licenseHash: string};
export type SkillContentRevision = {
  contentHash: string;
  license: string | null;
  licenseHash: string | null;
  files: { path: string; hash: string }[];
  resources: SkillResourceRevision[];
};

const ignored = new Set(['.git', '.DS_Store', skillStateFileName]);
const maxSkillRevisionBytes = 64 * 1024 * 1024;

export function hashSkillBytes(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Freeze selected bytes and explicit same-source support references with bounded, no-follow I/O. */
export function readSkillRevision(root: string): SkillContentRevision {
  const files: SkillContentRevision['files'] = [];
  let skillText = '';
  let bytes = 0;
  let entries = 0;
  const buffer = Buffer.alloc(65536);
  const read = (path: string): Buffer => {
    const parts: Buffer[] = [];
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      let count: number;
      while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
        bytes += count;
        if (bytes > maxSkillRevisionBytes) throw new Error('skill_revision_size_limit');
        parts.push(Buffer.from(buffer.subarray(0, count)));
      }
    } finally { closeSync(descriptor); }
    return Buffer.concat(parts);
  };
  const countEntry = (): void => {if (++entries > 2000) throw new Error('skill_revision_size_limit');};
  const collect = (directory: string, prefix: string, depth = 0): void => {
    if (depth > 32) throw new Error('skill_revision_depth_limit');
    if (lstatSync(directory).isSymbolicLink()) throw new Error('skill_revision_symlink');
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (ignored.has(entry.name)) continue;
      countEntry();
      const path = join(directory, entry.name);
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('skill_revision_symlink');
      if (entry.isDirectory()) { collect(path, relative + '/', depth + 1); continue; }
      if (!entry.isFile()) throw new Error('skill_revision_file_type');
      const content = read(path);
      files.push({ path: relative, hash: hashSkillBytes(content) });
      if (relative === 'SKILL.md') skillText = content.toString('utf8');
    }
  };
  collect(root, '');
  if (!files.some(file => file.path === 'SKILL.md')) throw new Error('skill_revision_manifest_missing');
  const metadata = skillText.split('---')[1] ?? '';
  const declaredLicense = /^license:\s*(.+)$/m.exec(metadata)?.[1]?.trim() ?? null;
  const licenses = files.filter(file => /^licen[sc]e(?:[._-].*)?$/i.test(file.path));
  const state = readSkillState(root);
  const source = state.origin === 'builtin' ? defaultBuiltinSkillSources.find(item => item.id === state.sourceId) : undefined;
  const skillsRoot = realpathSync(dirname(root));
  const resources = new Map<string, SkillResourceRevision>();
  if (state.origin === 'builtin' && state.readonlyResources === null) throw new Error('skill_resource_manifest_required:reinstall_builtin_skills');
  for (const path of state.readonlyResources ?? []) {
    if (source === undefined || source.license === null || state.upstreamRepo !== source.repo || state.upstreamCommit === null ||
        !isBuiltinSkillResource(path, source) || resources.has(path)) throw new Error('skill_resource_source_denied');
    countEntry();
    let absolute = skillsRoot;
    try {
      for (const part of path.split('/')) {
        absolute = join(absolute, part);
        if (lstatSync(absolute).isSymbolicLink()) throw new Error('skill_revision_symlink');
      }
      if (!lstatSync(absolute).isFile()) throw new Error('skill_revision_file_type');
      const content = read(absolute), license = source.license;
      resources.set(path, {path, contentHash: hashSkillBytes(content), license, licenseHash: hashSkillBytes(license)});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`skill_resource_missing:${path}`);
      throw error;
    }
  }
  return { contentHash: hashSkillBytes(JSON.stringify(files)), files,
    license: declaredLicense,
    licenseHash: licenses.length > 0 ? hashSkillBytes(JSON.stringify(licenses)) : declaredLicense === null ? null : hashSkillBytes(declaredLicense),
    resources: [...resources.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}
