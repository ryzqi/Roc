#!/usr/bin/env node

import { projectRoot } from './lib/electron-version.mjs';
import {
  assertLiveResearchToolchainForPackaging,
  createPackagingEnvironment,
  runCommand
} from './lib/native-packaging.mjs';

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('package:dir requires an arm64 or x64 macOS host.');
}
const packagingEnvironment = createPackagingEnvironment();
assertLiveResearchToolchainForPackaging();
let exitCode = 0;

function run(command, args, options = { exitOnFailure: true }) {
  const status = runCommand(command, args, {
    cwd: projectRoot,
    env: packagingEnvironment
  });
  if (status !== 0) {
    if (options.exitOnFailure) {
      process.exit(status);
    }
    return status;
  }

  return 0;
}

run('pnpm', ['build']);
exitCode = run('pnpm', ['exec', 'electron-builder', '--mac', '--dir', `--${process.arch}`, '--publish', 'never', '--config', 'electron-builder.yml'], {
  exitOnFailure: false
});

process.exit(exitCode);
