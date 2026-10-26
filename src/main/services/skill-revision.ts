import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { skillStateFileName } from './skill-state';

export type SkillContentRevision = {
  contentHash: string;
  license: string | null;
  licenseHash: string | null;
  files: { path: string; hash: string }[];
};

const ignored = new Set(['.git', '.DS_Store', skillStateFileName]);
const maxSkillRevisionBytes = 64 * 1024 * 1024;

export function hashSkillBytes(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Freeze executable skill bytes, with bounded I/O and no symlink traversal. */
export function readSkillRevision(root: string): SkillContentRevision {
  const files: SkillContentRevision['files'] = [];
  let bytes = 0;
  let entries = 0;
  const buffer = Buffer.alloc(65536);
  const collect = (directory: string, prefix: string, depth = 0): void => {
    if (depth > 32) throw new Error('skill_revision_depth_limit');
    if (lstatSync(directory).isSymbolicLink()) throw new Error('skill_revision_symlink');
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (ignored.has(entry.name)) continue;
      if (++entries > 2000) throw new Error('skill_revision_size_limit');
      const path = join(directory, entry.name);
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('skill_revision_symlink');
      if (entry.isDirectory()) { collect(path, relative + '/', depth + 1); continue; }
      if (!entry.isFile()) throw new Error('skill_revision_file_type');
      
      if (bytes > maxSkillRevisionBytes || files.length >= 2000) throw new Error('skill_revision_size_limit');
      const hash = createHash('sha256');
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        let count: number;
        while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
          bytes += count;
          if (bytes > maxSkillRevisionBytes) throw new Error('skill_revision_size_limit');
          hash.update(buffer.subarray(0, count));
        }
      } finally { closeSync(descriptor); }
      files.push({ path: relative, hash: hash.digest('hex') });
    }
  };
  collect(root, '');
  const skillFile = files.find(file => file.path === 'SKILL.md');
  if (skillFile === undefined) throw new Error('skill_revision_manifest_missing');
  const metadata = readFileSync(join(root, 'SKILL.md'), 'utf8').split('---')[1] ?? '';
  const declaredLicense = /^license:\s*(.+)$/m.exec(metadata)?.[1]?.trim() ?? null;
  const licenses = files.filter(file => /^licen[sc]e(?:[._-].*)?$/i.test(file.path));
  return { contentHash: hashSkillBytes(JSON.stringify(files)), files,
    license: declaredLicense,
    licenseHash: licenses.length > 0 ? hashSkillBytes(JSON.stringify(licenses)) : declaredLicense === null ? null : hashSkillBytes(declaredLicense) };
}
