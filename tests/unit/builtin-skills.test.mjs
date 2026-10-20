import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * Built-in skill vendoring and installation.
 *
 * The properties that matter are layout facts, not code coverage: Deep Agents only reads one level
 * of `~/.roc/skills`, so an upstream repository's `shared/` support directories and its cross-skill
 * `../sibling/…` links have to survive being flattened. These tests build a tiny upstream shape
 * that contains both reference forms, run the same materialise → archive → install pipeline the
 * app uses, and then assert that every rewritten link resolves to a file that exists.
 *
 * The second half drives `BuiltinSkillsService.ensureInstalled` against a synthetic bundled
 * catalog: auto-install sources land, licensed (`autoInstall:false`) sources stay out until
 * `restore` is called, and a reinstall keeps the user's enable toggle.
 */

let modules;
let tempRoot;
let spec;

before(async () => {
  const [catalog, archive, snapshot, service, skillState] = await Promise.all([
    importTypeScriptModule('src/main/services/builtin-skills/catalog.ts', { platform: 'node' }),
    importTypeScriptModule('src/main/services/builtin-skills/archive.ts', { platform: 'node' }),
    importTypeScriptModule('src/main/services/builtin-skills/snapshot.ts', { platform: 'node' }),
    importTypeScriptModule('src/main/services/builtin-skills/service.ts', { platform: 'node' }),
    importTypeScriptModule('src/main/services/skill-state.ts', { platform: 'node' })
  ]);
  modules = { catalog, archive, snapshot, service, skillState };
  tempRoot = mkdtempSync(join(tmpdir(), 'roc-builtin-skills-'));
  spec = {
    id: 'demo-skills',
    displayName: 'Demo Skills',
    repo: 'demo/skills',
    ref: 'main',
    license: 'Apache-2.0',
    homepage: 'https://example.invalid',
    skillRoot: 'skills',
    supportDirs: ['shared'],
    autoInstall: true,
    excludedDirectoryNames: ['tests', 'evals'],
    commit: 'commit-one',
    snapshot: null
  };
});

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function createDemoRepository(root) {
  write(
    join(root, 'skills', 'demo-writing', 'SKILL.md'),
    '---\nname: demo-writing\ndescription: Demo writing skill.\n---\n\nRead `shared/protocol.md` and [the shared core](../demo-shared/core.md).\n'
  );
  write(join(root, 'skills', 'demo-writing', 'references', 'local.md'), '# local\n');
  // Upstream drift: the directory is the identity Deep Agents/Roc use, so materialisation fixes `name`.
  write(join(root, 'skills', 'demo-shared', 'SKILL.md'), '---\nname: wrong-shared\ndescription: Shared layer.\n---\n\n# shared\n');
  write(join(root, 'skills', 'demo-shared', 'core.md'), '# core\n');
  write(join(root, 'shared', 'protocol.md'), '# protocol\n');
  write(join(root, 'skills', 'demo-writing', 'tests', 'ignored.md'), '# ignored\n');
}

test('materialise + archive + install keeps cross-skill and support references resolvable', async () => {
  const repositoryRoot = join(tempRoot, 'repo');
  createDemoRepository(repositoryRoot);

  const skillIds = modules.snapshot.discoverSkillIds(repositoryRoot, spec);
  assert.deepEqual(skillIds, ['demo-shared', 'demo-writing']);

  const snapshotDir = join(tempRoot, 'snapshot');
  const materialized = modules.snapshot.materializeSnapshot({
    repoRoot: repositoryRoot,
    spec,
    skillIds,
    outDir: snapshotDir,
    commit: spec.commit
  });
  assert.deepEqual(materialized.missing, []);
  assert.match(
    readFileSync(join(snapshotDir, 'skills', 'demo-shared', 'SKILL.md'), 'utf8'),
    /^---\nname: demo-shared\n/u,
    'frontmatter name must be normalized to the directory id'
  );
  assert.equal(existsSync(join(snapshotDir, 'skills', 'demo-writing', 'tests')), false, 'excluded directories must not be vendored');

  const archive = modules.archive.createTarGz(snapshotDir);
  const extracted = join(tempRoot, 'extracted');
  await modules.archive.extractTarGz(archive, extracted);
  assert.equal(readFileSync(join(extracted, 'skills', 'demo-writing', 'SKILL.md'), 'utf8'), readFileSync(join(snapshotDir, 'skills', 'demo-writing', 'SKILL.md'), 'utf8'));

  const skillsDir = join(tempRoot, 'skills-installed');
  mkdirSync(join(skillsDir, 'demo-writing'), { recursive: true });
  modules.skillState.writeSkillState(join(skillsDir, 'demo-writing'), {
    ...modules.skillState.createDefaultSkillState('user'),
    enabled: false
  });

  const installed = modules.snapshot.installBuiltinSnapshot({
    skillsDir,
    snapshotDir: extracted,
    spec,
    commit: spec.commit
  });
  assert.deepEqual(installed.installedSkillIds, ['demo-shared', 'demo-writing']);

  // The user's toggle survives an update; ownership is rewritten to the source.
  const state = modules.skillState.readSkillState(join(skillsDir, 'demo-writing'));
  assert.equal(state.enabled, false);
  assert.equal(state.origin, 'builtin');
  assert.equal(state.sourceId, spec.id);
  assert.equal(state.upstreamCommit, spec.commit);

  // `shared/protocol.md` was root-relative: it now lives in `_bundles/<id>/shared/`.
  const rewriting = readFileSync(join(skillsDir, 'demo-writing', 'SKILL.md'), 'utf8');
  assert.match(rewriting, /`\.\.\/_bundles\/demo-skills\/shared\/protocol\.md`/u);
  assert.match(rewriting, /\]\(\.\.\/demo-shared\/core\.md\)/u);
  assert.equal(existsSync(join(skillsDir, '_bundles', spec.id, 'shared', 'protocol.md')), true);
});

