import {
  createPackagingEnvironment,
  prepareAndVerifyWorkspaceBetterSqlite3,
  restoreBetterSqlite3ForNode,
  runCommand
} from './lib/native-packaging.mjs';

const projectRoot = process.cwd();
let exitCode = 0;

function run(command, args, options = { exitOnFailure: true }) {
  const status = runCommand(command, args, {
    cwd: options?.cwd ?? projectRoot,
    env: createPackagingEnvironment(options?.env)
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
  prepareAndVerifyWorkspaceBetterSqlite3({
    projectRoot,
    run: (command, args, options) => run(command, args, { ...options, exitOnFailure: false })
  });
  exitCode = run('pnpm', ['exec', 'electron-vite', 'dev'], { exitOnFailure: false });
} finally {
  let restoreExitCode = 0;
  try {
    restoreBetterSqlite3ForNode({
      projectRoot,
      run: (command, args, options) => run(command, args, { ...options, exitOnFailure: false })
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
