#!/usr/bin/env node

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, packageJsonPath } from './lib/electron-version.mjs';
import { assertLiveResearchToolchainForPackaging, createPackagingEnvironment, runCommand } from './lib/native-packaging.mjs';

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('package:mac requires an arm64 or x64 macOS host with a matching installed Electron distribution.');
}
if (process.argv.length > 2) {
  throw new Error('package:mac builds the current Mac architecture and does not accept extra arguments.');
}

assertLiveResearchToolchainForPackaging();

const env = createPackagingEnvironment();
const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const releaseDir = join(projectRoot, 'release');
const appPath = join(releaseDir, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Roc.app');
for (const artifactPath of [
  join(releaseDir, `Roc-${version}-mac-${process.arch}.zip`),
  join(releaseDir, `Roc-${version}-mac-${process.arch}.zip.sha256`),
  join(releaseDir, `Roc-${version}-mac-${process.arch}.dmg`),
  join(releaseDir, `Roc-${version}-mac-${process.arch}.dmg.sha256`),
  join(releaseDir, 'builder-debug.yml'),
  join(releaseDir, 'builder-effective-config.yaml'),
  join(releaseDir, `mac-${process.arch}-build.json`)
]) {
  rmSync(artifactPath, { force: true });
}

function run(command, args) {
  const status = runCommand(command, args, { cwd: projectRoot, env });
  if (status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${status}.`);
  }
}

run('pnpm', ['build']);
run('pnpm', ['check:renderer-chunks']);
run('pnpm', ['exec', 'electron-builder', '--mac', '--dir', `--${process.arch}`, '--publish', 'never', '--config', join(projectRoot, 'electron-builder.yml')]);
run(process.execPath, [join(projectRoot, 'scripts', 'smoke-mac.mjs'), appPath]);
for (const metadataPath of [join(releaseDir, 'builder-debug.yml'), join(releaseDir, 'builder-effective-config.yaml')]) {
  rmSync(metadataPath, { force: true });
}
console.log(JSON.stringify({ arch: process.arch, appPath }, null, 2));
