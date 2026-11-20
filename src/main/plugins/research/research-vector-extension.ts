import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import type { Database } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/** Main and the readonly Worker must resolve the same packaged native extension. */
export function loadResearchVectorExtension(db: Database): void {
  const loadablePath = sqliteVec.getLoadablePath().replace(/\.dylib\.dylib$/u, '.dylib');
  const asarMarker = `${sep}app.asar${sep}`;
  if (!loadablePath.includes(asarMarker)) {
    sqliteVec.load(db);
    return;
  }
  const unpackedPath = loadablePath.replace(asarMarker, `${sep}app.asar.unpacked${sep}`);
  db.loadExtension(existsSync(unpackedPath) ? unpackedPath : loadablePath);
}