test('long archive paths survive the tar writer and reader', async () => {
  const deepDir = join(tempRoot, 'long');
  const deepPath = join(deepDir, ...Array.from({ length: 8 }, (_, index) => `segment-${index}`), 'file.md');
  write(deepPath, '# deep\n');
  const archive = modules.archive.createTarGz(deepDir);
  const out = join(tempRoot, 'long-out');
  await modules.archive.extractTarGz(archive, out);
  assert.equal(readFileSync(join(out, ...Array.from({ length: 8 }, (_, index) => `segment-${index}`), 'file.md'), 'utf8'), '# deep\n');
});

function bundledFixture(root) {
  const skillsDirSource = join(root, 'source');
  write(join(skillsDirSource, 'skills', 'demo-writing', 'SKILL.md'), '---\nname: demo-writing\ndescription: Demo.\n---\n');
  write(join(skillsDirSource, 'support', 'shared', 'protocol.md'), '# protocol\n');
  write(join(skillsDirSource, 'source.json'), JSON.stringify({ id: 'auto-source', commit: 'auto-commit' }));
  const archive = modules.archive.createTarGz(skillsDirSource);

  write(join(root, 'bundled', 'auto-source.tar.gz'), '');
  writeFileSync(join(root, 'bundled', 'auto-source.tar.gz'), archive);
  write(join(root, 'bundled', 'licensed-source.tar.gz'), '');
  writeFileSync(join(root, 'bundled', 'licensed-source.tar.gz'), archive);

  const autoSpec = {
    ...spec,
    id: 'auto-source',
    commit: 'auto-commit',
    snapshot: {
      fileName: 'auto-source.tar.gz',
      sha256: createHash('sha256').update(archive).digest('hex'),
      sizeBytes: archive.byteLength
    }
  };
  const licensedSpec = {
    ...autoSpec,
    id: 'licensed-source',
    displayName: 'Licensed Source',
    license: 'CC-BY-NC-4.0',
    autoInstall: false,
    commit: 'licensed-commit',
    snapshot: {
      fileName: 'licensed-source.tar.gz',
      sha256: createHash('sha256').update(archive).digest('hex'),
      sizeBytes: archive.byteLength
    }
  };
  modules.catalog.writeBuiltinSkillsCatalog(join(root, 'bundled'), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sources: [autoSpec, licensedSpec]
  });
  return { autoSpec, licensedSpec };
}

test('service installs auto sources, leaves licensed sources out until restore, and verifies checksums', async () => {
  const root = join(tempRoot, 'service');
  const { licensedSpec } = bundledFixture(root);
  const skillsDir = join(root, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const logger = { info() {}, warn() {}, error() {} };
  const options = {
    skillsDir,
    statePath: join(root, 'config', 'builtin-skills.json'),
    bundledRoot: join(root, 'bundled'),
    logger
  };

  const service = new modules.service.BuiltinSkillsService(options);
  await service.ensureInstalled();
  assert.equal(existsSync(join(skillsDir, 'demo-writing', 'SKILL.md')), true, 'auto source is installed');
  assert.equal(service.status().sources.find((source) => source.id === 'auto-source')?.installedCommit, 'auto-commit');

  // Licensed content is bundled but untouched until the user acts.
  const licensedBefore = service.status().sources.find((source) => source.id === 'licensed-source');
  assert.equal(licensedBefore?.installedCommit, null);
  assert.equal(existsSync(join(skillsDir, '_bundles', 'licensed-source')), false);

  await service.restore('licensed-source');
  const licensedAfter = service.status().sources.find((source) => source.id === 'licensed-source');
  assert.equal(licensedAfter?.installedCommit, licensedSpec.commit);
  assert.equal(existsSync(join(skillsDir, '_bundles', 'licensed-source', 'shared', 'protocol.md')), true);

  // A tampered snapshot is refused rather than installed.
  const tampered = new modules.service.BuiltinSkillsService({
    ...options,
    statePath: join(root, 'config', 'tampered.json')
  });
  const archivePath = join(root, 'bundled', 'auto-source.tar.gz');
  writeFileSync(archivePath, Buffer.from('not the archive'));
  await assert.rejects(async () => await tampered.ensureInstalled(), /builtin_skills_snapshot_checksum/u);
  service.shutdown();
});
