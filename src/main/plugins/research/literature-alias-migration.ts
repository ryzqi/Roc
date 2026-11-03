import type { Database } from 'better-sqlite3';
import { researchLiteratureSchema } from '../../../shared/schemas/research';
import { literatureStrongIdentities } from './literature-identity-graph';

export function migrateLiteratureAliases(db: Database): void {
  const rows = db.prepare('SELECT id,identity_key,metadata_json,sources_json FROM research_library').all() as
    Array<{id: string; identity_key: string; metadata_json: string; sources_json: string}>;
  const insert = db.prepare('INSERT INTO research_library_aliases(item_id,identity) VALUES (?,?) ON CONFLICT DO NOTHING');
  for (const row of rows) {
    insert.run(row.id, row.identity_key);
    const metadata = researchLiteratureSchema.parse(JSON.parse(row.metadata_json));
    for (const identity of literatureStrongIdentities(metadata)) insert.run(row.id, identity);
    const sources = JSON.parse(row.sources_json) as Array<{providerRecord: unknown}>;
    for (const source of sources) {
      if (source.providerRecord === null) continue;
      const record = researchLiteratureSchema.parse(source.providerRecord);
      for (const identity of literatureStrongIdentities(record)) insert.run(row.id, identity);
    }
  }
}
