import {
  createPackagingEnvironment,
  prepareAndVerifyWorkspaceBetterSqlite3,
  runCommand,
  terminateRunningPackagedApp
} from '../lib/native-packaging.mjs';

export default async function beforePack() {
  terminateRunningPackagedApp();
  prepareAndVerifyWorkspaceBetterSqlite3({
    run: (command, args, options) =>
      runCommand(command, args, {
        ...options,
        env: createPackagingEnvironment(options?.env)
      })
  });
}
