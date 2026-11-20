import {stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {ZoteroStatus} from '../../../shared/schemas/research-zotero';

type ApplicationLocation = {location: 'system' | 'user'; path: string};

/** Reports only the standard application directories; transport failure proves no installation state. */
export async function detectZoteroInstallation(locations: readonly ApplicationLocation[] = [
  {location: 'system', path: '/Applications/Zotero.app'},
  {location: 'user', path: join(homedir(), 'Applications/Zotero.app')}
]): Promise<ZoteroStatus['installation']> {
  for (const application of locations) {
    try {
      const executable = await stat(join(application.path, 'Contents/MacOS/zotero'));
      if (executable.isFile()) return {status: 'found', location: application.location};
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && ['ENOENT', 'ENOTDIR'].includes(String(cause.code))) continue;
      throw new Error('zotero_installation_unreadable', {cause});
    }
  }
  return {status: 'not_found'};
}
