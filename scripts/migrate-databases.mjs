/** Offline S02 conversion: the stopped source is preserved; output contains backup/current/report. */
import { parseArgs } from 'node:util';
import { importTypeScriptModule } from './lib/bundle-ts.mjs';

const {values} = parseArgs({options:{
  source:{type:'string'},destination:{type:'string'},stopped:{type:'boolean'},help:{type:'boolean'}
}});
if (values.help) {
  console.log('pnpm database:migrate --source /stopped/roc-root --destination /new/output --stopped');
} else {
  if (!values.source || !values.destination || !values.stopped) throw new Error('Explicit --source, --destination and --stopped are required');
  const {migrateExecutionDatabases} = await importTypeScriptModule('scripts/offline-execution-migration.ts',{
    platform:'node',external:['better-sqlite3'],tempDir:new URL('../.runtime/tmp',import.meta.url).pathname
  });
  const report=await migrateExecutionDatabases({source:values.source,destination:values.destination,stopped:true});
  console.log(JSON.stringify(report,null,2));
}
