import { createPackagingEnvironment, prepareAndVerifyWorkspaceBetterSqlite3, runCommand } from '../lib/native-packaging.mjs';

export default async function beforePack() {
  prepareAndVerifyWorkspaceBetterSqlite3({
    run: (command, args, options) =>
      runCommand(command, args, {
        ...options,
        env: createPackagingEnvironment(options?.env)
      })
  });
}
