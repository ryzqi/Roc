import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import signApp from '../../scripts/builder-hooks/sign.mjs';
import { verifyManifest, writeManifest } from '../../scripts/research/manifest.ts';

test('PR package environment permits the configured ad-hoc signing hook', {
  skip: process.platform !== 'darwin'
}, async () => {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const packagerRequire = createRequire(builderRequire.resolve('app-builder-lib'));
  const yaml = packagerRequire('js-yaml');
  const workflow = yaml.load(await readFile('.github/workflows/verify-mac.yml', 'utf8'));
  const config = yaml.load(await readFile('electron-builder.yml', 'utf8'));
  const packageStep = workflow.jobs.verify.steps.find(step => step.run === 'pnpm package:mac');
  assert.ok(packageStep);
  assert.equal(config.mac.identity, '-', 'PR packaging must use the certificate-free identity');
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    const require = createRequire(import.meta.url);
    const builderRequire = createRequire(require.resolve('electron-builder'));
    const {isSignAllowed} = builderRequire('app-builder-lib/out/codeSign/macCodeSign.js');
    assert.equal(isSignAllowed(false), true, 'electron-builder skipped the PR ad-hoc signing hook');
  `], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, GITHUB_BASE_REF: 'main', CSC_FOR_PULL_REQUEST: 'false', ...packageStep.env }
  });
  assert.equal(probe.status, 0, probe.stderr);
});

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
