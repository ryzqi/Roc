import { spawnSync } from 'node:child_process';
import { verifyWorkspaceBetterSqlite3 } from './lib/native-packaging.mjs';

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

verifyWorkspaceBetterSqlite3({
  run: (command, args, options) => run(command, args, { ...options, exitOnFailure: false })
});
exitCode = run('node', ['tests/smoke/electron-smoke.mjs'], { exitOnFailure: false });

process.exit(exitCode);
