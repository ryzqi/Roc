import { createPackagingEnvironment, restoreBetterSqlite3ForNode, runCommand } from '../lib/native-packaging.mjs';

export default async function afterAllArtifactBuild() {
  restoreBetterSqlite3ForNode({
    run: (command, args, options) =>
      runCommand(command, args, {
        ...options,
        env: createPackagingEnvironment(options?.env)
      })
  });
  return [];
}
