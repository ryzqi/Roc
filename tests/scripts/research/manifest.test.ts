import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inventory, verifyManifest, writeManifest } from '../../../scripts/research/manifest';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-manifest-')));
  roots.push(root);
  return root;
}

describe('research toolchain manifest', () => {
  it('detects changed, extra and missing files', async () => {
    const root = await workspace();
    const source = join(root, 'worker.py');
    await writeFile(source, 'original');
    await writeManifest(root, { architecture: 'arm64', versions: { python: '3.12.14' }, lockHashes: {} });
    expect((await verifyManifest(root)).architecture).toBe('arm64');
    await writeFile(source, 'modified');
    await expect(verifyManifest(root)).rejects.toMatchObject({ message: 'research_toolchain_integrity_mismatch' });
    await writeFile(source, 'original');
    const extra = join(root, 'extra');
    await writeFile(extra, '');
    await expect(verifyManifest(root)).rejects.toMatchObject({ message: 'research_toolchain_integrity_mismatch' });
    await rm(extra);
    await rm(source);
    await expect(verifyManifest(root)).rejects.toMatchObject({ message: 'research_toolchain_integrity_mismatch' });
  });

  it('allows internal relative links and rejects external links', async () => {
    const root = await workspace();
    await writeFile(join(root, 'python3.12'), 'binary');
    await symlink('python3.12', join(root, 'python3'));
    await writeManifest(root, { architecture: 'arm64', versions: {}, lockHashes: {} });
    await verifyManifest(root);
    await symlink(join(root, '..'), join(root, 'escape'));
    await expect(verifyManifest(root)).rejects.toMatchObject({
      message: expect.stringContaining('research_toolchain_external_symlink')
    });
  });

  it('omits manifest.json from the inventory and records executable bits', async () => {
    const root = await workspace();
    const bin = join(root, 'bin/tool');
    await mkdir(join(root, 'bin'));
    await writeFile(bin, 'x');
    await chmod(bin, 0o755);
    await writeFile(join(root, 'readme.txt'), 'ok');
    const manifest = await writeManifest(root, { architecture: 'x64', versions: { uv: '0.12.10' }, lockHashes: { a: 'b'.repeat(64) } });
    expect(manifest.entries.map((entry) => entry.path)).toEqual(['bin/tool', 'readme.txt']);
    expect(manifest.entries[0]).toMatchObject({ type: 'file', executable: true });
    expect(manifest.entries[1]).toMatchObject({ type: 'file', executable: false });
    expect(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))).toEqual(manifest);
    expect((await inventory(root)).some((entry) => entry.path === 'manifest.json')).toBe(false);
  });

  it('rejects a symlink manifest file', async () => {
    const root = await workspace();
    await writeFile(join(root, 'worker.py'), 'original');
    await writeManifest(root, { architecture: 'arm64', versions: {}, lockHashes: {} });
    await rm(join(root, 'manifest.json'));
    await symlink('worker.py', join(root, 'manifest.json'));
    await expect(verifyManifest(root)).rejects.toMatchObject({ message: 'research_toolchain_manifest_symlink' });
  });
});
