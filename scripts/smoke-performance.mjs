import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWindowsShellCommand,
  prepareAndVerifyWorkspaceBetterSqlite3,
  restoreBetterSqlite3ForNode
} from './lib/native-packaging.mjs';

let exitCode = 0;
const profileRoot = mkdtempSync(join(tmpdir(), 'roc-performance-profiles-'));
const profileRoots = {
  empty: join(profileRoot, 'empty'),
  profile1000: join(profileRoot, 'profile-1000'),
  profile10000: join(profileRoot, 'profile-10000')
};
const profileRootsJson = JSON.stringify(profileRoots);

function run(command, args, options = { exitOnFailure: true }) {
  const useWindowsShell = process.platform === 'win32';
  const result = spawnSync(useWindowsShell ? buildWindowsShellCommand(command, args) : command, useWindowsShell ? [] : args, {
    stdio: 'inherit',
    shell: useWindowsShell,
    env: options.env === undefined ? process.env : options.env
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
  exitCode = run(
    'pnpm',
    ['test', 'tests/smoke/performance-profile-seed.test.ts'],
    {
      exitOnFailure: false,
      env: { ...process.env, ROC_PERFORMANCE_PROFILE_ROOTS: profileRootsJson }
    }
  );
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  } else {
    process.env.ROC_PERFORMANCE_PROFILE_ROOTS = profileRootsJson;
    if (process.env.ROC_SMOKE_TARGET === undefined) {
      process.env.ROC_SMOKE_TARGET = 'dist';
    }
    prepareAndVerifyWorkspaceBetterSqlite3({
      run: (command, args, options) => run(command, args, { ...options, exitOnFailure: false })
    });
    exitCode = run('node', ['tests/smoke/performance-smoke.mjs'], { exitOnFailure: false });
  }
} finally {
  let restoreExitCode = 0;
  try {
    restoreBetterSqlite3ForNode({
      run: (command, args, options) => run(command, args, { ...options, exitOnFailure: false })
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    restoreExitCode = 1;
  }
  if (exitCode === 0 && restoreExitCode !== 0) {
    exitCode = restoreExitCode;
  }
  rmSync(profileRoot, { recursive: true, force: true });
}

process.exit(exitCode);
