#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const electronVersion = '41.3.0';
let exitCode = 0;

function run(command, args, options = { exitOnFailure: true }) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (result.status !== 0) {
    const status = result.status === null ? 1 : result.status;
    if (options.exitOnFailure) {
      process.exit(status);
    }
    return status;
  }

  return 0;
}

try {
  run('pnpm', ['exec', 'electron-rebuild', '--force', '--only', 'better-sqlite3', '--version', electronVersion]);
  exitCode = run('node', ['scripts/visual-audit.mjs'], { exitOnFailure: false });
} finally {
  const restoreExitCode = run('pnpm', ['rebuild', 'better-sqlite3', '--pending=false'], { exitOnFailure: false });
  if (exitCode === 0 && restoreExitCode !== 0) {
    exitCode = restoreExitCode;
  }
}

process.exit(exitCode);
