import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Database} from 'better-sqlite3';
import {z} from 'zod';
import {
  monitorSchema, monitorVersionSchema, monitorCheckSchema, monitorAlertSchema,
  monitorSaveSchema, monitorControlSchema, monitorAcknowledgeSchema, monitorHistorySchema, monitorListSchema,
  type MonitorSave, type ResearchMonitor, type MonitorVersion, type MonitorCheck, type MonitorAlert, type MonitorEvent
} from '../../../shared/schemas/research-monitors';
import {requireResearchHuman} from '../../services/research-human-context';
import type {ResearchRepository} from './repository';
import {normalizeResearchDoi} from './literature-identity';
import {resourceContentHash} from './resource-repository';
import {monitorUpdateEndpoint, readMonitorUpdates, searchMonitorMaterial} from './monitor-provider-adapter';
import {literatureSearchInputSchema} from '../../../shared/schemas/literature-import';
import {literatureSearchPoolSchema} from '../../../shared/schemas/literature-search-pool';
import {fuseLiterature, literatureRanking} from './literature-fusion';

type MonitorRow = {id: string; project_id: string; revision: number; query_version: number; snapshot_json: string};
type VersionRow = {monitor_id: string; project_id: string; version: number; snapshot_json: string};
type CheckRow = {id: string; monitor_id: string; project_id: string; query_version: number; control_revision: number;
  check_key: string; status: string; snapshot_json: string};
type AlertRow = {id: string; project_id: string; monitor_id: string; check_id: string; query_version: number;
  source: string; identity: string; kind: string; snapshot_json: string; ack_json: string | null};
const checkpointSchema = z.strictObject({monitorId: z.string(), queryVersion: z.number().int().positive(),
  source: z.string(), baseline: z.boolean(), offset: z.number().int().nonnegative(),
  checkId: z.string(), contentHash: z.string()});
export function sealMonitor<T extends {contentHash: string}>(value: T): T {
  const {contentHash: _hash, ...body} = value;
  return {...value, contentHash: resourceContentHash(body)};
}
function parse<T extends {contentHash: string}>(json: string, schema: z.ZodType<T>): T {
  try {
    const value = schema.parse(JSON.parse(json)), {contentHash, ...body} = value;
    if (resourceContentHash(body) !== contentHash) throw new Error('monitor_hash_invalid');
    return value;
  } catch (cause) {throw new Error('research_monitor_storage_invalid', {cause});}
}
export const monitorPeriod = (cadence: ResearchMonitor['cadence']): number => (cadence === 'daily' ? 1 : 7) * 86400_000;

