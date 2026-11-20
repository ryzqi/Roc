import assert from 'node:assert/strict';
import {appendFileSync, copyFileSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join, resolve, relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import Database from 'better-sqlite3';
import {verifyResearchMigration} from './verify-research-migration.mjs';
import {hashFile, readFlags} from './migrate-research-schema.mjs';
import {sha256, fingerprintTable} from './research-migration-lib.mjs';

export function applicationIdentity() {
  const files = {};
  function visit(path) {
    for (const entry of readdirSync(path, {withFileTypes: true}).sort((a,b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else {assert.ok(entry.isFile(), 'migration_app_symlink_rejected'); files[relative(process.cwd(), child)] = hashFile(child);}
    }
  }
  visit(resolve('dist'));
  assert.ok(files['dist/main/index.js'], 'migration_app_build_required');
  return sha256(JSON.stringify({files, lock: hashFile('pnpm-lock.yaml')}));
}

export async function verifyResearchMigrationStartup(directory) {
  assert.equal(process.platform, 'darwin');
  const root = realpathSync(resolve(directory)), receipt = verifyResearchMigration(root);
  const buildHash = applicationIdentity();
  const isolated = join(root, 'startup'); mkdirSync(isolated, {mode: 0o700});
  // Chromium must create its singleton socket within a permitted directory.
  const dataRoot = join(isolated, 'data'), temp = mkdtempSync('/private/tmp/roc-migration-');
  const databaseDir = join(dataRoot, 'plugin-data/data/plugins/@roc'); mkdirSync(databaseDir, {recursive:true});
  const databasePath = join(databaseDir, 'plugin-research.db');
  copyFileSync(join(root, 'candidate.db'), databasePath, constants.COPYFILE_EXCL);
  const db = new Database(databasePath, {readonly:true});
  const projectIds = db.prepare('SELECT id FROM research_projects ORDER BY id').pluck().all();
  const preserved = ['research_evidence','research_evidence_source_metadata','research_evidence_source_locators',
    'research_claims','research_claim_revisions','research_evidence_relations','research_evidence_relation_revisions',
    'research_wiki_revisions','research_library','research_documents','research_document_parses',
    'research_document_parse_coordinates','research_artifacts'];
  const before = Object.fromEntries(preserved.map(name => [name, fingerprintTable(db, name)])); db.close();
  // Run the unmodified application on a byte-identical candidate copy. Native
  // policy prevents background jobs from writing original workspaces or calling
  // external providers; loopback listeners are needed for Playwright's inspector.
  const profile = `(version 1)(allow default)(deny network-outbound)
    (deny file-write*)(allow file-write* (subpath ${JSON.stringify(isolated)})
      (subpath ${JSON.stringify(temp)}) (subpath "/dev"))`;
  const profilePath = join(isolated, 'startup.sb'); writeFileSync(profilePath, profile, {flag:'wx'});
  const executable = createRequire(import.meta.url)('electron');
  const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const wrapper = join(isolated, 'electron');
  writeFileSync(wrapper, '#!/bin/sh\nexec /usr/bin/sandbox-exec -f ' + shellQuote(profilePath) + ' ' +
    shellQuote(executable) + ' "$@"\n', {flag:'wx', mode:0o700});
  const {_electron: electron} = await import('@playwright/test');
  // Chromium checks MAC_CHROMIUM_TMPDIR before Foundation's temporary directory.
  const env = {...process.env, ROC_DATA_ROOT:dataRoot, TMPDIR:temp, MAC_CHROMIUM_TMPDIR:temp};
  delete env.ROC_SMOKE; delete env.ROC_SMOKE_API_KEY;
  const probeServer=createServer(socket => socket.destroy());
  await new Promise((done, reject) => {probeServer.once('error',reject);probeServer.listen(0,'127.0.0.1',done);});
  const probePort=probeServer.address().port, forbiddenWrite=join(root,'startup-write-must-be-denied');
  let app;
  try {
    // macOS forbids applying Chromium's second seatbelt profile inside our
    // inherited profile. Only this contained maintenance process disables it;
    // the outer write/network restrictions remain mandatory for all children.
    app = await electron.launch({executablePath:wrapper, args:[resolve('dist/main/index.js'),
      '--no-sandbox', `--user-data-dir=${join(isolated, 'chromium')}`], env, timeout:60000});
    const diagnostic = join(isolated, 'startup-events.jsonl');
    const event = (kind, message) => appendFileSync(diagnostic, JSON.stringify({kind,message})+'\n');
    app.process().stderr.on('data', data => event('stderr', data.toString()));
    const boundaries=await app.evaluate(async (_electron, {forbiddenWrite,probePort}) => {
      let fileCode;
      try {process.getBuiltinModule('fs').writeFileSync(forbiddenWrite,'must-not-write',{flag:'wx'});}
      catch(error) {fileCode=error.code;}
      const networkCode=await new Promise(resolve => {
        const socket=process.getBuiltinModule('net').connect(probePort,'127.0.0.1');
        socket.once('connect',()=>{socket.destroy();resolve('connected');});
        socket.once('error',error=>resolve(error.code));
        socket.setTimeout(3000,()=>{socket.destroy();resolve('timeout');});
      });
      return {fileCode,networkCode};
    }, {forbiddenWrite,probePort});
    assert.ok(['EPERM','EACCES'].includes(boundaries.fileCode),'migration_write_boundary_failed');
    assert.ok(['EPERM','EACCES'].includes(boundaries.networkCode),'migration_network_boundary_failed');
    assert.equal(existsSync(forbiddenWrite),false);
    event('boundaries',boundaries);
    const page = await app.firstWindow();
    page.on('pageerror', error => event('pageerror', error.message));
    page.on('requestfailed', request => event('requestfailed', request.failure()));
    page.on('console', message => {if(message.type()==='error') event('console-error', message.text());});
    await page.getByTestId('portal').waitFor({timeout:60000});
    const projects = await page.evaluate(() => window.roc.research.listProjects());
    assert.equal(projects.ok, true, 'migration_startup_projects_failed');
    assert.deepEqual(projects.data.map(row => row.id).sort(), projectIds);
  } finally {try {await app?.close();} finally {probeServer.close();rmSync(temp,{recursive:true,force:true});}}
  const reopened = new Database(databasePath, {readonly:true});
  try {for (const name of preserved) assert.deepEqual(fingerprintTable(reopened, name), before[name], `migration_startup_history_changed:${name}`);}
  finally {reopened.close();}
  assert.equal(applicationIdentity(), buildHash, 'migration_app_changed_during_startup');
  verifyResearchMigration(root);
  const result = {schemaVersion:1, status:'startup-verified', candidateHash:receipt.candidateHash,
    buildHash, isolation:'inherited-macos-seatbelt', chromiumNestedSandbox:false,
    boundariesVerified:true, projectCount:projectIds.length, preserved, verifiedAt:new Date().toISOString()};
  writeFileSync(join(root, 'startup.json'), JSON.stringify(result,null,2)+'\n', {flag:'wx',mode:0o600});
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {const flags=readFlags(process.argv.slice(2), ['--migration']);
    console.log(JSON.stringify(await verifyResearchMigrationStartup(flags['--migration'])));
  } catch(error) {console.error(error); process.exitCode=1;}
}
