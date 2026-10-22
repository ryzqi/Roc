import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { BuiltinSkillSourceSpec } from './catalog';
import { rewriteInstalledLinks, type LinkRewriteResult } from './links';
import { readSkillState, writeSkillState } from '../skill-state';

/**
 * Materialise and install a built-in skill source.
 *
 * Two steps, on purpose:
 *
 *  1. **Materialise** turns an upstream repository checkout into a layout-independent snapshot
 *     (`skills/<id>/…`, `support/<dir>/…`). The same snapshot format is produced by the vendor
 *     script for `resources/builtin-skills`, so the bundled and downloaded paths cannot drift.
 *  2. **Install** copies a snapshot into `~/.roc/skills` flat (Deep Agents only reads one level),
 *     parks support directories in `_bundles/<sourceId>/`, rewrites intra-repo references, and
 *     swaps each directory in atomically while preserving the user's `roc.skill.json` toggle.
 *
 * Atomicity is per skill directory: a failed update leaves the previously installed copy in place
 * rather than a half-copied skill. Staging lives inside `skillsDir` so the final rename stays on
 * the same filesystem.
 */

export const bundledSkillsDirName = 'skills';
export const bundledSupportDirName = 'support';

export type SnapshotSkillIds = readonly string[];

export function discoverSkillIds(repoRoot: string, spec: BuiltinSkillSourceSpec): string[] {
  const skillsRoot = join(repoRoot, spec.skillRoot);
  if (!existsSync(skillsRoot)) {
    return [];
  }
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export function materializeSnapshot(input: {
  repoRoot: string;
  spec: BuiltinSkillSourceSpec;
  skillIds: SnapshotSkillIds;
  outDir: string;
  commit: string;
}): { skillIds: string[]; missing: string[] } {
  rmSync(input.outDir, { recursive: true, force: true });
  mkdirSync(input.outDir, { recursive: true });

  const missing: string[] = [];
  for (const skillId of input.skillIds) {
    const source = join(input.repoRoot, input.spec.skillRoot, skillId);
    if (!existsSync(join(source, 'SKILL.md'))) {
      missing.push(skillId);
      continue;
    }
    const target = join(input.outDir, bundledSkillsDirName, skillId);
    copyTree(source, target, input.spec);
    normalizeSkillName(target, skillId);
  }

  for (const supportDir of input.spec.supportDirs) {
    const source = join(input.repoRoot, supportDir);
    if (!existsSync(source)) {
      continue;
    }
    copyTree(source, join(input.outDir, bundledSupportDirName, supportDir), input.spec);
  }

  writeFileSync(
    join(input.outDir, 'source.json'),
    `${JSON.stringify(
      {
        id: input.spec.id,
        repo: input.spec.repo,
        ref: input.spec.ref,
        commit: input.commit,
        skillRoot: input.spec.skillRoot,
        supportDirs: input.spec.supportDirs,
        skillIds: input.skillIds.filter((skillId) => !missing.includes(skillId))
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  return { skillIds: input.skillIds.filter((skillId) => !missing.includes(skillId)), missing };
}

export type InstallBuiltinSnapshotResult = {
  installedSkillIds: string[];
  removedSkillIds: string[];
  links: LinkRewriteResult;
  stagingRoot: string;
};

export function installBuiltinSnapshot(input: {
  skillsDir: string;
  snapshotDir: string;
  spec: BuiltinSkillSourceSpec;
  commit: string;
}): InstallBuiltinSnapshotResult {
  const snapshotSkillsDir = join(input.snapshotDir, bundledSkillsDirName);
  const snapshotSupportDir = join(input.snapshotDir, bundledSupportDirName);
  const skillIds = existsSync(snapshotSkillsDir)
    ? readdirSync(snapshotSkillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(snapshotSkillsDir, entry.name, 'SKILL.md')))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right))
    : [];

  const stagingRoot = join(input.skillsDir, `.builtin-staging-${input.spec.id}-${process.pid}-${Date.now()}`);
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });

  try {
    for (const skillId of skillIds) {
      copyTree(join(snapshotSkillsDir, skillId), join(stagingRoot, skillId), input.spec);
      const previous = readSkillState(join(input.skillsDir, skillId));
      writeSkillState(join(stagingRoot, skillId), {
        ...previous,
        origin: 'builtin',
        sourceId: input.spec.id,
        upstreamRepo: input.spec.repo,
        upstreamCommit: input.commit
      });
    }

    const supportTarget = join(stagingRoot, '_bundles', input.spec.id);
    if (existsSync(snapshotSupportDir)) {
      mkdirSync(dirname(supportTarget), { recursive: true });
      cpSync(snapshotSupportDir, supportTarget, { recursive: true });
    }

    const links = rewriteInstalledLinks(stagingRoot, input.spec, skillIds);

    const removedSkillIds: string[] = [];
    for (const previousSkillId of readManagedSkillIds(input.skillsDir, input.spec.id)) {
      if (skillIds.includes(previousSkillId)) {
        continue;
      }
      rmSync(join(input.skillsDir, previousSkillId), { recursive: true, force: true });
      removedSkillIds.push(previousSkillId);
    }

    for (const skillId of skillIds) {
      const target = join(input.skillsDir, skillId);
      rmSync(target, { recursive: true, force: true });
      renameSync(join(stagingRoot, skillId), target);
    }

    const bundlesTarget = join(input.skillsDir, '_bundles', input.spec.id);
    rmSync(bundlesTarget, { recursive: true, force: true });
    if (existsSync(supportTarget)) {
      mkdirSync(dirname(bundlesTarget), { recursive: true });
      renameSync(supportTarget, bundlesTarget);
    }

    return { installedSkillIds: skillIds, removedSkillIds, links, stagingRoot };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

/** Skill ids on disk that carry this source's origin marker (used to prune renamed skills). */
export function readManagedSkillIds(skillsDir: string, sourceId: string): string[] {
  if (!existsSync(skillsDir)) {
    return [];
  }
  const managed: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === '_bundles') {
      continue;
    }
    const state = readSkillState(join(skillsDir, entry.name));
    if (state.origin === 'builtin' && state.sourceId === sourceId) {
      managed.push(entry.name);
    }
  }
  return managed.sort((left, right) => left.localeCompare(right));
}

/**
 * Deep Agents identifies a skill by its frontmatter `name`, and `SkillService` refuses a directory
 * whose `name` differs from it. Upstream can drift (nature-skills shipped `nature-proposal-writer`
 * with `name: researchwrite`), which would install a permanently "invalid" skill; rewriting the
 * one field during materialisation keeps the directory the identity without touching the prose.
 */
function normalizeSkillName(skillDir: string, skillId: string): void {
  const skillFile = join(skillDir, 'SKILL.md');
  if (!existsSync(skillFile)) {
    return;
  }
  const content = readFileSync(skillFile, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  if (match === null) {
    return;
  }
  const frontmatter = match[1] ?? '';
  const nameLine = /^name:\s*(.*)$/mu.exec(frontmatter);
  const currentName = nameLine?.[1]?.trim().replace(/^["']|["']$/gu, '') ?? '';
  if (currentName === skillId) {
    return;
  }
  const nextFrontmatter =
    nameLine === null
      ? `name: ${skillId}\n${frontmatter}`
      : frontmatter.replace(/^name:\s*.*$/mu, `name: ${skillId}`);
  const nextContent = `---\n${nextFrontmatter}\n---${content.slice(match[0].length)}`;
  writeFileSync(skillFile, nextContent, 'utf8');
}

function copyTree(source: string, target: string, spec: BuiltinSkillSourceSpec): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const entrySource = join(source, entry.name);
    const entryTarget = join(target, entry.name);
    if (entry.isDirectory()) {
      if (spec.excludedDirectoryNames.includes(entry.name)) {
        continue;
      }
      copyTree(entrySource, entryTarget, spec);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    cpSync(entrySource, entryTarget);
  }
}
