import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import signApp from '../../scripts/builder-hooks/sign.mjs';
import { verifyManifest, writeManifest } from '../../scripts/research/manifest.ts';

test('signed toolchain matches its manifest and the outer app resource seal', {
  skip: process.platform !== 'darwin'
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'roc-toolchain-signing-'));
  const app = join(temporary, 'Fixture.app');
  const contents = join(app, 'Contents');
  const root = join(contents, 'Resources', 'research-toolchain');
  try {
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    await mkdir(join(root, 'bin'), { recursive: true });
    await copyFile('/usr/bin/true', join(contents, 'MacOS', 'Fixture'));
    await copyFile('/usr/bin/true', join(root, 'bin', 'tool'));
    await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.roc.toolchain-signing-test</string>
<key>CFBundleExecutable</key><string>Fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1.0.0</string>
</dict></plist>`);
    const original = await writeManifest(root, { architecture: 'arm64', versions: {}, lockHashes: {} });
    const visited = [];
    await signApp({
      app, platform: 'darwin', identity: '-', identityValidation: false,
      preAutoEntitlements: false,
      optionsForFile(filePath) {
        visited.push(filePath);
        return { hardenedRuntime: false, timestamp: 'none' };
      }
    });
    assert.ok(visited.indexOf(join(root, 'bin', 'tool')) < visited.indexOf(app));
    assert.equal(visited.at(-1), app);
    const manifest = await verifyManifest(root);
    assert.notEqual(manifest.entries[0].sha256, original.entries[0].sha256, 'signing must mutate the fixture');
    const signature = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' });
    assert.equal(signature.status, 0, signature.stderr);
    // A post-sign edit must fail both integrity boundaries.
    const binary = join(root, 'bin', 'tool');
    await writeFile(binary, Buffer.concat([await readFile(binary), Buffer.from('changed')]));
    await assert.rejects(verifyManifest(root), /research_toolchain_integrity_mismatch/);
    const tampered = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' });
    assert.notEqual(tampered.status, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
