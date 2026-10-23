#!/usr/bin/env node

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, packageJsonPath } from './lib/electron-version.mjs';
import { assertLiveResearchToolchainForPackaging, createPackagingEnvironment, runCommand } from './lib/native-packaging.mjs';

// 只发 Apple Silicon：MinerU 的 MPS/llama.cpp 后端与随包 Python 都只有 arm64。
// 在接受 x64 的宿主上打包会产出一个能启动但解析必然失败的 .app。
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('package:mac requires an arm64 macOS host.');
}
if (process.argv.length > 2) {
  throw new Error('package:mac builds the current Mac architecture and does not accept extra arguments.');
}

assertLiveResearchToolchainForPackaging();

const env = createPackagingEnvironment();
const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const releaseDir = join(projectRoot, 'release');
const appPath = join(releaseDir, 'mac-arm64', 'Roc.app');
for (const artifactPath of [
  join(releaseDir, `Roc-${version}-mac-arm64.zip`),
  join(releaseDir, `Roc-${version}-mac-arm64.zip.sha256`),
  join(releaseDir, `Roc-${version}-mac-arm64.dmg`),
  join(releaseDir, `Roc-${version}-mac-arm64.dmg.sha256`),
  join(releaseDir, 'builder-debug.yml'),
  join(releaseDir, 'builder-effective-config.yaml'),
  join(releaseDir, 'mac-arm64-build.json')
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
run('pnpm', ['exec', 'electron-builder', '--mac', '--dir', '--arm64', '--publish', 'never', '--config', join(projectRoot, 'electron-builder.yml')]);
run(process.execPath, [join(projectRoot, 'scripts', 'smoke-mac.mjs'), appPath]);
for (const metadataPath of [join(releaseDir, 'builder-debug.yml'), join(releaseDir, 'builder-effective-config.yaml')]) {
  rmSync(metadataPath, { force: true });
}
console.log(JSON.stringify({ arch: 'arm64', appPath }, null, 2));
