#!/usr/bin/env node

import { resolve } from 'node:path';
import {
  createPackagingEnvironment,
  runCommand,
  terminateRunningPackagedApp
} from './lib/native-packaging.mjs';

const projectRoot = resolve('.');
const packagingEnvironment = createPackagingEnvironment();
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
const { terminatedPids } = terminateRunningPackagedApp();
if (terminatedPids.length > 0) {
  console.log(`Terminated running packaged Roc.exe processes before packaging: ${terminatedPids.join(', ')}`);
}
exitCode = run('pnpm', ['exec', 'electron-builder', '--dir', '--config', 'electron-builder.yml'], {
  exitOnFailure: false
});

process.exit(exitCode);
