import assert from 'node:assert/strict';
import {copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {seedHistoricalResearch, seedHistoricalPaperAssets} from '../tests/fixtures/research-historical-database.mjs';
import {prepareResearchMigration, hashFile} from './database/migrate-research-schema.mjs';
import {verifyResearchMigrationStartup} from './database/verify-research-migration-startup.mjs';
import {publishResearchMigration} from './database/publish-research-migration.mjs';
import {verifyPair} from './database/research-migration-lib.mjs';

assert.equal(process.argv.length,3,'Usage: node scripts/verify-research-schema-migration.mjs NEW_OUTPUT_DIRECTORY');
mkdirSync(resolve(process.argv[2]),{recursive:false});
const output=realpathSync(resolve(process.argv[2])), results=[];
for(const version of [71,72,73]) {
  const dataRoot=join(output,`v${version}`), parent=join(dataRoot,'plugin-data/data/plugins/@roc');
  mkdirSync(parent,{recursive:true});
  const source=join(parent,'plugin-research.db'), historical=seedHistoricalResearch(source,version);
  const paperAssets=version===73 ? seedHistoricalPaperAssets(historical,dataRoot) : null;
  historical.close();
  const migration=join(dataRoot,'migration'), originalHash=hashFile(source);
  const paperAssetHashes=paperAssets ? [hashFile(paperAssets.pdfPath),hashFile(paperAssets.artifactPath)] : null;
  const prepared=await prepareResearchMigration({dataRoot,output:migration});
  await assert.rejects(publishResearchMigration({dataRoot,migration}), /ENOENT/);
  assert.equal(hashFile(source),originalHash);
  const startup=await verifyResearchMigrationStartup(migration);
  assert.equal(hashFile(source),originalHash);
  // Exercise publication refusals using the actual startup receipt. Every
  // mutation below is confined to this newly seeded disposable acceptance root.
  const startupPath=join(migration,'startup.json'), startupBytes=readFileSync(startupPath);
  for(const [field, error] of [['candidateHash','migration_startup_candidate_changed'],
    ['buildHash','migration_startup_build_changed']]) {
    writeFileSync(startupPath,JSON.stringify({...startup,[field]:'changed'}));
    try {await assert.rejects(publishResearchMigration({dataRoot,migration}),new RegExp(error));}
    finally {writeFileSync(startupPath,startupBytes);}
    assert.equal(hashFile(source),originalHash);
  }
  const wrongRoot=join(dataRoot,'wrong-root'); mkdirSync(join(wrongRoot,'plugin-data'),{recursive:true});
  await assert.rejects(publishResearchMigration({dataRoot:wrongRoot,migration}),/migration_wrong_data_root/);
  const staging=join(parent,`.research-migration-${prepared.candidateHash}.tmp`);
  writeFileSync(staging,'preexisting-staging',{flag:'wx'});
  try {
    await assert.rejects(publishResearchMigration({dataRoot,migration}),/EEXIST/);
    assert.equal(readFileSync(staging,'utf8'),'preexisting-staging');
    assert.equal(hashFile(source),originalHash);
    assert.equal(existsSync(join(migration,'publication-intent.json')),false);
  } finally {rmSync(staging);}
  // A source edited after preparation must never be overwritten.
  const originalBytes=readFileSync(source);
  writeFileSync(source,Buffer.concat([originalBytes,Buffer.from('changed-after-prepare')]));
  const changedHash=hashFile(source);
  try {
    await assert.rejects(publishResearchMigration({dataRoot,migration}),/migration_original_changed/);
    assert.equal(hashFile(source),changedHash);
  } finally {copyFileSync(join(migration,'source-snapshot.db'),source);}
  const published=await publishResearchMigration({dataRoot,migration});
  assert.equal(hashFile(source),prepared.candidateHash);
  assert.deepEqual(verifyPair(join(migration,'backup.db'),source),prepared.verification);
  if(paperAssets) {
    assert.deepEqual([hashFile(paperAssets.pdfPath),hashFile(paperAssets.artifactPath)],paperAssetHashes);
    assert.deepEqual(paperAssetHashes,[paperAssets.pdfHash,paperAssets.artifactHash]);
  }
  results.push({version,prepared:prepared.status,startup:startup.status,published:published.status,
    preservedTables:Object.keys(prepared.verification.tables).length,originalHash,candidateHash:prepared.candidateHash,
    paperAssetsPreserved:Boolean(paperAssets),
    publicationGuards:['missing-startup','changed-candidate-receipt','changed-build','wrong-root','preexisting-staging','changed-original']});
  console.log(JSON.stringify(results.at(-1)));
}
writeFileSync(join(output,'report.json'),JSON.stringify({status:'Verified passing',results},null,2)+'\n',{flag:'wx'});
