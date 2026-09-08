#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { projectRoot, packageJsonPath } from './lib/electron-version.mjs';
import { createPackagingEnvironment, runCommand } from './lib/native-packaging.mjs';

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('package:mac requires an arm64 or x64 macOS host with a matching installed Electron distribution.');
}
if (process.argv.length > 2) {
  throw new Error('package:mac builds the current Mac architecture and does not accept extra arguments.');
}

const env = createPackagingEnvironment();
const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const releaseDir = join(projectRoot, 'release');
const appPath = join(releaseDir, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Roc.app');

function run(command, args) {
  const status = runCommand(command, args, { cwd: projectRoot, env });
  if (status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${status}.`);
  }
}

run('pnpm', ['build']);
run('pnpm', ['check:renderer-chunks']);
run('pnpm', ['exec', 'electron-builder', '--mac', 'zip', `--${process.arch}`, '--publish', 'never', '--config', join(projectRoot, 'electron-builder.yml')]);
run(process.execPath, [join(projectRoot, 'scripts', 'smoke-mac.mjs'), appPath]);

const stagingDir = mkdtempSync(join(projectRoot, '.runtime', 'mac-dmg-'));
const dmgPath = join(releaseDir, `Roc-${version}-mac-${process.arch}.dmg`);
try {
  run('/usr/bin/ditto', ['--noqtn', appPath, join(stagingDir, 'Roc.app')]);
  symlinkSync('/Applications', join(stagingDir, 'Applications'));
  run('/usr/bin/hdiutil', ['create', '-volname', 'Roc', '-srcfolder', stagingDir, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-ov', dmgPath]);
  run('/usr/bin/hdiutil', ['verify', dmgPath]);
} finally {
  if (!realpathSync(stagingDir).startsWith(`${realpathSync(join(projectRoot, '.runtime'))}/mac-dmg-`)) {
    throw new Error(`Unexpected DMG staging directory: ${stagingDir}`);
  }
  rmSync(stagingDir, { recursive: true, force: true });
}

const artifacts = [];
for (const extension of ['dmg', 'zip']) {
  const artifactPath = join(releaseDir, `Roc-${version}-mac-${process.arch}.${extension}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(artifactPath)) {
    hash.update(chunk);
  }
  const sha256 = hash.digest('hex');
  writeFileSync(`${artifactPath}.sha256`, `${sha256}  ${basename(artifactPath)}\n`, 'utf8');
  artifacts.push({ file: basename(artifactPath), bytes: statSync(artifactPath).size, sha256 });
}
const summary = { version, arch: process.arch, appPath, builtAt: new Date().toISOString(), artifacts };
writeFileSync(join(releaseDir, `mac-${process.arch}-build.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary, null, 2));
