import {
  createPackagingEnvironment,
  runCommand,
  verifyWorkspaceBetterSqlite3
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

verifyWorkspaceBetterSqlite3({
  projectRoot,
  run: (command, args, options) => run(command, args, { ...options, exitOnFailure: false })
});
exitCode = run('pnpm', ['exec', 'electron-vite', 'dev'], { exitOnFailure: false });

process.exit(exitCode);
