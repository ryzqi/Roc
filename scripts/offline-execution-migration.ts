import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import Database, {type Database as Connection} from 'better-sqlite3';
import {acquireDatabaseMaintenanceLease} from '../src/main/infrastructure/database-maintenance-lease';
import {applyDatabaseMigrations, type RocDatabaseMigration} from '../src/main/infrastructure/database-migrations';
import {agentMigrations, coreMigrations, diagnosticsMigrations, memoryMigrations, researchMigrations, taskMigrations, workspaceMigrations} from '../src/main/infrastructure/database-schemas';
import type {RocLogicalDatabaseName} from '../src/main/infrastructure/database-pragmas';
import {researchTaskExecutionSchema, researchTaskSchema} from '../src/shared/schemas/research-tasks';
import {z} from 'zod';
import {researchStageRunSchema} from '../src/shared/schemas/research-runs';
import {literatureSearchResultSchema} from '../src/shared/schemas/literature-import';
import {literatureSearchPoolSchema} from '../src/shared/schemas/literature-search-pool';

const targets: Array<{name: RocLogicalDatabaseName; file: string; version: number; migrations: RocDatabaseMigration[]}> = [
  {name:'core',file:'data/core.db',version:1,migrations:coreMigrations},
  ...([
    ['agent',19,agentMigrations],['memory',2,memoryMigrations],['task',1,taskMigrations],
    ['workspace',1,workspaceMigrations],['diagnostics',1,diagnosticsMigrations],['research',60,researchMigrations]
  ] as const).map(([name,version,migrations]) => ({name: (['agent','memory','task'].includes(name) ? name : `plugin:@roc/plugin-${name}`) as RocLogicalDatabaseName,
    file:`data/plugins/@roc/plugin-${name}.db`,version,migrations}))
];
const hash = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
// Version 2 had the same parent contract; only its envelope version differs.
const historicalExecutionSchema = z.object({...researchTaskExecutionSchema.shape, schemaVersion:z.literal(2)}).strict()
  .refine(value => (value.parentKind === null) === (value.parentExecutionId === null), {message:'research_task_parent_incomplete'});
