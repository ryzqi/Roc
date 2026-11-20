import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { finalizePackagedResearchToolchain } from '../../scripts/lib/native-packaging.mjs';
import { verifyManifest } from '../../scripts/research/manifest.ts';

test('packaged manifest hashes final bytes even when signing preserves file size and mode', async () => {
  const resourcesDir = await mkdtemp(join(tmpdir(), 'roc-toolchain-packaging-'));
  const root = join(resourcesDir, 'research-toolchain');
  try {
    await mkdir(join(root, 'bin'), { recursive: true });
    const original = Buffer.from('before signing');
    const signed = Buffer.from('after signing!');
    assert.equal(original.length, signed.length);
    await writeFile(join(root, 'bin/tool'), signed, { mode: 0o755 });
    const manifest = {
      schemaVersion: 1, platform: 'darwin', architecture: 'arm64', versions: {}, lockHashes: {},
      entries: [{ path: 'bin/tool', type: 'file', size: original.length,
        sha256: createHash('sha256').update(original).digest('hex'), executable: true }]
    };
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    finalizePackagedResearchToolchain({ resourcesDir, architecture: 'arm64' });
    await verifyManifest(root);
    const finalized = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    assert.equal(finalized.entries[0].sha256, createHash('sha256').update(signed).digest('hex'));
    // Subsequent byte changes must still be rejected by the independent verifier.
    await writeFile(join(root, 'bin/tool'), original);
    await assert.rejects(verifyManifest(root), /research_toolchain_integrity_mismatch/);
  } finally {
    await rm(resourcesDir, { recursive: true, force: true });
  }
});
