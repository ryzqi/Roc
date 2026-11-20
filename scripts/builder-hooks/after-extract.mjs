import { rm } from 'node:fs/promises';
import { join } from 'node:path';

export default async function afterExtract(context) {
  const resourcesDir = join(context.packager.getElectronDestinationDir(context.appOutDir), 'Contents', 'Resources');
  await rm(join(resourcesDir, 'default_app.asar'), { force: true });
  await rm(join(context.appOutDir, 'version'), { force: true });
}
