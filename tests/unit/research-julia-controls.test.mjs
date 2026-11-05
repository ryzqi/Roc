import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, realpath, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadResearchTestApi } from './fixtures/research-test-kit.mjs';

let api, root;
before(async () => { api = await loadResearchTestApi(); root = await realpath(await mkdtemp('/private/tmp/roc-julia-controls-')); });
after(async () => { await rm(root, { recursive: true, force: true }); api.dispose(); });
async function workspace(files) {
  const directory = await mkdtemp(join(root, 'project-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(directory, path, '..'), { recursive: true }); await writeFile(join(directory, path), content);
  }
  return directory;
}
function discover(directory, signal = new AbortController().signal) { return api.discoverJuliaEnvironmentControls(directory, '1.13.1', signal); }
const lock = 'julia_version = "1.13.1"\nmanifest_format = "2.0"\n';

test('Julia controls follow native project/current-series manifest priority and freeze only declared workspace/preferences/artifact files', async () => {
  const directory = await workspace({
    'JuliaProject.toml': '[workspace]\nprojects = ["nested"]\n',
    'Project.toml': 'name = "Unselected"\n', 'Manifest-v1.13.toml': lock,
    'JuliaManifest-v1.12.toml': 'julia_version = "1.12.0"\n', 'Manifest.toml': 'julia_version = "1.12.0"\n',
    'nested/Project.toml': '[workspace]\nprojects = ["deeper"]\n', 'nested/deeper/JuliaProject.toml': 'name = "Deep"\n',
    'JuliaLocalPreferences.toml': '[Fixture]\nthreads = 2\n', 'nested/Artifacts.toml': '[fixture]\ngit-tree-sha1 = "fixture"\n',
    'undeclared.toml': 'private = "synthetic"\n'
  });
  const result = await discover(directory);
  assert.deepEqual(result.lockFiles.map(file => file.path), [
    'JuliaLocalPreferences.toml', 'JuliaProject.toml', 'Manifest-v1.13.toml',
    'nested/Artifacts.toml', 'nested/deeper/JuliaProject.toml', 'nested/Project.toml'
  ]);
  for (const file of result.lockFiles) { assert.equal(file.sha256.length, 64); assert.ok(file.size > 0); }
  assert.deepEqual(result.metadataFiles.map(file => file.path), ['JuliaProject.toml', 'nested/deeper/JuliaProject.toml', 'nested/Project.toml']);
});

test('Julia declared manifest and relative sources resolve inside project without granting package directories', async () => {
  const directory = await workspace({
    'Project.toml': 'manifest = "locks/custom.toml"\n[sources.Local]\npath = "local"\n',
    'locks/custom.toml': `${lock}[[deps.Local]]\npath = "../local"\n`,
    'local/JuliaProject.toml': 'name = "Local"\n', 'local/Project.toml': 'name = "Unselected"\n',
    'local/private.txt': 'synthetic private file', 'Manifest-v1.13.toml': 'julia_version = "1.12.0"\n'
  });
  const result = await discover(directory);
  assert.deepEqual(result.lockFiles.map(file => file.path), ['locks/custom.toml', 'Project.toml']);
  assert.deepEqual(result.metadataFiles.map(file => file.path), ['local/JuliaProject.toml', 'Project.toml']);
});

test('Julia workspace members declared through multiple branches are frozen once while actual cycles still fail', async () => {
  const directory = await workspace({
    'Project.toml': '[workspace]\nprojects = ["nested", "nested/deeper"]\n',
    'nested/Project.toml': '[workspace]\nprojects = ["deeper"]\n', 'nested/deeper/Project.toml': 'name = "Shared"\n',
    'Manifest.toml': lock
  });
  const result = await discover(directory);
  assert.deepEqual(result.lockFiles.map(file => file.path), ['Manifest.toml', 'nested/deeper/Project.toml', 'nested/Project.toml', 'Project.toml']);
});

test('Julia explicit manifest must exist and match actual interpreter version; missing lock and malformed declarations fail', async () => {
  for (const [files, error] of [
    [{ 'Project.toml': '', 'Manifest.toml': 'julia_version = "1.12.0"\n' }, /runtime_version_mismatch/],
    [{ 'Project.toml': '' }, /lock_required/],
    [{ 'Project.toml': 'manifest = "missing.toml"\n', 'Manifest.toml': lock }, /ENOENT/],
    [{ 'Project.toml': '[workspace]\nprojects = "nested"\n', 'Manifest.toml': lock }, /invalid_type/],
    [{ 'Project.toml': 'malformed = [', 'Manifest.toml': lock }, /Invalid TOML|array|end of/i]
  ]) await assert.rejects(discover(await workspace(files)), error);
});

test('Julia workspace and manifest path declarations cannot read outside workspace or follow symlinked local packages', async () => {
  for (const declaration of ['manifest = "../outside.toml"\n', 'manifest = "/private/tmp/outside.toml"\n',
    '[workspace]\nprojects = ["../outside"]\n', '[sources.Local]\npath = "../outside"\n']) {
    await assert.rejects(discover(await workspace({ 'Project.toml': declaration, 'Manifest.toml': lock })), /absolute_dependency_path|relative_path_invalid/);
  }
  const directory = await workspace({ 'Project.toml': '[sources.Local]\npath = "local"\n', 'Manifest.toml': lock });
  const external = await workspace({ 'Project.toml': 'name = "External"\n' });
  await symlink(external, join(directory, 'local'), 'dir');
  await assert.rejects(discover(directory), /research_path_symlink/);
});

test('Julia workspace cycles, excessive declared projects and cancelled discovery fail without an environment receipt', async () => {
  await assert.rejects(discover(await workspace({
    'Project.toml': '[workspace]\nprojects = ["nested"]\n', 'nested/Project.toml': '[workspace]\nprojects = [".."]\n', 'Manifest.toml': lock
  })), /workspace_cycle/);
  await assert.rejects(discover(await workspace({
    'Project.toml': `[workspace]\nprojects = [${Array(1001).fill('"nested"').join(',')}]\n`, 'Manifest.toml': lock
  })), /too_big/);
  const controller = new AbortController(); controller.abort(new Error('controlled_julia_abort'));
  await assert.rejects(discover(await workspace({ 'Project.toml': '', 'Manifest.toml': lock }), controller.signal), /controlled_julia_abort/);
});

test('Julia project controls support native generic and AppManifest choices when no current-series manifest exists', async () => {
  for (const name of ['JuliaManifest.toml', 'Manifest.toml', 'AppManifest.toml']) {
    const result = await discover(await workspace({ 'Project.toml': '', [name]: lock }));
    assert.ok(result.lockFiles.some(file => file.path === name));
  }
});

test('Julia version probe accepts actual version output and rejects banner noise or missing version', () => {
  assert.equal(api.parseJuliaRuntimeVersion('julia version 1.13.1\n'), '1.13.1');
  assert.equal(api.parseJuliaRuntimeVersion('julia version 1.14.0-rc1\n'), '1.14.0-rc1');
  for (const text of ['', '1.13.1', 'noise\njulia version 1.13.1\n', 'julia version 1.13\n']) {
    assert.throws(() => api.parseJuliaRuntimeVersion(text), /runtime_version_invalid/);
  }
});
