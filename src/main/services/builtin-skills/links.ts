import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, posix, sep } from 'node:path';

import type { BuiltinSkillSourceSpec } from './catalog';

/**
 * Link normalization for an installed built-in skill source.
 *
 * Upstream repositories lay their files out for their own checkout, not for `~/.roc/skills`:
 * `academic-paper/SKILL.md` says `shared/…`, `deep-research/agents/x.md` says
 * `../../shared/…`, and a Nature skill says `../nature-shared/core/…`. Roc installs the skills
 * **flat** (one directory per skill, which is the only layout Deep Agents' skill loader reads) and
 * parks repository-level support directories in `_bundles/<sourceId>/`.
 *
 * Rewriting happens on the *staging tree* at install time for one reason: the same relative path
 * means different things before and after flattening, so rewriting the vendored snapshot would
 * bake in the wrong answer. The algorithm is layout-agnostic:
 *
 * 1. map the file's installed path back to its upstream repository path;
 * 2. resolve a candidate reference against the repository path of the file, then against the
 *    repository root (inline-code references like `shared/x.md` are root-relative);
 * 3. if the resolved repository path is one Roc installs, map it forward into the staging tree and
 *    emit the relative path from the referring file;
 * 4. only rewrite when the target actually exists, so a link that was already broken upstream stays
 *    recognizably broken instead of silently pointing somewhere else.
 *
 * Markdown links, reference definitions and inline-code paths are covered. Binary assets and
 * executable scripts are copied byte-for-byte.
 */

const rewriteExtensions = new Set(['.md', '.markdown', '.mdx', '.txt']);
const installedBundlesDir = '_bundles';

export type LinkRewriteResult = {
  filesScanned: number;
  filesRewritten: number;
  linksRewritten: number;
};

type RewriteContext = {
  stagingRoot: string;
  spec: BuiltinSkillSourceSpec;
  skillIds: ReadonlySet<string>;
};

export function rewriteInstalledLinks(
  stagingRoot: string,
  spec: BuiltinSkillSourceSpec,
  skillIds: readonly string[]
): LinkRewriteResult {
  const context: RewriteContext = {
    stagingRoot,
    spec,
    skillIds: new Set(skillIds)
  };
  const result: LinkRewriteResult = { filesScanned: 0, filesRewritten: 0, linksRewritten: 0 };
  walk(stagingRoot, (absolutePath, installedRelativePath) => {
    if (!shouldRewriteFile(absolutePath)) {
      return;
    }
    result.filesScanned += 1;
    const before = readFileSync(absolutePath, 'utf8');
    const { content, rewritten } = rewriteContent(before, installedRelativePath, context);
    if (rewritten === 0) {
      return;
    }
    writeFileSync(absolutePath, content, 'utf8');
    result.filesRewritten += 1;
    result.linksRewritten += rewritten;
  });
  return result;
}

function shouldRewriteFile(path: string): boolean {
  const lower = path.toLowerCase();
  for (const extension of rewriteExtensions) {
    if (lower.endsWith(extension)) {
      return true;
    }
  }
  return false;
}

function rewriteContent(
  content: string,
  installedRelativePath: string,
  context: RewriteContext
): { content: string; rewritten: number } {
  const repoFilePath = repoPathForInstalled(installedRelativePath, context);
  if (repoFilePath === null) {
    return { content, rewritten: 0 };
  }
  let rewritten = 0;
  const replace = (target: string): string => {
    const next = rewriteTarget(target, repoFilePath, installedRelativePath, context);
    if (next === null) {
      return target;
    }
    rewritten += 1;
    return next;
  };
  let next = content.replace(/(\]\()([^()\s]+)((?:\s+"[^"]*")?\))/gu, (_match, head: string, target: string, tail: string) => {
    return `${head}${replace(target)}${tail}`;
  });
  next = next.replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/gmu, (_match, head: string, target: string) => {
    return `${head}${replace(target)}`;
  });
  next = next.replace(/`([^`\n]+)`/gu, (match: string, token: string) => {
    const candidate = token.trim();
    if (!looksLikeRepoPath(candidate)) {
      return match;
    }
    return `\`${replace(candidate)}\``;
  });
  return { content: next, rewritten };
}

function looksLikeRepoPath(token: string): boolean {
  if (token.includes('://') || token.startsWith('http') || token.includes(' ')) {
    return false;
  }
  return /^[A-Za-z0-9_.@-]+\//u.test(token) || token.startsWith('../');
}

function rewriteTarget(
  target: string,
  repoFilePath: string,
  installedRelativePath: string,
  context: RewriteContext
): string | null {
  const trimmed = target.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(trimmed)) {
    return null;
  }
  const hashIndex = trimmed.indexOf('#');
  const queryIndex = trimmed.indexOf('?');
  const suffixStart = [hashIndex, queryIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  const pathPart = suffixStart === undefined ? trimmed : trimmed.slice(0, suffixStart);
  const suffix = suffixStart === undefined ? '' : trimmed.slice(suffixStart);
  if (pathPart.length === 0) {
    return null;
  }

  const candidates = [
    posix.normalize(posix.join(posix.dirname(repoFilePath), pathPart)),
    posix.normalize(pathPart)
  ];
  for (const repoCandidate of candidates) {
    if (repoCandidate.startsWith('..') || repoCandidate === '.') {
      continue;
    }
    const installedTarget = installedPathForRepo(repoCandidate, context);
    if (installedTarget === null) {
      continue;
    }
    if (!existsSync(join(context.stagingRoot, installedTarget.split('/').join(sep)))) {
      continue;
    }
    return `${posix.relative(posix.dirname(installedRelativePath), installedTarget)}${suffix}`;
  }
  return null;
}

function repoPathForInstalled(installedRelativePath: string, context: RewriteContext): string | null {
  const parts = installedRelativePath.split('/');
  if (parts[0] === installedBundlesDir && parts[1] === context.spec.id && parts[2] !== undefined) {
    if (!context.spec.supportDirs.includes(parts[2])) {
      return null;
    }
    return parts.slice(2).join('/');
  }
  if (parts[0] !== undefined && context.skillIds.has(parts[0])) {
    return context.spec.skillRoot === '' ? parts.join('/') : [context.spec.skillRoot, ...parts].join('/');
  }
  return null;
}

function installedPathForRepo(repoRelativePath: string, context: RewriteContext): string | null {
  const root = context.spec.skillRoot;
  if (root.length > 0) {
    const prefix = `${root}/`;
    if (repoRelativePath.startsWith(prefix)) {
      const rest = repoRelativePath.slice(prefix.length).split('/');
      if (rest[0] !== undefined && context.skillIds.has(rest[0])) {
        return rest.join('/');
      }
    }
  }
  const firstSegment = repoRelativePath.split('/')[0];
  if (firstSegment !== undefined && context.spec.supportDirs.includes(firstSegment)) {
    return [installedBundlesDir, context.spec.id, repoRelativePath].join('/');
  }
  return null;
}

function walk(root: string, visit: (absolutePath: string, relativePath: string) => void): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      walk(absolutePath, (childPath, childRelative) => {
        visit(childPath, `${entry.name}/${childRelative}`);
      });
      continue;
    }
    if (entry.isFile()) {
      visit(absolutePath, entry.name);
    }
  }
}
