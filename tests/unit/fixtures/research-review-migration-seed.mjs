import assert from 'node:assert/strict';

/**
 * Current services generate real manual receipts on a disposable seeding schema.
 * Remove their empty ownership scaffolding before inspecting or upgrading the
 * exact historical schema. The migration ledger is never advanced by seeding.
 */
export function createReviewMigrationSeedApi(api, version) {
  const migrations = api.researchMigrations.filter(migration => migration.version <= version);
  const ownership = api.researchMigrations.find(migration => migration.name === 'owned_review_query_dispatch');
  assert.ok(ownership);
  return {
    ...api,
    applyResearchDatabaseSchema(db, now) {
      api.applyDatabaseMigrations(db, {dbName: 'plugin:@roc/plugin-research', migrations, now});
      db.exec(ownership.sql);
    },
    finishSeed(db) {
      assert.equal(db.prepare('SELECT COUNT(*) FROM research_review_search_owners').pluck().get(), 0);
      assert.equal(db.prepare('SELECT COUNT(*) FROM research_review_searches WHERE owner_hash IS NOT NULL').pluck().get(), 0);
      db.exec('DROP TABLE research_review_search_owners');
      db.exec('ALTER TABLE research_review_searches DROP COLUMN owner_hash');
      // This also proves the stripped database matches the old schema and ledger.
      api.applyDatabaseMigrations(db, {dbName: 'plugin:@roc/plugin-research', migrations});
      assert.equal(db.prepare('SELECT current_version FROM schema_metadata').pluck().get(), version);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    }
  };
}
