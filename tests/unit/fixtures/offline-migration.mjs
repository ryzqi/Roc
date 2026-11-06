/** Isolated historical fixtures opt into DDL upgrades; runtime startup never does. */
export function applyOfflineResearchSchema(api, db, now) {
  api.applyDatabaseMigrations(db, {dbName: 'plugin:@roc/plugin-research',
    migrations: api.researchMigrations, now, allowOffline: true});
}
