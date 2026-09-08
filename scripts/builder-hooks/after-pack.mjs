import {
  createPackagingEnvironment,
  preparePackagedNodePty,
  runCommand,
  verifyPackagedFileLayout,
  verifyPackagedBetterSqlite3
} from '../lib/native-packaging.mjs';

export default async function afterPack(context) {
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  verifyPackagedFileLayout({ resourcesDir });
  preparePackagedNodePty({ resourcesDir, platform: context.electronPlatformName });
  verifyPackagedBetterSqlite3({
    resourcesDir,
    run: (command, args, options) =>
      runCommand(command, args, {
        ...options,
        env: createPackagingEnvironment(options?.env)
      })
  });
}
