import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { build } from 'esbuild';
const entry = 'src/main/plugins/research/python-installer-process.ts';
const compiled = await build({ stdin: { contents: `${await readFile(entry, 'utf8')}\nexport { assertInstallerWriteLimits, validateArguments, installerProfile };`,
  resolveDir: dirname(join(process.cwd(), entry)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const pin = JSON.parse(await readFile('resources/research-runtime/python-tools.lock.json', 'utf8'));
const budget = { maxFileBytes: 64, maxTotalBytes: 128, maxFiles: 4, maxEntries: 8 };
async function fixture(run) {
  const root = await realpath(await mkdtemp('/private/tmp/roc-installer-unit-'));
  try {
    const managed = join(root, 'python'), writable = join(root, 'output');
    await mkdir(managed); await mkdir(writable);
    await run({ root, managed, writable });
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('installer audit accepts only links resolving inside managed Python or explicit writable roots', () => fixture(async ({ managed, writable }) => {
  await writeFile(join(managed, 'python'), 'python');
  await writeFile(join(writable, 'local'), 'local');
  await symlink(join(managed, 'python'), join(writable, 'python'));
  await symlink('local', join(writable, 'local-link'));
  await api.assertInstallerWriteLimits([writable], managed, budget);
}));
test('installer audit rejects sibling-prefix escape, dangling links and hardlinks', () => fixture(async ({ root, managed, writable }) => {
  await mkdir(`${managed}-outside`); await writeFile(join(`${managed}-outside`, 'secret'), 'secret');
  const target = join(writable, 'link');
  await symlink(join(`${managed}-outside`, 'secret'), target);
  await assert.rejects(api.assertInstallerWriteLimits([writable], managed, budget), /symlink_escape/);
  await rm(target); await symlink(join(managed, 'missing'), target);
  await assert.rejects(api.assertInstallerWriteLimits([writable], managed, budget), { code: 'ENOENT' });
  await rm(target); await writeFile(join(root, 'shared'), 'shared'); await link(join(root, 'shared'), target);
  await assert.rejects(api.assertInstallerWriteLimits([writable], managed, budget), /write_limit/);
}));
test('installer audit retains per-file, aggregate, file-count and entry-count limits', () => fixture(async ({ managed, writable }) => {
  await writeFile(join(writable, 'large'), Buffer.alloc(65));
  await assert.rejects(api.assertInstallerWriteLimits([writable], managed, budget), /write_limit/);
  await rm(join(writable, 'large'));
  for (let i = 0; i < 3; i++) await writeFile(join(writable, `file-${i}`), Buffer.alloc(48));
  await assert.rejects(api.assertInstallerWriteLimits([writable], managed, budget), /write_limit/);
  await assert.rejects(api.assertInstallerWriteLimits([writable], managed, { ...budget, maxTotalBytes: 256, maxFiles: 2 }), /write_limit/);
  await assert.rejects(api.assertInstallerWriteLimits([writable], managed, { ...budget, maxTotalBytes: 256, maxEntries: 2 }), /entry_limit/);
}));
test('installer audit refuses a symlink writable root', () => fixture(async ({ root, managed, writable }) => {
  await symlink(writable, join(root, 'alias'));
  await assert.rejects(api.assertInstallerWriteLimits([join(root, 'alias')], managed, budget), /directory_invalid/);
}));
test('uv arguments require exact Python key and forbid clearing, seeding, arbitrary indexes and command injection', async () => {
  const managed = '/private/app/python', cache = '/private/app/cache', cwd = '/private/project', python = join(managed, pin.python.key, pin.python.executable.path);
  const base = { args: ['venv', join(cwd, '.venv'), '--no-project', '--no-config', '--no-python-downloads', '--python', pin.python.key], network: 'none' };
  assert.equal((await api.validateArguments(base, '/uv', managed, cache, cwd, python)).operation, 'venv');
  for (const forbidden of [['--clear'], ['--seed'], ['--allow-existing'], ['--index', 'https://untrusted.test'], ['--python', python], ['--', 'extra']]) {
    await assert.rejects(api.validateArguments({ ...base, args: [...base.args, ...forbidden] }, '/uv', managed, cache, cwd, python), /arguments_invalid/);
  }
  await assert.rejects(api.validateArguments({ ...base, args: ['run', 'untrusted.py'] }, '/uv', managed, cache, cwd, python), /operation_invalid/);
});
test('sync fixes PyPI and requires wheel-only project exclusion, copy mode, lock and offline consistency', async () => {
  const managed = '/private/app/python', cache = '/private/app/cache', cwd = '/private/project', python = join(managed, pin.python.key, pin.python.executable.path);
  const args = ['sync', '--python', pin.python.key, '--project', cwd, '--no-build', '--no-config', '--no-python-downloads', '--locked',
    '--no-install-project', '--no-install-workspace', '--no-default-groups', '--link-mode', 'copy'];
  const result = await api.validateArguments({ args, network: 'registry' }, '/uv', managed, cache, cwd, python);
  assert.deepEqual(result.args.slice(-4), ['--default-index', 'https://pypi.org/simple', '--keyring-provider', 'disabled']);
  for (const required of ['--no-build', '--locked', '--no-install-project', '--no-install-workspace', '--no-default-groups']) {
    await assert.rejects(api.validateArguments({ args: args.filter(value => value !== required), network: 'registry' }, '/uv', managed, cache, cwd, python), /arguments_invalid/);
  }
  await assert.rejects(api.validateArguments({ args, network: 'none' }, '/uv', managed, cache, cwd, python), /arguments_invalid/);
  await assert.rejects(api.validateArguments({ args: [...args, '--default-index', 'https://untrusted.test'], network: 'registry' }, '/uv', managed, cache, cwd, python), /arguments_invalid/);
  await api.validateArguments({ args: [...args, '--offline', '--check'], network: 'none' }, '/uv', managed, cache, cwd, python);
});
test('probe requires isolated stdlib flags and cannot request network', async () => {
  const python = '/private/app/python/exact/bin/python';
  const request = { args: ['-I', '-S', '-B', '-X', 'utf8', '-c', 'print(1)', '/data/input.toml'], network: 'none' };
  assert.equal((await api.validateArguments(request, python, '/managed', '/cache', '/cwd', python)).operation, 'probe');
  await assert.rejects(api.validateArguments({ ...request, network: 'registry' }, python, '/managed', '/cache', '/cwd', python), /probe_invalid/);
  await assert.rejects(api.validateArguments({ ...request, args: request.args.filter(arg => arg !== '-S') }, python, '/managed', '/cache', '/cwd', python), /probe_invalid/);
});
test('sandbox confines executable paths and reserves posix_spawn for trusted uv preparation operations', () => fixture(async ({ managed, writable }) => {
  const command = join(managed, 'uv'), python = join(managed, 'python');
  await writeFile(command, 'uv'); await writeFile(python, 'python');
  for (const operation of ['version', 'install', 'probe', 'venv', 'lock', 'sync']) {
    const profile = await api.installerProfile(command, python, [managed], [writable], 'none', operation, writable);
    assert.match(profile, /\(deny default\)/);
    assert.match(profile, /\(allow process-exec \(literal /);
    assert.doesNotMatch(profile, /allow network|iokit-open-user-client/);
    assert.equal(profile.includes('(syscall-number 82 147 244)'), ['version', 'install', 'probe'].includes(operation));
    assert.equal(profile.includes('(syscall-number 82 147)'), ['venv', 'lock', 'sync'].includes(operation));
  }
  assert.match(await api.installerProfile(command, python, [managed], [writable], 'registry', 'sync', writable), /\(allow network-outbound\)/);
}));
