import { rm } from 'node:fs/promises';
import { join } from 'node:path';

export default async function afterExtract(context) {
  const isMac = context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas';
  const resourcesDir = isMac
    ? join(context.packager.getElectronDestinationDir(context.appOutDir), 'Contents', 'Resources')
    : join(context.appOutDir, 'resources');
  await rm(join(resourcesDir, 'default_app.asar'), { force: true });
  await rm(join(context.appOutDir, 'version'), { force: true });
}
