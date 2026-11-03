import type { Database } from 'better-sqlite3';
import { researchLiteratureSchema } from '../../../shared/schemas/research';
import { literatureIdentity } from './literature-identity';

/** One-time DB8 data rewrite. Historical source metadata remain in sources_json. */
export function migrateLiteratureIdentity(db: Database): void {
  const rows = db.prepare('SELECT id,metadata_json FROM research_library').all() as Array<{id: string; metadata_json: string}>;
  const update = db.prepare('UPDATE research_library SET identity_key=?,metadata_json=? WHERE id=?');
  for (const row of rows) {
    const metadata = researchLiteratureSchema.parse(JSON.parse(row.metadata_json));
    if (metadata.source === 'europe_pmc' && !metadata.externalId.includes(':')) {
      if (metadata.url === null) throw new Error('research_literature_migration_namespace_missing');
      const url = new URL(metadata.url);
      const match = /^\/article\/(?<namespace>[A-Z]+)\/(?<id>[^/]+)$/u.exec(url.pathname);
      if (url.origin !== 'https://europepmc.org' || url.search || url.hash || match?.groups?.id !== metadata.externalId) {
        throw new Error('research_literature_migration_namespace_missing');
      }
      metadata.externalId = `${match.groups.namespace}:${metadata.externalId}`;
    }
    update.run(literatureIdentity(metadata), JSON.stringify(metadata), row.id);
  }
  db.exec(`UPDATE research_library SET sources_json = (
    SELECT json_group_array(json_set(value, '$.providerRecord', NULL)) FROM json_each(research_library.sources_json)
  )`);
}
