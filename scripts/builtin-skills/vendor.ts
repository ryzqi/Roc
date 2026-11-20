import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { createTarGz, extractTarGz } from '../../src/main/services/builtin-skills/archive';
import {
  builtinSkillsArchiveFilter,
  builtinSkillsArchiveUrl,
  builtinSkillsCommitUrl,
  builtinSkillsCatalogFileName,
  builtinSkillsCatalogSchemaVersion,
  defaultBuiltinSkillSources,
  readBuiltinSkillsCatalog,
  writeBuiltinSkillsCatalog,
  type BuiltinSkillSourceSpec
} from '../../src/main/services/builtin-skills/catalog';
import { discoverSkillIds, materializeSnapshot } from '../../src/main/services/builtin-skills/snapshot';

/**
 * Vendor script for `resources/builtin-skills`.
 *
 * `pnpm sync:builtin-skills` downloads each upstream repository at its current commit, materialises
 * the same snapshot layout the runtime sync produces (`skills/<id>/…`, `support/<dir>/…`,
 * `source.json`) and writes `catalog.json`. Committing the result is what makes the skills work
 * offline on a fresh install; the runtime daily sync is the part that keeps them current.
 *
 * `--from-dir=<path>` builds from a local checkout (useful when GitHub is unreachable);
 * `--commit=<sha>` pins the recorded commit instead of asking the API.
 *
 * This file is bundled by `scripts/sync-builtin-skills.mjs` with esbuild, because Node's type
 * stripping does not resolve extensionless TS imports used by the main-process modules.
 */

type Options = {
  sourceIds: readonly string[] | null;
  commit: string | null;
  fromDir: string | null;
};

export async function main(argv: readonly string[], repoRoot: string): Promise<void> {
  const outputRoot = join(resolve(repoRoot), 'resources', 'builtin-skills');
  const options = parseOptions(argv);
  const specs = defaultBuiltinSkillSources.filter(
    (spec) => options.sourceIds === null || options.sourceIds.includes(spec.id)
  );
  if (specs.length === 0) {
    throw new Error('No matching builtin skill sources.');
  }

  mkdirSync(outputRoot, { recursive: true });
  const existing = options.sourceIds && existsSync(join(outputRoot, builtinSkillsCatalogFileName))
    ? readBuiltinSkillsCatalog(outputRoot).sources : [];
  const catalogSources = new Map(existing.map(source => [source.id, source]));
  for (const spec of specs) {
    const commit = await resolveCommit(spec, options);
    const tempRoot = mkdtempSync(join(tmpdir(), `roc-builtin-${spec.id}-`));
    try {
      const checkout = options.fromDir === null ? join(tempRoot, 'checkout') : resolve(options.fromDir);
      if (options.fromDir === null) {
        await downloadRepository(spec, commit, checkout);
      }
      const skillIds = discoverSkillIds(checkout, spec);
      if (skillIds.length === 0) {
        throw new Error(`No SKILL.md found for ${spec.id} under ${spec.skillRoot || '.'}`);
      }
      const stagingDir = join(tempRoot, 'snapshot');
      const result = materializeSnapshot({ repoRoot: checkout, spec, skillIds, outDir: stagingDir, commit });
      if (result.missing.length > 0) {
        throw new Error(`Missing skill directories for ${spec.id}: ${result.missing.join(', ')}`);
      }
      const archive = createTarGz(stagingDir);
      const fileName = `${spec.id}.tar.gz`;
      writeFileSync(join(outputRoot, fileName), archive);
      catalogSources.set(spec.id, {
        ...spec,
        commit,
        snapshot: {
          fileName,
          sha256: createHash('sha256').update(archive).digest('hex'),
          sizeBytes: archive.byteLength
        }
      });
      console.log(
        `${spec.id} @ ${commit.slice(0, 12)}: ${result.skillIds.length} skills -> ${fileName} (${(archive.byteLength / 1024 / 1024).toFixed(1)} MB)`
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  writeBuiltinSkillsCatalog(outputRoot, {
    schemaVersion: builtinSkillsCatalogSchemaVersion,
    generatedAt: new Date().toISOString(),
    sources: [...catalogSources.values()]
  });
  console.log(`Wrote catalog at ${outputRoot}`);
}

function parseOptions(argv: readonly string[]): Options {
  let sourceIds: string[] | null = null;
  let commit: string | null = null;
  let fromDir: string | null = null;
  for (const argument of argv) {
    if (argument.startsWith('--source=')) {
      sourceIds = argument.slice('--source='.length).split(',').filter((entry) => entry.length > 0);
      continue;
    }
    if (argument.startsWith('--commit=')) {
      commit = argument.slice('--commit='.length);
      continue;
    }
    if (argument.startsWith('--from-dir=')) {
      fromDir = argument.slice('--from-dir='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { sourceIds, commit, fromDir };
}

async function resolveCommit(spec: BuiltinSkillSourceSpec, options: Options): Promise<string> {
  if (options.commit !== null) {
    return options.commit;
  }
  const response = await fetchWithRetry(builtinSkillsCommitUrl(spec), {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'roc-builtin-skills-vendor' }
  });
  if (!response.ok) {
    throw new Error(`Commit request failed for ${spec.id}: ${response.status}`);
  }
  const payload = (await response.json()) as { sha?: unknown };
  if (typeof payload.sha !== 'string') {
    throw new Error(`Commit response invalid for ${spec.id}`);
  }
  return payload.sha;
}

async function downloadRepository(spec: BuiltinSkillSourceSpec, commit: string, destination: string): Promise<void> {
  const response = await fetchWithRetry(builtinSkillsArchiveUrl(spec, commit), {
    headers: { 'User-Agent': 'roc-builtin-skills-vendor' }
  });
  if (!response.ok) {
    throw new Error(`Archive request failed for ${spec.id}: ${response.status}`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  await extractTarGz(archive, destination, {
    stripTopLevel: true,
    filter: builtinSkillsArchiveFilter(spec)
  });
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5 * 60 * 1000) });
      if (response.status >= 500 || response.status === 429) {
        lastError = new Error(`HTTP ${response.status}`);
      } else {
        return response;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500 * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
