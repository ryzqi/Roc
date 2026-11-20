import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, writeFileSync, constants} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import Database from 'better-sqlite3';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';
import {convertHistorical, validateHistorical, verifyPair, sha256, manifest} from './research-migration-lib.mjs';

export function hashFile(path) {
  const fd = openSync(path, 'r'), hash = createHash('sha256'), block = Buffer.alloc(1024 * 1024);
  try {let length; while ((length = readSync(fd, block, 0, block.length, null)) > 0) hash.update(block.subarray(0, length));}
  finally {closeSync(fd);}
  return hash.digest('hex');
}

export function assertOffline(path) {
  assert.equal(realpathSync(path), path, 'migration_symlink_path_rejected');
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && stat.nlink === 1, 'migration_regular_unlinked_file_required');
  for (const suffix of ['-wal', '-shm', '-journal']) assert.ok(!existsSync(path + suffix), 'migration_sidecars_present');
  assert.equal(process.platform, 'darwin', 'migration_open_handle_check_requires_macos');
  const handles = spawnSync('/usr/sbin/lsof', ['-F', 'p', '--', path], {encoding: 'utf8', timeout: 15000});
  assert.ok(handles.status === 1 && handles.stdout === '' && handles.stderr === '',
    handles.status === 0 ? 'migration_database_in_use' : 'migration_open_handle_check_failed');
}

export async function prepareResearchMigration({dataRoot, output}) {
  const root = realpathSync(resolve(dataRoot));
  const pluginRoot = realpathSync(join(root, 'plugin-data'));
  const sourcePath = join(pluginRoot, 'data/plugins/@roc/plugin-research.db');
  const {acquireDatabaseMaintenanceLease} = await importTypeScriptModule(
    'src/main/infrastructure/database-maintenance-lease.ts', {platform: 'node'});
  const lease = acquireDatabaseMaintenanceLease({rootDir: pluginRoot, owner: {kind: 'cli', pid: process.pid}});
  let source, target;
  try {
    assertOffline(sourcePath);
    const sourceHash = hashFile(sourcePath), sourceStat = lstatSync(sourcePath);
    const directory = resolve(output);
    mkdirSync(directory, {recursive: false, mode: 0o700});
    // Even a read-only SQLite open can create WAL coordination sidecars. Open
    // only this byte-identical offline staging copy, never the original file.
    const snapshotPath = join(directory, 'source-snapshot.db');
    copyFileSync(sourcePath, snapshotPath, constants.COPYFILE_EXCL);
    assert.equal(hashFile(snapshotPath), sourceHash, 'migration_source_changed');
    source = new Database(snapshotPath, {readonly: true, fileMustExist: true});
    const historical = validateHistorical(source);
    const backupPath = join(directory, 'backup.db');
    await source.backup(backupPath);
    source.close(); source = null;
    source = new Database(backupPath, {readonly: true, fileMustExist: true});
    const candidatePath = join(directory, 'candidate.db');
    assert.ok(!existsSync(candidatePath));
    target = new Database(candidatePath);
    target.pragma('journal_mode=DELETE'); target.pragma('synchronous=FULL');
    convertHistorical(source, target);
    target.close(); target = null; source.close(); source = null;
    const verification = verifyPair(backupPath, candidatePath);
    assertOffline(sourcePath);
    const finalStat = lstatSync(sourcePath);
    assert.equal(finalStat.ino, sourceStat.ino); assert.equal(finalStat.mtimeMs, sourceStat.mtimeMs);
    assert.equal(hashFile(sourcePath), sourceHash, 'migration_source_changed');
    const receipt = {schemaVersion: 1, status: 'prepared', dataRoot: root, sourcePath, sourceHash,
      fromVersion: historical.version, toVersion: verification.toVersion,
      backupHash: hashFile(backupPath), candidateHash: hashFile(candidatePath), verification,
      frozenManifestHash: sha256(JSON.stringify(manifest)), preparedAt: new Date().toISOString()};
    for (const path of [snapshotPath, backupPath, candidatePath]) {
      const fd = openSync(path, 'r'); try {fsyncSync(fd);} finally {closeSync(fd);}
    }
    writeFileSync(join(directory, 'prepared.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    return receipt;
  } finally {target?.close(); source?.close(); lease.release();}
}

export function readFlags(args, names) {
  assert.equal(args.length, names.length * 2, 'migration_arguments_invalid');
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = args.slice(index, index + 2);
    assert.ok(names.includes(name) && !(name in flags) && value && !value.startsWith('--'), 'migration_arguments_invalid');
    flags[name] = value;
  }
  assert.ok(names.every(name => name in flags), 'migration_arguments_invalid');
  return flags;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const flags = readFlags(process.argv.slice(2), ['--data-root', '--output']);
    const receipt = await prepareResearchMigration({dataRoot: flags['--data-root'], output: flags['--output']});
    console.log(JSON.stringify({status: receipt.status, fromVersion: receipt.fromVersion, toVersion: receipt.toVersion,
      tables: Object.keys(receipt.verification.tables).length, originalUnchanged: true}));
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
