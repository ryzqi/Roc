import assert from 'node:assert/strict';
import {copyFileSync, constants, existsSync, openSync, closeSync, fsyncSync, readFileSync,
  realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';
import {assertOffline, hashFile, readFlags} from './migrate-research-schema.mjs';
import {verifyResearchMigration} from './verify-research-migration.mjs';
import {applicationIdentity} from './verify-research-migration-startup.mjs';

const sync = path => {const fd=openSync(path,'r');try {fsyncSync(fd);} finally {closeSync(fd);}};

export async function publishResearchMigration({dataRoot, migration}) {
  const root=realpathSync(resolve(dataRoot)), directory=realpathSync(resolve(migration));
  const pluginRoot=realpathSync(join(root,'plugin-data'));
  const sourcePath=join(pluginRoot,'data/plugins/@roc/plugin-research.db');
  const {acquireDatabaseMaintenanceLease}=await importTypeScriptModule('src/main/infrastructure/database-maintenance-lease.ts',{platform:'node'});
  const lease=acquireDatabaseMaintenanceLease({rootDir:pluginRoot,owner:{kind:'cli',pid:process.pid}});
  let staging;
  try {
    const receipt=verifyResearchMigration(directory);
    assert.equal(receipt.dataRoot, root, 'migration_wrong_data_root');
    assert.equal(receipt.sourcePath,sourcePath,'migration_wrong_source_path');
    const startup=JSON.parse(readFileSync(join(directory,'startup.json'),'utf8'));
    assert.equal(startup.schemaVersion,1); assert.equal(startup.status,'startup-verified');
    assert.equal(startup.isolation,'inherited-macos-seatbelt','migration_startup_isolation_missing');
    assert.equal(startup.boundariesVerified,true,'migration_startup_boundaries_missing');
    assert.equal(startup.candidateHash,receipt.candidateHash,'migration_startup_candidate_changed');
    assert.equal(startup.buildHash,applicationIdentity(),'migration_startup_build_changed');
    assertOffline(sourcePath);
    assert.equal(hashFile(sourcePath),receipt.sourceHash,'migration_original_changed');
    assert.ok(!existsSync(join(directory,'publication-intent.json')),'migration_publication_already_attempted');
    const stagingPath=join(dirname(sourcePath),`.research-migration-${receipt.candidateHash}.tmp`);
    copyFileSync(join(directory,'candidate.db'),stagingPath,constants.COPYFILE_EXCL);
    staging=stagingPath; sync(staging);
    assert.equal(hashFile(staging),receipt.candidateHash);
    const intent={schemaVersion:1,status:'publication-intent',sourcePath,sourceHash:receipt.sourceHash,
      candidateHash:receipt.candidateHash,backupPath:join(directory,'backup.db'),buildHash:startup.buildHash};
    const intentPath=join(directory,'publication-intent.json');
    writeFileSync(intentPath,JSON.stringify(intent,null,2)+'\n',{flag:'wx',mode:0o600}); sync(intentPath); sync(directory);
    // The staging file is on the same filesystem. Recheck immediately before
    // one atomic rename; source snapshot and native backup remain untouched.
    assertOffline(sourcePath); assert.equal(hashFile(sourcePath),receipt.sourceHash,'migration_original_changed');
    renameSync(staging,sourcePath); staging=undefined; sync(dirname(sourcePath));
    const result={...intent,status:'published',publishedAt:new Date().toISOString()};
    writeFileSync(join(directory,'published.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    sync(join(directory,'published.json')); sync(directory);
    return result;
  } finally {if(staging) rmSync(staging,{force:true});lease.release();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try {const flags=readFlags(process.argv.slice(2),['--data-root','--migration']);
    console.log(JSON.stringify(await publishResearchMigration({dataRoot:flags['--data-root'],migration:flags['--migration']})));
  } catch(error){console.error(error.message);process.exitCode=1;}
}
