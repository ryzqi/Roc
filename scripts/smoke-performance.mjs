import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyWorkspaceBetterSqlite3
} from './lib/native-packaging.mjs';

let exitCode = 0;
// new URL('..', import.meta.url) 已经指向仓库根（带尾斜杠），再套 dirname 会多剥一层，
// 以前因此把 seed bundle 写到仓库外的 ../.runtime/，那里解析不到 better-sqlite3。
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profileRoot = mkdtempSync(join(tmpdir(), 'roc-performance-profiles-'));
const seedBundle = join(projectRoot, '.runtime', 'performance-profile-seed.mjs');
const profileRoots = {
  empty: join(profileRoot, 'empty'),
  profile1000: join(profileRoot, 'profile-1000'),
  profile10000: join(profileRoot, 'profile-10000')
};
const profileRootsJson = JSON.stringify(profileRoots);

function run(command, args, options = { exitOnFailure: true }) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
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
  mkdirSync(dirname(seedBundle), { recursive: true });
  exitCode = run(
    'pnpm',
    [
      'exec',
      'esbuild',
      'tests/smoke/lib/performance-profile-seed.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${seedBundle}`,
      '--external:better-sqlite3'
    ],
    { exitOnFailure: false }
  );
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  } else {
    exitCode = run('node', [seedBundle], {
      exitOnFailure: false,
      env: { ...process.env, ROC_PERFORMANCE_PROFILE_ROOTS: profileRootsJson }
    });
  }
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  } else {
    process.env.ROC_PERFORMANCE_PROFILE_ROOTS = profileRootsJson;
    if (process.env.ROC_SMOKE_TARGET === undefined) {
      process.env.ROC_SMOKE_TARGET = 'dist';
    }
    verifyWorkspaceBetterSqlite3({
      run: (command, args, options) => run(command, args, { ...options, exitOnFailure: false })
    });
    exitCode = run('node', ['tests/smoke/performance-smoke.mjs'], { exitOnFailure: false });
  }
} finally {
  rmSync(profileRoot, { recursive: true, force: true });
  rmSync(seedBundle, { force: true });
}

process.exit(exitCode);
