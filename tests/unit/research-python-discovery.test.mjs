import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { discoverProjectPythonExecutables } = await importTypeScriptModule(
  'src/main/plugins/research/python-environment-discovery.ts', { platform: 'node' });

test('automatic discovery finds project environments and uv installs with Finder PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roc-python-discovery-'));
  try {
    const projectPython = join(root, 'project/.venv/bin/python3');
    const older = join(root, 'home/.local/share/uv/python/cpython-3.14.7-macos-aarch64-none/bin/python3.14');
    const newer = join(root, 'home/.local/share/uv/python/cpython-3.14.10-macos-aarch64-none/bin/python3.14');
    for (const path of [projectPython, older, newer]) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, '', { mode: 0o755 });
    }
    const paths = await discoverProjectPythonExecutables(join(root, 'project'), new AbortController().signal,
      join(root, 'home'), '/usr/bin:/bin');
    assert.deepEqual(paths.slice(0, 3), [projectPython, newer, older]);
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await assert.rejects(discoverProjectPythonExecutables(join(root, 'project'), controller.signal,
      join(root, 'home'), ''), /cancelled/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
