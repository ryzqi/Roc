import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Built-in skill sources: the two upstream repositories Roc vendors.
 *
 * The catalog is the single source of truth for *how* a repository maps into `~/.roc/skills`:
 * which directory holds the skills, which repository-root directories are support material, and
 * which license the content carries. The vendor script and the runtime sync both read it, so a
 * repository that changes shape only needs one edit here.
 *
 * `skillRoot` matters because the two upstreams disagree: nature-skills keeps skills under
 * `skills/<id>/`, academic-research-skills keeps them at `./<id>/` and exposes `skills/<id>` as a
 * symlink. Installing through the symlinks would give the same result but would drop the
 * repository-root support directories that the skills reference.
 */

export const builtinSkillsCatalogFileName = 'catalog.json';
export const builtinSkillsCatalogSchemaVersion = 1;

export type BuiltinSkillSourceSpec = {
  /** Stable id; also the directory name under `resources/builtin-skills` and `_bundles/`. */
  id: string;
  displayName: string;
  /** `owner/name` on GitHub, used for the API and codeload URLs. */
  repo: string;
  ref: string;
  license: string | null;
  homepage: string | null;
  /** Repository-relative directory holding the skill directories (`''` = repository root). */
  skillRoot: string;
  /** Repository-root directories copied to `_bundles/<id>/` and referenced by the skills. */
  supportDirs: readonly string[];
  /**
   * Whether the license allows shipping the content enabled-by-default inside Roc.
   * `false` sources are bundled but only installed after an explicit user action.
   */
  autoInstall: boolean;
  /** Directory names never copied from upstream (test fixtures and evaluation harnesses). */
  excludedDirectoryNames: readonly string[];
  /** Upstream commit the bundled snapshot was built from (`''` when no snapshot is bundled). */
  commit: string;
  /** Bundled snapshot archive, relative to the catalog directory; `null` when absent. */
  snapshot: { fileName: string; sha256: string; sizeBytes: number } | null;
};

export type BuiltinSkillsCatalog = {
  schemaVersion: typeof builtinSkillsCatalogSchemaVersion;
  generatedAt: string;
  sources: readonly BuiltinSkillSourceSpec[];
};

const commonExcludedDirectoryNames = ['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'tests', 'evals'];

export const defaultBuiltinSkillSources: readonly BuiltinSkillSourceSpec[] = [
  {
    id: 'nature-skills',
    displayName: 'Nature Skills',
    repo: 'Yuan1z0825/nature-skills',
    ref: 'main',
    license: 'Apache-2.0',
    homepage: 'https://github.com/Yuan1z0825/nature-skills',
    skillRoot: 'skills',
    supportDirs: [],
    autoInstall: true,
    excludedDirectoryNames: commonExcludedDirectoryNames,
    commit: '',
    snapshot: null
  },
  {
    id: 'academic-research-skills',
    displayName: 'Academic Research Skills',
    repo: 'Imbad0202/academic-research-skills',
    ref: 'main',
    // CC BY-NC 4.0: bundled, but installed only after the user accepts the non-commercial terms.
    license: 'CC-BY-NC-4.0',
    homepage: 'https://github.com/Imbad0202/academic-research-skills',
    skillRoot: '',
    supportDirs: ['shared', 'tools', 'commands', 'agents', 'scripts', 'docs'],
    autoInstall: false,
    excludedDirectoryNames: [...commonExcludedDirectoryNames, 'audits', 'examples'],
    commit: '',
    snapshot: null
  }
];

export function readBuiltinSkillsCatalog(root: string): BuiltinSkillsCatalog {
  const path = join(root, builtinSkillsCatalogFileName);
  if (!existsSync(path)) {
    throw new Error('builtin_skills_catalog_missing');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('builtin_skills_catalog_invalid');
  }
  return parseBuiltinSkillsCatalog(parsed);
}

export function writeBuiltinSkillsCatalog(root: string, catalog: BuiltinSkillsCatalog): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, builtinSkillsCatalogFileName), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}

export function parseBuiltinSkillsCatalog(value: unknown): BuiltinSkillsCatalog {
  if (typeof value !== 'object' || value === null) {
    throw new Error('builtin_skills_catalog_invalid');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== builtinSkillsCatalogSchemaVersion || !Array.isArray(record.sources)) {
    throw new Error('builtin_skills_catalog_invalid');
  }
  const sources = record.sources.map((entry) => parseSource(entry));
  return {
    schemaVersion: builtinSkillsCatalogSchemaVersion,
    generatedAt: typeof record.generatedAt === 'string' ? record.generatedAt : '',
    sources
  };
}

function parseSource(value: unknown): BuiltinSkillSourceSpec {
  if (typeof value !== 'object' || value === null) {
    throw new Error('builtin_skills_catalog_source_invalid');
  }
  const record = value as Record<string, unknown>;
  const id = requireString(record.id);
  const displayName = requireString(record.displayName);
  const repo = requireString(record.repo);
  const ref = requireString(record.ref);
  return {
    id,
    displayName,
    repo,
    ref,
    license: typeof record.license === 'string' ? record.license : null,
    homepage: typeof record.homepage === 'string' ? record.homepage : null,
    skillRoot: typeof record.skillRoot === 'string' ? record.skillRoot : '',
    supportDirs: readStringArray(record.supportDirs),
    autoInstall: record.autoInstall !== false,
    excludedDirectoryNames:
      record.excludedDirectoryNames === undefined
        ? commonExcludedDirectoryNames
        : readStringArray(record.excludedDirectoryNames),
    commit: typeof record.commit === 'string' ? record.commit : '',
    snapshot: readSnapshot(record.snapshot)
  };
}

function readSnapshot(value: unknown): { fileName: string; sha256: string; sizeBytes: number } | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.fileName !== 'string' || typeof record.sha256 !== 'string') {
    return null;
  }
  return {
    fileName: record.fileName,
    sha256: record.sha256,
    sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : 0
  };
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('builtin_skills_catalog_source_invalid');
  }
  return value;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** GitHub API endpoint used to compare the installed commit with upstream. */
export function builtinSkillsCommitUrl(spec: BuiltinSkillSourceSpec): string {
  return `https://api.github.com/repos/${spec.repo}/commits/${encodeURIComponent(spec.ref)}`;
}

/** Archive download used when the upstream commit moved. */
export function builtinSkillsArchiveUrl(spec: BuiltinSkillSourceSpec): string {
  return `https://codeload.github.com/${spec.repo}/tar.gz/refs/heads/${encodeURIComponent(spec.ref)}`;
}

/**
 * Which archive entries are worth extracting for a source.
 *
 * A non-empty `skillRoot` (`skills/` for nature-skills) narrows the download to that subtree plus
 * the support directories. An empty `skillRoot` (academic-research-skills keeps its skills at the
 * repository root) cannot be narrowed that way — its skill directories are just the top-level
 * entries that contain `SKILL.md` — so everything is extracted and the copy step filters.
 */
export function builtinSkillsArchiveFilter(spec: BuiltinSkillSourceSpec): (path: string) => boolean {
  return (path: string): boolean => {
    const slash = path.indexOf('/');
    const relative = slash === -1 ? '' : path.slice(slash + 1);
    if (relative.length === 0) {
      return false;
    }
    if (spec.skillRoot.length === 0) {
      return true;
    }
    if (relative === spec.skillRoot || relative.startsWith(`${spec.skillRoot}/`)) {
      return true;
    }
    return spec.supportDirs.some((dir) => relative === dir || relative.startsWith(`${dir}/`));
  };
}