export class ResearchMonitorRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository,
    private readonly now: () => string = () => new Date().toISOString()) {}

  get(projectId: string, monitorId: string): ResearchMonitor {
    this.research.getProject(projectId);
    const row = this.db.prepare('SELECT * FROM research_monitors WHERE id=? AND project_id=?')
      .get(monitorId, projectId) as MonitorRow | undefined;
    if (row === undefined) throw new Error('research_monitor_not_found');
    const value = parse(row.snapshot_json, monitorSchema);
    if (value.id !== row.id || value.projectId !== row.project_id || value.revision !== row.revision ||
      value.queryVersion !== row.query_version) throw new Error('research_monitor_storage_invalid');
    this.version(projectId, monitorId, value.queryVersion);
    return value;
  }

  version(projectId: string, monitorId: string, version: number): MonitorVersion {
    this.research.getProject(projectId);
    const row = this.db.prepare('SELECT * FROM research_monitor_versions WHERE monitor_id=? AND project_id=? AND version=?')
      .get(monitorId, projectId, version) as VersionRow | undefined;
    if (row === undefined) throw new Error('research_monitor_version_not_found');
    const value = parse(row.snapshot_json, monitorVersionSchema);
    if (value.monitorId !== row.monitor_id || value.projectId !== row.project_id || value.version !== row.version)
      throw new Error('research_monitor_storage_invalid');
    return value;
  }

  requireActive(monitor: ResearchMonitor): void {
    if (this.research.getProject(monitor.projectId).status === 'archived') throw new Error('research_project_archived');
    const current = this.get(monitor.projectId, monitor.id);
    if (current.revision !== monitor.revision || current.queryVersion !== monitor.queryVersion)
      throw new Error('research_monitor_version_changed');
    const query = this.version(monitor.projectId, monitor.id, monitor.queryVersion).query;
    if (query.kind === 'updates') {
      const item = this.research.library.get(query.itemId);
      if (!item.projectIds.includes(monitor.projectId) || item.archived || item.revision !== query.itemRevision ||
        item.metadata.doi === null || normalizeResearchDoi(item.metadata.doi) !== query.doi)
        throw new Error('research_monitor_target_changed');
    }
  }

  save(input: MonitorSave): ResearchMonitor {
    const request = monitorSaveSchema.parse(input), actor = requireResearchHuman('research.monitors.save', request.projectId);
    if (request.query.kind === 'updates') request.query.doi = normalizeResearchDoi(request.query.doi);
    return this.db.transaction(() => {
      const replay = this.replay(request.projectId, request.requestId, request);
      if (replay !== null) return replay;
      if (this.research.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
      const previous = request.monitorId === null ? null : this.get(request.projectId, request.monitorId);
      if (previous !== null && previous.revision !== request.expectedRevision) throw new Error('research_monitor_version_changed');
      const timestamp = this.now(), monitorId = previous?.id ?? `monitor_${randomUUID()}`;
      const version = sealMonitor(monitorVersionSchema.parse({
        monitorId, projectId: request.projectId, version: (previous?.queryVersion ?? 0) + 1,
        query: request.query, createdAt: timestamp, actor, contentHash: '0'.repeat(64)
      }));
      const monitor = sealMonitor(monitorSchema.parse({
        id: monitorId, projectId: request.projectId, revision: request.expectedRevision + 1,
        queryVersion: version.version, title: request.title, cadence: request.cadence,
        status: previous?.status ?? 'active',
        nextCheckAt: new Date(Date.parse(timestamp) + monitorPeriod(request.cadence)).toISOString(),
        createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, actor, lastError: null, contentHash: '0'.repeat(64)
      }));
      if (previous === null) this.db.prepare(`INSERT INTO research_monitors
        (id,project_id,revision,query_version,snapshot_json) VALUES (?,?,?,?,?)`)
        .run(monitor.id, monitor.projectId, monitor.revision, monitor.queryVersion, JSON.stringify(monitor));
      else this.write(monitor, previous.revision);
      this.db.prepare('INSERT INTO research_monitor_versions (monitor_id,project_id,version,snapshot_json) VALUES (?,?,?,?)')
        .run(monitor.id, monitor.projectId, version.version, JSON.stringify(version));
      this.requireActive(monitor);
      this.recordRequest(request.projectId, request.requestId, request, monitor);
      return this.get(monitor.projectId, monitor.id);
    })();
  }

  control(input: z.infer<typeof monitorControlSchema>): ResearchMonitor {
    const request = monitorControlSchema.parse(input), actor = requireResearchHuman('research.monitors.control', request.projectId);
    return this.db.transaction(() => {
      const replay = this.replay(request.projectId, request.requestId, request);
      if (replay !== null) return replay;
      const current = this.get(request.projectId, request.monitorId);
      if (current.revision !== request.expectedRevision) throw new Error('research_monitor_version_changed');
      // Pausing remains available when a watched item has changed.
      if (request.action === 'resume') this.requireActive(current);
      else if (this.research.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
      const timestamp = this.now();
      const next = sealMonitor({...current, revision: current.revision + 1, actor, updatedAt: timestamp, lastError: null,
        status: request.action === 'pause' ? 'paused' as const : 'active' as const,
        nextCheckAt: request.action === 'resume' ? new Date(Date.parse(timestamp) + monitorPeriod(current.cadence)).toISOString() : current.nextCheckAt});
      this.write(next, current.revision);
      const saved = this.get(next.projectId, next.id);
      this.recordRequest(request.projectId, request.requestId, request, saved);
      return saved;
    })();
  }

  begin(monitor: ResearchMonitor, key: string, trigger: MonitorCheck['trigger'], scheduledAt: string | null): MonitorCheck {
    return this.db.transaction(() => {
      const replay = this.findCheck(monitor.projectId, monitor.id, key);
      if (replay !== null) {
        if (replay.controlRevision !== monitor.revision || replay.queryVersion !== monitor.queryVersion ||
          replay.trigger !== trigger || replay.scheduledAt !== scheduledAt) throw new Error('research_monitor_request_conflict');
        return replay;
      }
      this.requireActive(monitor);
      if (trigger === 'scheduled' && (monitor.status !== 'active' || monitor.nextCheckAt !== scheduledAt))
        throw new Error('research_monitor_version_changed');
      if (this.db.prepare("SELECT 1 FROM research_monitor_checks WHERE monitor_id=? AND status='running'").get(monitor.id))
        throw new Error('research_monitor_check_busy');
      const check = sealMonitor(monitorCheckSchema.parse({
        id: `monitorcheck_${randomUUID()}`, projectId: monitor.projectId, monitorId: monitor.id, key,
        queryVersion: monitor.queryVersion, controlRevision: monitor.revision, trigger, scheduledAt,
        startedAt: this.now(), finishedAt: null, status: 'running', errorCode: null, sources: [],
        alertCount: 0, contentHash: '0'.repeat(64)
      }));
      this.db.prepare(`INSERT INTO research_monitor_checks
        (id,project_id,monitor_id,query_version,control_revision,check_key,status,snapshot_json) VALUES (?,?,?,?,?,?,?,?)`)
        .run(check.id, check.projectId, check.monitorId, check.queryVersion, check.controlRevision, key, check.status, JSON.stringify(check));
      this.requireActive(monitor);
      return this.check(check.projectId, check.monitorId, check.id);
    })();
  }

  findCheck(projectId: string, monitorId: string, key: string): MonitorCheck | null {
    this.get(projectId, monitorId);
    const row = this.db.prepare('SELECT * FROM research_monitor_checks WHERE project_id=? AND monitor_id=? AND check_key=?')
      .get(projectId, monitorId, key) as CheckRow | undefined;
    return row === undefined ? null : this.parseCheck(row);
  }
  check(projectId: string, monitorId: string, checkId: string): MonitorCheck {
    this.get(projectId, monitorId);
    const row = this.db.prepare('SELECT * FROM research_monitor_checks WHERE project_id=? AND monitor_id=? AND id=?')
      .get(projectId, monitorId, checkId) as CheckRow | undefined;
    if (row === undefined) throw new Error('research_monitor_check_not_found');
    return this.parseCheck(row);
  }
  checkpoint(monitor: ResearchMonitor, source: string): {baseline: boolean; offset: number} {
    const row = this.db.prepare('SELECT snapshot_json FROM research_monitor_checkpoints WHERE monitor_id=? AND query_version=? AND source=?')
      .get(monitor.id, monitor.queryVersion, source) as {snapshot_json: string} | undefined;
    if (row === undefined) return {baseline: false, offset: 0};
    const value = parse(row.snapshot_json, checkpointSchema);
    if (value.monitorId !== monitor.id || value.queryVersion !== monitor.queryVersion || value.source !== source)
      throw new Error('research_monitor_storage_invalid');
    const check = this.check(monitor.projectId, monitor.id, value.checkId);
    if (check.queryVersion !== value.queryVersion || !check.sources.some(entry => entry.source === source && entry.status === 'ok'))
      throw new Error('research_monitor_storage_invalid');
    return value;
  }

  finish(monitor: ResearchMonitor, input: MonitorCheck): MonitorCheck {
    return this.db.transaction(() => {
      const current = this.check(input.projectId, input.monitorId, input.id);
      if (current.status !== 'running') throw new Error('research_monitor_check_terminal');
      if (input.status === 'complete' || input.status === 'partial' || input.status === 'failed' && input.errorCode === null) {
        this.requireActive(monitor);
        for (const source of input.sources) {
          const checkpoint = this.checkpoint(monitor, source.source);
          for (const event of source.material?.events ?? []) {
            if (event.kind === 'new_paper' && source.status !== 'ok') continue;
            const seen = event.kind !== 'new_paper' ? undefined : this.db.prepare(`SELECT first_check_id FROM research_monitor_seen
              WHERE monitor_id=? AND query_version=? AND source=? AND identity=?`)
              .get(monitor.id, monitor.queryVersion, source.source, event.identity) as {first_check_id: string} | undefined;
            if (seen !== undefined) {
              const first = this.check(monitor.projectId, monitor.id, seen.first_check_id);
              if (first.queryVersion !== monitor.queryVersion || !first.sources.some(record => record.source === source.source &&
                record.status === 'ok' && record.material?.events.some(previous =>
                  previous.kind === 'new_paper' && previous.identity === event.identity)))
                throw new Error('research_monitor_storage_invalid');
            }
            if ((event.kind !== 'new_paper' || checkpoint.baseline && seen === undefined) && this.insertAlert(input, source.source, event))
              input.alertCount++;
            if (source.status === 'ok' && event.kind === 'new_paper')
              this.db.prepare(`INSERT OR IGNORE INTO research_monitor_seen
                (monitor_id,query_version,source,identity,first_check_id) VALUES (?,?,?,?,?)`)
                .run(monitor.id, monitor.queryVersion, source.source, event.identity, input.id);
          }
          if (source.status !== 'ok') continue;
          const next = sealMonitor({monitorId: monitor.id, queryVersion: monitor.queryVersion, source: source.source,
            baseline: true, offset: source.material?.nextOffset ?? 0, checkId: input.id, contentHash: ''});
          this.db.prepare(`INSERT INTO research_monitor_checkpoints (monitor_id,query_version,source,snapshot_json)
            VALUES (?,?,?,?) ON CONFLICT(monitor_id,query_version,source) DO UPDATE SET snapshot_json=excluded.snapshot_json`)
            .run(monitor.id, monitor.queryVersion, source.source, JSON.stringify(next));
        }
        this.requireActive(monitor);
      }
      const finished = sealMonitor(monitorCheckSchema.parse(input));
      if (Buffer.byteLength(JSON.stringify(finished)) > 4 * 1024 * 1024) throw new Error('research_monitor_check_too_large');
      this.db.prepare('UPDATE research_monitor_checks SET status=?,snapshot_json=? WHERE id=? AND status=?')
        .run(finished.status, JSON.stringify(finished), finished.id, 'running');
      for (const row of this.db.prepare('SELECT * FROM research_monitor_alerts WHERE check_id=?').all(finished.id) as AlertRow[])
        this.parseAlert(row);
      const latest = this.get(monitor.projectId, monitor.id);
      if (latest.revision === monitor.revision && latest.queryVersion === monitor.queryVersion) {
        const timestamp = this.now();
        const nextCheckAt = input.trigger === 'scheduled' ?
          new Date(Math.max(Date.parse(monitor.nextCheckAt) + monitorPeriod(monitor.cadence),
            Date.parse(timestamp) + monitorPeriod(monitor.cadence))).toISOString() : latest.nextCheckAt;
        this.write(sealMonitor({...latest, nextCheckAt, updatedAt: timestamp, lastError: finished.errorCode}), latest.revision);
      }
      return this.check(finished.projectId, finished.monitorId, finished.id);
    })();
  }

  recover(): void {
    const rows = this.db.prepare("SELECT * FROM research_monitor_checks WHERE status='running'").all() as CheckRow[];
    for (const row of rows) {
      const check = this.parseCheck(row), monitor = this.get(check.projectId, check.monitorId);
      this.finish(monitor, {...check, status: 'interrupted', finishedAt: this.now(),
        errorCode: 'research_monitor_interrupted', sources: [], alertCount: 0});
    }
  }
  schedulable(): ResearchMonitor[] {
    return (this.db.prepare(`SELECT m.id,m.project_id FROM research_monitors m JOIN research_projects p ON p.id=m.project_id
      WHERE p.status!='archived'`).all() as {id: string; project_id: string}[])
      .map(row => this.get(row.project_id, row.id)).filter(value => value.status === 'active');
  }
  suspend(monitor: ResearchMonitor, error: unknown): void {
    const current = this.get(monitor.projectId, monitor.id);
    if (current.revision !== monitor.revision) return;
    this.write(sealMonitor({...current, status: 'paused', revision: current.revision + 1, updatedAt: this.now(),
      lastError: error instanceof Error ? error.message : 'research_monitor_scheduler_failed'}), current.revision);
  }
  acknowledge(input: z.infer<typeof monitorAcknowledgeSchema>): MonitorAlert {
    const request = monitorAcknowledgeSchema.parse(input), actor = requireResearchHuman('research.monitors.acknowledge', request.projectId);
    return this.db.transaction(() => {
      this.get(request.projectId, request.monitorId);
      const row = this.db.prepare('SELECT * FROM research_monitor_alerts WHERE id=? AND project_id=? AND monitor_id=?')
        .get(request.alertId, request.projectId, request.monitorId) as AlertRow | undefined;
      if (row === undefined) throw new Error('research_monitor_alert_not_found');
      const alert = this.parseAlert(row);
      if (alert.acknowledgement !== null) return alert;
      if (this.research.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
      const acknowledgement = {revision: 1, actor, at: this.now()};
      this.db.prepare('UPDATE research_monitor_alerts SET ack_json=? WHERE id=? AND ack_json IS NULL')
        .run(JSON.stringify(acknowledgement), alert.id);
      const saved = this.db.prepare('SELECT * FROM research_monitor_alerts WHERE id=? AND project_id=? AND monitor_id=?')
        .get(alert.id, request.projectId, request.monitorId) as AlertRow;
      return this.parseAlert(saved);
    })();
  }
  list(input: z.infer<typeof monitorListSchema>): {records: ResearchMonitor[]; total: number; nextOffset: number | null} {
    const request = monitorListSchema.parse(input);
    this.research.getProject(request.projectId);
    const total = this.db.prepare('SELECT COUNT(*) FROM research_monitors WHERE project_id=?').pluck().get(request.projectId) as number;
    const ids = this.db.prepare('SELECT id FROM research_monitors WHERE project_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?')
      .all(request.projectId, request.limit, request.offset) as {id: string}[];
    return {records: ids.map(row => this.get(request.projectId, row.id)), total,
      nextOffset: request.offset + ids.length < total ? request.offset + ids.length : null};
  }
  history(input: z.infer<typeof monitorHistorySchema>, kind: 'versions'): {records: MonitorVersion[]; total: number; nextOffset: number | null};
  history(input: z.infer<typeof monitorHistorySchema>, kind: 'checks'): {records: MonitorCheck[]; total: number; nextOffset: number | null};
  history(input: z.infer<typeof monitorHistorySchema>, kind: 'alerts'): {records: MonitorAlert[]; total: number; nextOffset: number | null};
  history(input: z.infer<typeof monitorHistorySchema>, kind: 'versions' | 'checks' | 'alerts'):
    {records: (MonitorVersion | MonitorCheck | MonitorAlert)[]; total: number; nextOffset: number | null} {
    const request = monitorHistorySchema.parse(input);
    this.get(request.projectId, request.monitorId);
    const table = `research_monitor_${kind}`;
    const total = this.db.prepare(`SELECT COUNT(*) FROM ${table} WHERE project_id=? AND monitor_id=?`)
      .pluck().get(request.projectId, request.monitorId) as number;
    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE project_id=? AND monitor_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?`)
      .all(request.projectId, request.monitorId, request.limit, request.offset) as (VersionRow & CheckRow & AlertRow)[];
    const records = rows.map(row => kind === 'versions' ? this.version(request.projectId, request.monitorId, row.version) :
      kind === 'checks' ? this.parseCheck(row) : this.parseAlert(row));
    return {records, total, nextOffset: request.offset + records.length < total ? request.offset + records.length : null};
  }

  private parseCheck(row: CheckRow): MonitorCheck {
    const value = parse(row.snapshot_json, monitorCheckSchema);
    if (value.id !== row.id || value.projectId !== row.project_id || value.monitorId !== row.monitor_id ||
      value.queryVersion !== row.query_version || value.controlRevision !== row.control_revision ||
      value.key !== row.check_key || value.status !== row.status)
      throw new Error('research_monitor_storage_invalid');
    const query = this.version(value.projectId, value.monitorId, value.queryVersion).query;
    const expectedSources = query.kind === 'search' ? query.search.sources : ['openalex', 'crossref'];
    if (new Set(value.sources.map(source => source.source)).size !== value.sources.length ||
      value.sources.some(source => !expectedSources.includes(source.source as typeof expectedSources[number])) ||
      (value.status === 'complete' || value.status === 'partial' || value.status === 'failed' && value.errorCode === null) &&
      value.sources.length !== expectedSources.length) throw new Error('research_monitor_storage_invalid');
    for (const source of value.sources) {
      if (query.kind === 'search') {
        const search = source.search;
        if (search === null || source.executionId !== search.executionId || search.sources.length !== 1 ||
          search.sources[0]!.source !== source.source || source.endpoint !== null ||
          JSON.stringify(source.material) !== JSON.stringify(searchMonitorMaterial(search)))
          throw new Error('research_monitor_storage_invalid');
        const expectedRequest = literatureSearchInputSchema.parse({...query.search,
          sources: [source.source], projectId: value.projectId});
        const execution = this.db.prepare(`SELECT e.owner,e.project_id,e.request_json,e.search_id,e.status,p.pool_json
          FROM research_literature_search_executions e JOIN research_literature_search_pools p ON p.execution_id=e.id
          WHERE e.id=?`).get(search.executionId) as {
            owner: string; project_id: string; request_json: string; search_id: string; status: string; pool_json: string
          } | undefined;
        if (execution === undefined || execution.owner !== `monitor:${value.monitorId}` ||
          execution.project_id !== value.projectId || execution.search_id !== search.searchId || execution.status !== search.status)
          throw new Error('research_monitor_storage_invalid');
        const pool = parse(execution.pool_json, literatureSearchPoolSchema);
        if (!isDeepStrictEqual(JSON.parse(execution.request_json), {request: expectedRequest, strategy: null}) ||
          !isDeepStrictEqual(pool.request, expectedRequest) || pool.executionId !== search.executionId ||
          pool.strategy !== null || search.strategy !== null || pool.status !== search.status ||
          pool.createdAt !== search.createdAt || !isDeepStrictEqual(pool.sources, search.sources) ||
          !isDeepStrictEqual(search.ranking, literatureRanking(expectedRequest.sources)))
          throw new Error('research_monitor_storage_invalid');
        const candidates = fuseLiterature(pool.records).filter(candidate => {
          if (expectedRequest.yearFrom === undefined && expectedRequest.yearTo === undefined) return true;
          const year = candidate.record.publishedYear;
          return year !== null && (expectedRequest.yearFrom === undefined || year >= expectedRequest.yearFrom) &&
            (expectedRequest.yearTo === undefined || year <= expectedRequest.yearTo);
        }).slice(0, expectedRequest.limit);
        if (!isDeepStrictEqual(candidates, search.candidates.map(({matchedLibraryItemId: _item,
          archived: _archived, missingFields: _missing, ...candidate}) => candidate)) ||
          source.status !== (search.status === 'complete' ? 'ok' : search.status === 'partial' ? 'partial' : 'error') ||
          !isDeepStrictEqual(source.requests, search.sources[0]!.requests) ||
          !isDeepStrictEqual(source.governance, search.sources[0]!.governance) ||
          source.errorCode !== search.sources[0]!.errorCode || source.retryAfterMs !== search.sources[0]!.retryAfterMs)
          throw new Error('research_monitor_storage_invalid');
      } else {
        if (source.search !== null || source.executionId !== null || source.endpoint === null ||
          source.source !== 'openalex' && source.source !== 'crossref') throw new Error('research_monitor_storage_invalid');
        const offset = Number(new URL(source.endpoint).searchParams.get('offset') ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0 ||
          source.endpoint !== monitorUpdateEndpoint(source.source, query.doi, offset))
          throw new Error('research_monitor_storage_invalid');
        if (source.status === 'ok') {
          if (source.material === null || source.responseHash === null || source.fetchedAt === null)
            throw new Error('research_monitor_storage_invalid');
          const payload = source.source === 'openalex' ? source.material.records[0] : {message: {
            items: source.material.records, 'total-results': source.material.providerTotal
          }};
          if (JSON.stringify(readMonitorUpdates(source.source, query.doi, offset, payload)) !== JSON.stringify(source.material))
            throw new Error('research_monitor_storage_invalid');
        } else if (source.material !== null) throw new Error('research_monitor_storage_invalid');
      }
    }
    return value;
  }
  private parseAlert(row: AlertRow): MonitorAlert {
    const value = parse(row.snapshot_json, monitorAlertSchema);
    if (value.id !== row.id || value.projectId !== row.project_id || value.monitorId !== row.monitor_id ||
      value.checkId !== row.check_id || value.queryVersion !== row.query_version || value.source !== row.source ||
      value.identity !== row.identity || value.kind !== row.kind || value.acknowledgement !== null)
      throw new Error('research_monitor_storage_invalid');
    const check = this.check(value.projectId, value.monitorId, value.checkId);
    if (check.queryVersion !== value.queryVersion || !check.sources.some(source =>
      source.source === value.source && source.material?.events.some(event =>
        JSON.stringify(event) === JSON.stringify(Object.fromEntries(Object.keys(event).map(key => [key, value[key as keyof MonitorAlert]]))))))
      throw new Error('research_monitor_storage_invalid');
    return row.ack_json === null ? value : monitorAlertSchema.parse({...value, acknowledgement: JSON.parse(row.ack_json)});
  }
  private insertAlert(check: MonitorCheck, source: string, event: MonitorEvent): boolean {
    const exists = this.db.prepare('SELECT * FROM research_monitor_alerts WHERE monitor_id=? AND identity=? AND kind=?')
      .get(check.monitorId, event.identity, event.kind) as AlertRow | undefined;
    if (exists !== undefined) {
      if (exists.check_id === check.id) parse(exists.snapshot_json, monitorAlertSchema);
      else this.parseAlert(exists);
      return false;
    }
    const alert = sealMonitor(monitorAlertSchema.parse({...event, id: `monitoralert_${randomUUID()}`, projectId: check.projectId,
      monitorId: check.monitorId, checkId: check.id, queryVersion: check.queryVersion, source,
      observedAt: check.finishedAt, acknowledgement: null, contentHash: '0'.repeat(64)}));
    this.db.prepare(`INSERT INTO research_monitor_alerts
      (id,project_id,monitor_id,check_id,query_version,source,identity,kind,snapshot_json) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(alert.id, alert.projectId, alert.monitorId, alert.checkId, alert.queryVersion, source, alert.identity, alert.kind, JSON.stringify(alert));
    return true;
  }
  private write(value: ResearchMonitor, expectedRevision: number): void {
    const changed = this.db.prepare(`UPDATE research_monitors SET revision=?,query_version=?,snapshot_json=?
      WHERE id=? AND project_id=? AND revision=?`)
      .run(value.revision, value.queryVersion, JSON.stringify(value), value.id, value.projectId, expectedRevision);
    if (changed.changes !== 1) throw new Error('research_monitor_version_changed');
  }
  private replay(projectId: string, requestId: string, request: unknown): ResearchMonitor | null {
    this.research.getProject(projectId);
    const row = this.db.prepare('SELECT * FROM research_monitor_requests WHERE project_id=? AND request_id=?')
      .get(projectId, requestId) as {monitor_id: string; request_json: string; snapshot_json: string} | undefined;
    if (row === undefined) return null;
    if (row.request_json !== JSON.stringify(request)) throw new Error('research_monitor_request_conflict');
    const value = parse(row.snapshot_json, monitorSchema);
    if (value.projectId !== projectId || value.id !== row.monitor_id) throw new Error('research_monitor_storage_invalid');
    this.version(projectId, value.id, value.queryVersion);
    return value;
  }
  private recordRequest(projectId: string, requestId: string, request: unknown, value: ResearchMonitor): void {
    this.db.prepare('INSERT INTO research_monitor_requests (project_id,monitor_id,request_id,request_json,snapshot_json) VALUES (?,?,?,?,?)')
      .run(projectId, value.id, requestId, JSON.stringify(request), JSON.stringify(value));
  }
}
