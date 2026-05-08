import { createPackagingEnvironment, runCommand, verifyPackagedBetterSqlite3 } from '../lib/native-packaging.mjs';

export default async function afterPack(context) {
  verifyPackagedBetterSqlite3({
    appOutDir: context.appOutDir,
    run: (command, args, options) =>
      runCommand(command, args, {
        ...options,
        env: createPackagingEnvironment(options?.env)
      })
  });
}
