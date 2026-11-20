import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyPair, manifest, sha256} from './research-migration-lib.mjs';
import {hashFile, readFlags} from './migrate-research-schema.mjs';

export function verifyResearchMigration(directory) {
  const root = resolve(directory), receipt = JSON.parse(readFileSync(join(root, 'prepared.json'), 'utf8'));
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.status, 'prepared');
  assert.equal(receipt.frozenManifestHash, sha256(JSON.stringify(manifest)), 'migration_contract_changed');
  assert.equal(hashFile(join(root, 'source-snapshot.db')), receipt.sourceHash, 'migration_source_snapshot_changed');
  assert.equal(hashFile(join(root, 'backup.db')), receipt.backupHash, 'migration_backup_changed');
  assert.equal(hashFile(join(root, 'candidate.db')), receipt.candidateHash, 'migration_candidate_changed');
  const verification = verifyPair(join(root, 'backup.db'), join(root, 'candidate.db'));
  assert.deepEqual(verification, receipt.verification, 'migration_verification_changed');
  // Independently compare the original offline snapshot with the native backup.
  const snapshotVerification = verifyPair(join(root, 'source-snapshot.db'), join(root, 'candidate.db'));
  assert.deepEqual(snapshotVerification, verification, 'migration_native_backup_changed');
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const flags = readFlags(process.argv.slice(2), ['--migration']);
    const receipt = verifyResearchMigration(flags['--migration']);
    console.log(JSON.stringify({status: 'Verified passing', fromVersion: receipt.fromVersion,
      toVersion: receipt.toVersion, tables: Object.keys(receipt.verification.tables).length}));
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