const rows = (db: Connection, table: string) => {
  if (!/^[a-z_][a-z0-9_]*$/u.test(table)) throw new Error('offline_table_invalid');
  // pi-lens-ignore: sql-injection
  return db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
};
function parseRecord(raw: unknown): Record<string, unknown> {
  try { return z.record(z.string(),z.unknown()).parse(JSON.parse(String(raw))); }
  catch (cause) { throw new Error('offline_snapshot_invalid',{cause}); }
}
const tables = (db: Connection) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
const inventory = (db: Connection) => Object.fromEntries(tables(db).map(table=>[table,{count:rows(db,table).length,hash:hash(JSON.stringify(rows(db,table)))}]));
function checkIntegrity(db: Connection): void {
  if (db.pragma('integrity_check',{simple:true}) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('offline_integrity_failed');
}
function schemaObjects(db: Connection): {type:string;name:string;sql:string}[] {
  return (db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {type:string;name:string;sql:string}[])
    .map(row=>({...row,sql:row.sql.replace(/\s+/gu,' ').trim()}));
}
function preflight(db: Connection, target: typeof targets[number]): void {
  checkIntegrity(db);
  const probe = new Database(':memory:');
  try {
    applyDatabaseMigrations(probe,{dbName:target.name,migrations:target.migrations.slice(0,target.version)});
    for (const query of ['SELECT db_name,version,name,checksum FROM schema_migrations ORDER BY db_name,version',
      'SELECT db_name,current_version,schema_checksum FROM schema_metadata ORDER BY db_name']) {
      if (JSON.stringify(db.prepare(query).all()) !== JSON.stringify(probe.prepare(query).all())) throw new Error('offline_source_version_unapproved');
    }
    if (JSON.stringify(schemaObjects(db)) !== JSON.stringify(schemaObjects(probe))) throw new Error('offline_source_schema_changed');
  } finally { probe.close(); }
}
function audit(db: Connection, table: string, id: string, version: string, value: unknown, reason = 'historical_execution_not_resumable'): string {
  const raw = JSON.stringify(value);
  const auditId = hash(`${table}:${id}`);
  db.prepare('INSERT INTO execution_historical_audit VALUES (?,?,?,?,?,?,?)').run(auditId,table,id,version,raw,hash(raw),reason);
  return auditId;
}
function validateLinks(agent: Connection, research: Connection, executionVersion: 1 | 2): void {
  for (const row of rows(agent,'research_task_executions')) {
    const old = parseRecord(row.snapshot_json);
    const task = agent.prepare('SELECT project_id FROM research_tasks WHERE id=?').get(row.task_id) as {project_id:string}|undefined;
    if (old.schemaVersion !== executionVersion || old.executionId !== row.execution_id || old.kind !== row.kind || old.taskId !== row.task_id || old.projectId !== row.project_id || task?.project_id !== row.project_id) throw new Error('offline_execution_identity_invalid');
    if (executionVersion === 2) historicalExecutionSchema.parse(old);
    if (old.parentKind !== null) {
      const parent = agent.prepare('SELECT task_id,project_id FROM research_task_executions WHERE kind=? AND execution_id=?').get(old.parentKind,old.parentExecutionId) as {task_id:string;project_id:string}|undefined;
      if (!parent || parent.task_id !== row.task_id || parent.project_id !== row.project_id) throw new Error('offline_execution_parent_invalid');
    }
    if (row.kind === 'stage') {
      const stage = research.prepare('SELECT task_id,project_id FROM research_stage_runs WHERE id=?').get(row.execution_id) as {task_id:string;project_id:string}|undefined;
      if (!stage || stage.task_id !== row.task_id || stage.project_id !== row.project_id) throw new Error('offline_stage_link_invalid');
    }
  }
  for (const row of rows(research,'research_stage_runs')) {
    if (row.task_id === null) continue;
    const link = agent.prepare("SELECT task_id,project_id FROM research_task_executions WHERE kind='stage' AND execution_id=?").get(row.id) as {task_id:string;project_id:string}|undefined;
    if (!link || link.task_id !== row.task_id || link.project_id !== row.project_id) throw new Error('offline_stage_link_invalid');
  }
}
function convertAgent(db: Connection): void {
  const now = new Date().toISOString();
  for (const row of rows(db,'agent_runs')) {
    if (row.snapshot_json !== null && ![7,8,9].includes(Number(row.snapshot_version))) throw new Error('offline_snapshot_version_unapproved');
    audit(db,'agent_runs',String(row.id),String(row.snapshot_version),row);
    db.prepare("UPDATE agent_runs SET snapshot_json=NULL,snapshot_version=NULL,snapshot_error_code='historical_execution_not_resumable',status=CASE WHEN status IN ('completed','failed','cancelled','interrupted') THEN status ELSE 'interrupted' END,ended_at=COALESCE(ended_at,?) WHERE id=?").run(now,row.id);
    db.prepare('INSERT OR IGNORE INTO agent_execution_run_fences(run_id,revoked_at) VALUES (?,?)').run(row.id,now);
  }
  for (const row of rows(db,'research_task_executions')) {
    const old = parseRecord(row.snapshot_json);
    const auditId = audit(db,'research_task_executions',`${row.kind}:${row.execution_id}`,'1',row);
    const current = researchTaskExecutionSchema.parse({...old,schemaVersion:3,nodeBinding:{kind:'none'},
      origin:{kind:'historical',auditId,reason:'historical_execution_not_resumable'},frozenInputs:null,associationState:'historical'});
    db.prepare('UPDATE research_task_executions SET snapshot_json=? WHERE kind=? AND execution_id=?').run(JSON.stringify(current),row.kind,row.execution_id);
  }
  for (const row of rows(db,'research_tasks')) {
    const task = researchTaskSchema.extend({schemaVersion:z.literal(2)}).parse(parseRecord(row.snapshot_json));
    if (task.id !== row.id || task.projectId !== row.project_id || task.status !== row.status) throw new Error('offline_task_identity_invalid');
    audit(db,'research_tasks',task.id,'2',row);
    const status = ['completed','cancelled','failed'].includes(task.status) ? task.status : 'interrupted';
    db.prepare('UPDATE research_tasks SET status=?,snapshot_json=? WHERE id=?').run(status,JSON.stringify({...task,schemaVersion:3,status,statusReason:'historical_execution_not_resumable',updatedAt:now}),task.id);
  }
  // Raw bytes, original global sequence and retention boundaries remain in the audit and backup.
  const eventTables = [
    ['agent_run_events', 'DELETE FROM agent_run_events'],
    ['agent_run_event_snapshots', 'DELETE FROM agent_run_event_snapshots'],
    ['agent_run_event_snapshot_pending', 'DELETE FROM agent_run_event_snapshot_pending']
  ] as const;
  for (const [table, deletion] of eventTables) {
    for (const [index,row] of rows(db,table).entries()) audit(db,table,String(index),'legacy',row);
    db.exec(deletion);
  }
  for (const row of rows(db,'research_task_events').filter(row=>row.envelope_json === null)) {
    audit(db,'research_task_events',String(row.sequence),'legacy',row);
  }
  db.exec('DELETE FROM research_task_events WHERE envelope_json IS NULL');
  for (const row of rows(db,'agent_tool_effects')) {
    audit(db,'agent_tool_effects',`${row.run_id}:${row.execution_path}:${row.checkpoint_id}:${row.tool_call_id}`,String(row.identity_version),row);
    if (row.identity_version === 0) db.prepare('DELETE FROM agent_tool_effects WHERE run_id=? AND execution_path=? AND checkpoint_id=? AND tool_call_id=?').run(row.run_id,row.execution_path,row.checkpoint_id,row.tool_call_id);
  }
  for (const table of ['agent_execution_grants','agent_execution_approvals','agent_research_dispatch_grants']) {
    for (const [index,row] of rows(db,table).entries()) audit(db,table,String(index),'1',row,'historical_authorization_revoked');
  }
  db.prepare("UPDATE agent_execution_grants SET status='revoked',revoked_at=? WHERE status='issued'").run(now);
  db.prepare("UPDATE agent_execution_approvals SET status='revoked',revoked_at=? WHERE status='issued'").run(now);
  db.exec("UPDATE agent_research_dispatch_grants SET state='revoked' WHERE state='issued'");
  for (const row of rows(db,'agent_budget_calls')) audit(db,'agent_budget_calls',`${row.run_id}:${row.call_id}`,'1',row);
  db.exec("UPDATE agent_budget_calls SET state='unknown' WHERE state='reserved'");
}
function convertResearch(db: Connection): void {
  for (const row of rows(db,'research_stage_runs')) {
    audit(db,'research_stage_runs',String(row.id),'legacy',row);
    const old = parseRecord(row.snapshot_json);
    const current = researchStageRunSchema.parse({...old,executionSnapshot:null});
    if (current.id !== row.id || current.projectId !== row.project_id || current.taskId !== row.task_id || current.status !== row.status) throw new Error('offline_stage_identity_invalid');
    db.prepare('UPDATE research_stage_runs SET snapshot_json=? WHERE id=?').run(JSON.stringify(current),row.id);
  }
}

function convertSkillAgent(db: Connection): void {
  const now = new Date().toISOString();
  const taskIds = new Set(rows(db,'research_task_executions').filter(row=>row.kind === 'stage' &&
    historicalExecutionSchema.parse(parseRecord(row.snapshot_json)).associationState !== 'historical').map(row=>String(row.task_id)));
  for (const row of rows(db,'research_task_executions')) {
    if (!taskIds.has(String(row.task_id))) continue;
    const execution = historicalExecutionSchema.parse(parseRecord(row.snapshot_json));
    if (execution.associationState === 'historical') continue;
    const auditId = audit(db,'research_task_executions',`${row.kind}:${row.execution_id}`,'2',row);
    const current = researchTaskExecutionSchema.parse({...execution,schemaVersion:3,origin:{kind:'historical',auditId,
      reason:'historical_execution_not_resumable'},frozenInputs:null,associationState:'historical'});
    db.prepare('UPDATE research_task_executions SET snapshot_json=? WHERE kind=? AND execution_id=?')
      .run(JSON.stringify(current),row.kind,row.execution_id);
    if (row.kind === 'chat') {
      const chat = db.prepare('SELECT * FROM agent_runs WHERE id=?').get(row.execution_id) as Record<string,unknown> | undefined;
      if (!chat) throw new Error('offline_chat_link_invalid');
      audit(db,'agent_runs',String(row.execution_id),'10',chat);
      db.prepare("UPDATE agent_runs SET snapshot_json=NULL,snapshot_version=NULL,snapshot_error_code='historical_execution_not_resumable',status=CASE WHEN status IN ('completed','failed','cancelled','interrupted') THEN status ELSE 'interrupted' END,ended_at=COALESCE(ended_at,?) WHERE id=?").run(now,row.execution_id);
      db.prepare('INSERT OR IGNORE INTO agent_execution_run_fences(run_id,revoked_at) VALUES (?,?)').run(row.execution_id,now);
      db.prepare("UPDATE agent_execution_grants SET status='revoked',revoked_at=? WHERE run_id=? AND status='issued'").run(now,row.execution_id);
      db.prepare("UPDATE agent_execution_approvals SET status='revoked',revoked_at=? WHERE run_id=? AND status='issued'").run(now,row.execution_id);
      db.prepare("UPDATE agent_research_dispatch_grants SET state='revoked' WHERE run_id=? AND state='issued'").run(row.execution_id);
    }
  }
  for (const row of rows(db,'research_tasks')) {
    if (!taskIds.has(String(row.id))) continue;
    const task = researchTaskSchema.extend({schemaVersion:z.literal(2)}).parse(parseRecord(row.snapshot_json));
    if (task.id !== row.id || task.projectId !== row.project_id || task.status !== row.status) throw new Error('offline_task_identity_invalid');
    audit(db,'research_tasks',task.id,'2',row);
    const status = ['completed','cancelled','failed'].includes(task.status) ? task.status : 'interrupted';
    db.prepare('UPDATE research_tasks SET status=?,snapshot_json=? WHERE id=?')
      .run(status,JSON.stringify({...task,schemaVersion:3,status,statusReason:'historical_execution_not_resumable',updatedAt:now}),task.id);
    db.prepare("UPDATE agent_budget_calls SET state='unknown' WHERE task_id=? AND state='reserved'").run(task.id);
  }
}

function convertSkillResearch(db: Connection): void {
  for (const row of rows(db,'research_stage_runs')) {
    const run = researchStageRunSchema.parse(parseRecord(row.snapshot_json));
    if (run.id !== row.id || run.projectId !== row.project_id || run.taskId !== row.task_id || run.status !== row.status) throw new Error('offline_stage_identity_invalid');
    if (run.executionSnapshot === null) continue;
    audit(db,'research_stage_runs',run.id,'stage1-no-skill-manifest',row);
    db.prepare('UPDATE research_stage_runs SET snapshot_json=? WHERE id=?').run(JSON.stringify({...run,executionSnapshot:null}),run.id);
  }
}

function convertSearchReceipts(db: Connection): void {
  const oldStrategy = z.object({artifactId:z.string().min(1),contentHash:z.string().regex(/^[a-f0-9]{64}$/u),
    approvedAt:z.string(),researchQuestion:z.string().min(1),queryIndex:z.number().int().min(0).max(2)}).strict();
  const historical = (table: string, id: string, row: Record<string, unknown>) => ({kind:'historical' as const,
    auditId:audit(db,table,id,'search-receipt-unversioned',row,'historical_search_plan_not_authorized'),
    reason:'historical_search_plan_not_authorized' as const});
  for (const row of rows(db,'research_literature_searches')) {
    const result = parseRecord(row.result_json);
    if (result.schemaVersion !== 13) throw new Error('offline_search_result_version_unapproved');
    if (result.strategy !== null) oldStrategy.parse(result.strategy);
    const marker = historical('research_literature_searches',String(row.id),row);
    const current = literatureSearchResultSchema.parse({...result,schemaVersion:14,
      strategy:result.strategy === null ? null : marker});
    db.prepare('UPDATE research_literature_searches SET result_json=? WHERE id=?').run(JSON.stringify(current),row.id);
  }
  for (const row of rows(db,'research_literature_search_pools')) {
    const {contentHash,...pool} = parseRecord(row.pool_json);
    if (hash(JSON.stringify(pool)) !== contentHash) throw new Error('offline_search_pool_corrupt');
    if (pool.strategy === null) {
      // Review/monitor receipts bind these bytes. Their unchanged contract needs no conversion.
      literatureSearchPoolSchema.parse({...pool,contentHash});
      continue;
    }
    oldStrategy.parse(pool.strategy);
    const strategy = historical('research_literature_search_pools',String(row.execution_id),row);
    const current = literatureSearchPoolSchema.parse({...pool,strategy,contentHash:'0'.repeat(64)});
    const {contentHash:_hash,...body} = current;
    db.prepare('UPDATE research_literature_search_pools SET pool_json=? WHERE execution_id=?')
      .run(JSON.stringify({...body,contentHash:hash(JSON.stringify(body))}),row.execution_id);
  }
}

function convertSearchPlans(db: Connection): void {
  const projects = new Set<string>();
  const timestamp = new Date().toISOString();
  for (const row of rows(db, 'research_artifact_contents')) {
    const output = parseRecord(row.output_json);
    if (output.searchPlan === undefined) continue;
    audit(db, 'research_artifact_contents', String(row.artifact_id), 'search-plan-unversioned', row, 'historical_search_plan_not_authorized');
    const {searchPlan, ...content} = output;
    // Keep the exact prior plan for inspection as historical text; never invent query IDs or approval.
    content.markdown = `${String(output.markdown)}\n\n## 历史检索计划（不可执行）\n\n升级后需重新生成并人工批准检索计划。\n\n\`\`\`json\n${JSON.stringify(searchPlan, null, 2)}\n\`\`\``;
    db.prepare('UPDATE research_artifact_contents SET output_json=? WHERE artifact_id=?').run(JSON.stringify(content), row.artifact_id);
    const artifact = db.prepare('SELECT * FROM research_artifacts WHERE id=?').get(row.artifact_id) as Record<string, unknown>;
    if (artifact.status !== 'superseded') projects.add(String(row.project_id));
  }
  for (const projectId of projects) {
    for (const artifact of rows(db, 'research_artifacts').filter(row => row.project_id === projectId)) {
      audit(db, 'research_artifacts', String(artifact.id), 'search-plan-unversioned', artifact, 'historical_search_plan_not_authorized');
    }
    for (const state of rows(db, 'research_stage_states').filter(row => row.project_id === projectId)) {
      audit(db, 'research_stage_states', `${projectId}:${state.stage}`, 'search-plan-unversioned', state, 'historical_search_plan_not_authorized');
    }
    const project = db.prepare('SELECT * FROM research_projects WHERE id=?').get(projectId);
    audit(db, 'research_projects', projectId, 'search-plan-unversioned', project, 'historical_search_plan_not_authorized');
    db.prepare("UPDATE research_artifacts SET status='superseded',updated_at=? WHERE project_id=?").run(timestamp, projectId);
    db.prepare(`UPDATE research_stage_states SET status=CASE WHEN stage='discovery' THEN 'ready' ELSE 'locked' END,
      active_run_id=NULL,artifact_ids_json='[]',entered_at=NULL,completed_at=NULL,gate_approved=0,
      last_error='historical_search_plan_not_authorized' WHERE project_id=?`).run(projectId);
    db.prepare(`UPDATE research_projects SET current_stage='discovery',
      status=CASE WHEN status='archived' THEN 'archived' ELSE 'active' END,updated_at=? WHERE id=?`).run(timestamp, projectId);
  }
}
/** Only explicit, stopped sources; all transformations run on disposable copies. */
export async function migrateExecutionDatabases(input: {source: string; destination: string; stopped: boolean}) {
  if (!input.stopped) throw new Error('offline_stop_attestation_required');
  const source = realpathSync(input.source);
  const destination = join(realpathSync(dirname(resolve(input.destination))),relative(dirname(resolve(input.destination)),resolve(input.destination)));
  const destinationRelative = relative(source,destination);
  if (existsSync(destination) || (destinationRelative !== '..' && !destinationRelative.startsWith(`..${sep}`))) throw new Error('offline_destination_must_be_new_and_separate');
  const lease = acquireDatabaseMaintenanceLease({rootDir:source,owner:{kind:'cli',pid:process.pid}});
  const opened: Connection[] = [];
  const report: {status:string; source:string; destination:string; sourceApp:string; targetApp:string; databases:unknown[]; error?:string} = {
    status:'pending',source,destination,sourceApp:'unknown',targetApp:'S05-frozen-search1',databases:[]
  };
  try {
    const sources = targets.map(target=>{
      const db = new Database(join(source,target.file),{readonly:true,fileMustExist:true}); opened.push(db); return db;
    });
    const agent = sources[1]; const research = sources[6];
    if (!agent || !research) throw new Error('offline_source_missing');
    const agentVersion = Number(agent.prepare('SELECT current_version FROM schema_metadata WHERE db_name=?').pluck().get('agent'));
    const researchVersion = Number(research.prepare('SELECT current_version FROM schema_metadata WHERE db_name=?').pluck().get('plugin:@roc/plugin-research'));
    const fromS02 = agentVersion === 20 && researchVersion === 61;
    const fromS04 = agentVersion === 20 && researchVersion === 62;
    const fromS05 = agentVersion === 20 && researchVersion === 63;
    const currentExecution = fromS02 || fromS04 || fromS05;
    if (!currentExecution && !(agentVersion === 19 && researchVersion === 60)) throw new Error('offline_source_version_unapproved');
    report.sourceApp = fromS05 ? '9d16212d-S05' : fromS04 ? '4381104-S04' : fromS02 ? '7120421-S02' : 'eea2087b5d2d79df3b2fea7764ce48e4975fd764';
    const sourceTargets = targets.map(target=>({...target,version:target.name === 'agent' ? agentVersion :
      target.name === 'plugin:@roc/plugin-research' ? researchVersion : target.version}));
    for (const [index,target] of sourceTargets.entries()) preflight(sources[index]!,target);
    if (agent.prepare("SELECT 1 FROM agent_tool_effects WHERE status IN ('reserved','in_progress','unknown') LIMIT 1").get()) throw new Error('offline_unresolved_effect');
    if (agent.prepare('SELECT 1 FROM agent_run_leases LIMIT 1').get() || research.prepare("SELECT 1 FROM research_stage_runs WHERE status IN ('queued','running') LIMIT 1").get()) throw new Error('offline_execution_not_stopped');
    validateLinks(agent,research,currentExecution ? 2 : 1);
    mkdirSync(destination,{mode:0o700});
    const backup = join(destination,'backup'); const current = join(destination,'current');
    cpSync(source,backup,{recursive:true,filter:path=>!path.endsWith('.database-maintenance.lock')});
    for (const [index,target] of targets.entries()) {
      const path = join(backup,target.file);
      for (const suffix of ['','-wal','-shm']) rmSync(`${path}${suffix}`,{force:true});
      const sourceDatabase = sources[index];
      if (!sourceDatabase) throw new Error('offline_source_missing');
      await sourceDatabase.backup(path);
    }
    cpSync(backup,current,{recursive:true});
    writeFileSync(join(destination,'migration-report.json'),JSON.stringify(report,null,2));
    for (const target of sourceTargets) {
      const db = new Database(join(current,target.file));
      try {
        const before = inventory(db);
        const budgetBefore = target.name === 'agent' ? rows(db,'agent_budget_calls').map(({state:_state,envelope_json:_envelope,...row})=>row) : null;
        applyDatabaseMigrations(db,{dbName:target.name,migrations:target.migrations,allowOffline:true});
        db.transaction(()=>{
          if (target.name === 'agent') {
            currentExecution ? convertSkillAgent(db) : convertAgent(db);
            // Non-stage histories also adopt the sole current envelope, without new authority.
            db.exec("UPDATE research_tasks SET snapshot_json=json_set(snapshot_json,'$.schemaVersion',3); UPDATE research_task_executions SET snapshot_json=json_set(snapshot_json,'$.schemaVersion',3);");
          }
          if (target.name === 'plugin:@roc/plugin-research') {
            currentExecution ? convertSkillResearch(db) : convertResearch(db);
            if (!fromS05) { convertSearchReceipts(db); convertSearchPlans(db); }
          }
          checkIntegrity(db);
        })();
        if (budgetBefore !== null && JSON.stringify(budgetBefore) !== JSON.stringify(rows(db,'agent_budget_calls').map(({state:_state,envelope_json:_envelope,...row})=>row))) throw new Error('offline_budget_changed');
        for (const row of tables(db).includes('execution_historical_audit') ? rows(db,'execution_historical_audit') : []) {
          if (hash(String(row.raw_json)) !== row.raw_hash) throw new Error('offline_audit_hash_invalid');
        }
        report.databases.push({name:target.name,from:target.version,to:target.migrations.length,backupHash:hash(readFileSync(join(backup,target.file))),before,after:inventory(db)});
        writeFileSync(join(destination,'migration-report.json'),JSON.stringify(report,null,2));
      } finally {db.close();}
    }
    report.status='complete';
    writeFileSync(join(destination,'migration-report.json'),JSON.stringify(report,null,2));
    return report;
  } catch (error) {
    report.status='failed';report.error=error instanceof Error ? error.message : 'offline_conversion_failed';
    if (existsSync(destination)) writeFileSync(join(destination,'migration-report.json'),JSON.stringify(report,null,2));
    throw error;
  } finally {for (const db of opened) db.close(); lease.release();}
}
