import {
  createPackagingEnvironment,
  finalizePackagedResearchToolchain,
  preparePackagedNodePty,
  runCommand,
  verifyPackagedFileLayout,
  verifyPackagedBetterSqlite3,
  verifyPackagedResearchToolchain
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
  finalizePackagedResearchToolchain({
    resourcesDir,
    architecture: process.arch
  });
  verifyPackagedResearchToolchain({
    resourcesDir,
    architecture: process.arch
  });
}
