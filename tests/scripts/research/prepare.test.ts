import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(hashes['scripts/collect_licenses.py']).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashes['scripts/prepare.py']).toBeUndefined();
  });

  it('collects named files in license directories', async () => {
    const root = await workspace();
    const script = fileURLToPath(new URL('../../../scripts/research/collect_licenses.py', import.meta.url));
    const helper = `
import json, sys
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(sys.argv[1]).parent))
from collect_licenses import collect
root = Path(sys.argv[2]).resolve()
relative = Path('example.dist-info/licenses/BUILD_LICENSES/icu.txt')
target = root / relative
target.parent.mkdir(parents=True)
target.write_text('Upstream copyright and license', encoding='utf-8')
metadata = Message()
metadata['Name'] = 'example'
distribution = SimpleNamespace(metadata=metadata, version='1.0', files=[relative], locate_file=lambda file: root / file)
with patch('collect_licenses.importlib.metadata.distributions', return_value=[distribution]):
    print(json.dumps(collect(root)))
`;
    const result = spawnSync('python3', ['-c', helper, script, root], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)[0].licenseFiles).toEqual(['example.dist-info/licenses/BUILD_LICENSES/icu.txt']);
  });
});
