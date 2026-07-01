import { rm } from 'node:fs/promises';
import { join } from 'node:path';

export default async function afterExtract(context) {
  await rm(join(context.appOutDir, 'resources', 'default_app.asar'), { force: true });
  await rm(join(context.appOutDir, 'version'), { force: true });
}
