#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const electronVersion = '41.3.0';
const electronBuilderCache = resolve('.runtime/electron-builder-cache');
mkdirSync(electronBuilderCache, { recursive: true });
let exitCode = 0;

function run(command, args, options = { exitOnFailure: true }) {
  const result = spawnSync(command, args, {
    env: {
      ...process.env,
      ELECTRON_BUILDER_CACHE: electronBuilderCache,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false'
    },
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (result.status === null) {
    if (options.exitOnFailure) {
      process.exit(1);
    }
    return 1;
  }

  if (result.status !== 0) {
    if (options.exitOnFailure) {
      process.exit(result.status);
    }
    return result.status;
  }

  return 0;
}

try {
  run('pnpm', ['build']);
  run('pnpm', ['exec', 'electron-rebuild', '--force', '--only', 'better-sqlite3', '--version', electronVersion]);
  exitCode = run('pnpm', ['exec', 'electron-builder', '--dir', '--config', 'electron-builder.yml'], {
    exitOnFailure: false
  });
} finally {
  const restoreExitCode = run('pnpm', ['rebuild', 'better-sqlite3', '--pending=false'], {
    exitOnFailure: false
  });
  if (exitCode === 0 && restoreExitCode !== 0) {
    exitCode = restoreExitCode;
  }
}

process.exit(exitCode);
