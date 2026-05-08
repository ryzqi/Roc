#!/usr/bin/env node

import { resolve } from 'node:path';
import {
  createPackagingEnvironment,
  restoreBetterSqlite3ForNode,
  runCommand
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

try {
  run('pnpm', ['build']);
  exitCode = run('pnpm', ['exec', 'electron-builder', '--dir', '--config', 'electron-builder.yml'], {
    exitOnFailure: false
  });
} finally {
  let restoreExitCode = 0;
  try {
    restoreBetterSqlite3ForNode({
      projectRoot,
      run: (command, args, options) =>
        runCommand(command, args, {
          ...options,
          cwd: projectRoot,
          env: packagingEnvironment
        })
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    restoreExitCode = 1;
  }
  if (exitCode === 0 && restoreExitCode !== 0) {
    exitCode = restoreExitCode;
  }
}

process.exit(exitCode);
