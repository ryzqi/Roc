import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectPythonLicenses } from '../../../scripts/research/collect-licenses';
import { computeLockHashes, portablePython, prepare } from '../../../scripts/research/prepare';
import { writeManifest } from '../../../scripts/research/manifest';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-prepare-')));
  roots.push(root);
  return root;
}

describe('research prepare', () => {
  it('rewrites console scripts so they survive a path with spaces', async () => {
    const root = await workspace();
    const prefix = join(root, 'python');
    await mkdir(join(prefix, 'bin'), { recursive: true });
    const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
    if (python.status !== 0) throw new Error(python.stderr || 'python3 required');
    await symlink(python.stdout.trim(), join(prefix, 'bin/python3'));
    const script = join(prefix, 'bin/example');
    await writeFile(script, `#!${prefix}/bin/python3\nimport sys\nprint(sys.argv[1])\n`);
    await chmod(script, 0o755);
    await portablePython(prefix);
    const moved = join(root, 'moved python');
    await rename(prefix, moved);
    const result = spawnSync(join(moved, 'bin/example'), ['works with spaces'], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('works with spaces');
  });

  it('reuses a matching existing toolchain and rejects a changed lock hash', async () => {
    const root = await workspace();
    const output = join(root, 'toolchain');
    await mkdir(output);
    await writeFile(join(output, 'worker.py'), 'ok');
    const lockHashes = await computeLockHashes();
    await writeManifest(output, {
      architecture: process.arch === 'x64' ? 'x64' : 'arm64',
      versions: { python: '3.12.14' },
      lockHashes
    });
    await prepare(process.arch === 'x64' ? 'x64' : 'arm64', output, join(root, 'cache'), join(root, 'models'));
    lockHashes.changed = 'a'.repeat(64);
    await rm(join(output, 'manifest.json'));
    await writeManifest(output, {
      architecture: process.arch === 'x64' ? 'x64' : 'arm64',
      versions: { python: '3.12.14' },
      lockHashes
    });
    await expect(prepare(process.arch === 'x64' ? 'x64' : 'arm64', output, join(root, 'cache'), join(root, 'models')))
      .rejects.toMatchObject({ message: 'research_toolchain_existing_sources_differ_use_new_output' });
  });

  it('rejects overlapping output and cache directories', async () => {
    const root = await workspace();
    await expect(prepare(process.arch === 'x64' ? 'x64' : 'arm64', join(root, 'out'), join(root, 'out/cache'), join(root, 'models')))
      .rejects.toMatchObject({ message: 'research_toolchain_output_overlaps_cache' });
  });

  it('records hashes for TypeScript build scripts', async () => {
    const hashes = await computeLockHashes();
    expect(hashes['scripts/prepare.ts']).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashes['scripts/download-asset.ts']).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashes['scripts/smoke.ts']).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashes['scripts/build-r-process.ts']).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashes['scripts/collect-licenses.ts']).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashes['scripts/collect_licenses.py']).toBeUndefined();
    expect(hashes['scripts/prepare.py']).toBeUndefined();
    expect(hashes['tex-bundle-files.txt']).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('collects named files in license directories', async () => {
    const root = await workspace();
    const site = join(root, 'python/lib/python3.12/site-packages');
    const dist = join(site, 'example.dist-info');
    const license = join(dist, 'licenses/BUILD_LICENSES/icu.txt');
    await mkdir(join(dist, 'licenses/BUILD_LICENSES'), { recursive: true });
    await writeFile(join(dist, 'METADATA'), 'Name: example\nVersion: 1.0\nLicense-Expression: MIT\nClassifier: License :: OSI Approved :: MIT License\nProject-URL: Homepage, https://example.test\n');
    await writeFile(license, 'Upstream copyright and license');
    await writeFile(join(dist, 'RECORD'), 'example.dist-info/licenses/BUILD_LICENSES/icu.txt,,\n');
    const records = await collectPythonLicenses(root);
    expect(records).toEqual([{
      name: 'example',
      version: '1.0',
      licenseExpression: 'MIT',
      license: null,
      licenseClassifiers: ['License :: OSI Approved :: MIT License'],
      projectUrls: ['Homepage, https://example.test'],
      licenseFiles: ['python/lib/python3.12/site-packages/example.dist-info/licenses/BUILD_LICENSES/icu.txt']
    }]);
  });

  it('ignores RECORD paths that leave site-packages', async () => {
    const root = await workspace();
    const site = join(root, 'python/lib/python3.12/site-packages');
    const dist = join(site, 'example.dist-info');
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, 'METADATA'), 'Name: example\nVersion: 1.0\n');
    await writeFile(join(dist, 'RECORD'), '../outside.txt,,\n');
    await writeFile(join(root, 'python/lib/python3.12/outside.txt'), 'nope');
    const records = await collectPythonLicenses(root);
    expect(records[0]?.licenseFiles).toEqual([]);
  });
});
