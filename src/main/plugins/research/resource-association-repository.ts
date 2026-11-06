import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {z} from 'zod';
import {
  resourceAssociationSaveSchema, resourceAssociationSchema, resourceAssociationReadSchema,
  resourceAssociationHistorySchema, resourceTargetsSchema, resourceTargetSchema,
  type ResourceAssociation, type ResourceAssociationSave, type ResourceAssociationResult, type ResourceTarget,
  type resourceAssociationHistoryResultSchema, type resourceTargetsResultSchema
} from '../../../shared/schemas/research-resource-associations';
import {requireResearchHuman} from '../../services/research-human-context';
import type {ResearchRepository} from './repository';
import {ResearchResourceRepository, resourceContentHash} from './resource-repository';

type Row = {id: string; project_id: string; request_id: string; resource_id: string;
  target_kind: ResourceTarget['kind']; target_id: string; snapshot_json: string};
export class ResearchResourceAssociationRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository,
    private readonly resources: ResearchResourceRepository, private readonly now: () => string = () => new Date().toISOString()) {}

  save(input: ResourceAssociationSave): ResourceAssociationResult {
    const request = resourceAssociationSaveSchema.parse(input);
    const actor = requireResearchHuman('research.resourceAssociations.save', request.projectId);
    return this.db.transaction(() => {
      this.research.getProject(request.projectId);
      const old = this.db.prepare('SELECT * FROM research_resource_associations WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as Row | undefined;
      if (old !== undefined) {
        const association = this.parse(old);
        if (JSON.stringify(association.request) !== JSON.stringify(request)) throw new Error('research_resource_association_request_conflict');
        return this.result(association);
      }
      this.resources.requireCaptureScope(request.projectId);
      const resource = this.requireResource(request);
      const target = this.requireTarget(request.projectId, request.target);
      const association = resourceAssociationSchema.parse({
        id: `resource_link_${randomUUID()}`, projectId: request.projectId, request,
        verification: 'user_declared_context', actor, resourceTitle: resource.metadata.titles[0].title,
        targetTitle: target.title, createdAt: this.now(), contentHash: '0'.repeat(64)
      });
      const {contentHash: _hash, ...body} = association;
      association.contentHash = resourceContentHash(body);
      this.db.prepare(`INSERT INTO research_resource_associations
        (id,project_id,request_id,resource_id,target_kind,target_id,snapshot_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(association.id, request.projectId, request.requestId, request.resourceId, request.target.kind,
          this.targetId(request.target), JSON.stringify(association), association.createdAt);
      this.resources.requireCaptureScope(request.projectId);
      this.requireResource(request);
      this.requireTarget(request.projectId, request.target);
      return this.result(association);
    })();
  }

  read(input: z.infer<typeof resourceAssociationReadSchema>): ResourceAssociationResult {
    const request = resourceAssociationReadSchema.parse(input);
    this.research.getProject(request.projectId);
    const row = this.db.prepare('SELECT * FROM research_resource_associations WHERE id=? AND project_id=?')
      .get(request.associationId, request.projectId) as Row | undefined;
    if (row === undefined) throw new Error('research_resource_association_not_found');
    return this.result(this.parse(row));
  }

  history(input: z.infer<typeof resourceAssociationHistorySchema>): z.infer<typeof resourceAssociationHistoryResultSchema> {
    const request = resourceAssociationHistorySchema.parse(input);
    this.research.getProject(request.projectId);
    const where = ['project_id=?'], args: string[] = [request.projectId];
    if (request.resourceId !== null) {where.push('resource_id=?'); args.push(request.resourceId);}
    if (request.target !== null) {where.push('target_kind=? AND target_id=?'); args.push(request.target.kind, request.target.id);}
    const clause = where.join(' AND ');
    const total = this.db.prepare(`SELECT COUNT(*) FROM research_resource_associations WHERE ${clause}`).pluck().get(...args) as number;
    const records = (this.db.prepare(`SELECT * FROM research_resource_associations WHERE ${clause}
      ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(...args, request.limit, request.offset) as Row[])
      .map(row => this.result(this.parse(row)));
    return {records, total, nextOffset: request.offset + records.length < total ? request.offset + records.length : null};
  }

  targets(input: z.infer<typeof resourceTargetsSchema>): z.infer<typeof resourceTargetsResultSchema> {
    const request = resourceTargetsSchema.parse(input);
    this.research.getProject(request.projectId);
    const query = request.kind === 'literature' ?
      `SELECT l.id FROM research_library l JOIN research_library_projects p ON p.item_id=l.id
        WHERE p.project_id=? AND l.archived=0` :
      `SELECT run_id AS id FROM research_experiment_executions WHERE project_id=? AND status='completed'`;
    const total = this.db.prepare(`SELECT COUNT(*) FROM (${query})`).pluck().get(request.projectId) as number;
    const rows = this.db.prepare(`${query} ORDER BY id LIMIT ? OFFSET ?`)
      .all(request.projectId, request.limit, request.offset) as Array<{id: string}>;
    const records = rows.map(row => this.target(request.projectId, request.kind, row.id));
    return {records, total, nextOffset: request.offset + records.length < total ? request.offset + records.length : null};
  }

  private target(projectId: string, kind: ResourceTarget['kind'], id: string): {target: ResourceTarget; title: string} {
    if (kind === 'literature') {
      const item = this.research.library.get(id);
      if (item.archived || !item.projectIds.includes(projectId)) throw new Error('research_resource_target_unavailable');
      return {title: item.metadata.title, target: resourceTargetSchema.parse({
        kind, itemId: item.id, expectedRevision: item.revision, expectedDoi: item.metadata.doi,
        expectedMetadataHash: resourceContentHash({id: item.id, revision: item.revision, metadata: item.metadata, bibliography: item.bibliography})
      })};
    }
    const run = this.research.experiments.get(projectId, id);
    if (run.status !== 'completed' || run.inputHash === null || run.environment === null ||
      run.exitCode !== 0 || run.error !== null || run.endedAt === null) throw new Error('research_resource_target_unavailable');
    return {title: run.request.label, target: resourceTargetSchema.parse({
      kind, runId: run.id, expectedInputHash: run.inputHash,
      expectedEnvironmentHash: run.environment.hash, expectedExecutionHash: resourceContentHash(run)
    })};
  }

  private requireTarget(projectId: string, target: ResourceTarget): {target: ResourceTarget; title: string} {
    const current = this.target(projectId, target.kind, this.targetId(target));
    if (JSON.stringify(current.target) !== JSON.stringify(target)) throw new Error('research_resource_target_changed');
    return current;
  }
  private requireResource(request: ResourceAssociationSave) {
    const resource = this.resources.get(request.projectId, request.resourceId);
    if (resource.status !== 'ok' || resource.contentHash !== request.resourceHash) throw new Error('research_resource_association_source_invalid');
    return resource;
  }
  private targetId(target: ResourceTarget): string {return target.kind === 'literature' ? target.itemId : target.runId;}
  private result(association: ResourceAssociation): ResourceAssociationResult {
    this.requireResource(association.request);
    const {projectId, target} = association.request;
    const id = this.targetId(target);
    const present = target.kind === 'literature' ?
      this.db.prepare(`SELECT 1 FROM research_library l JOIN research_library_projects p ON p.item_id=l.id
        WHERE l.id=? AND p.project_id=? AND l.archived=0`).get(id, projectId) :
      this.db.prepare("SELECT 1 FROM research_experiment_executions WHERE run_id=? AND project_id=? AND status='completed'").get(id, projectId);
    if (present === undefined) return {association, currentState: 'target_unavailable'};
    const current = this.target(projectId, target.kind, id);
    return {association, currentState: JSON.stringify(current.target) === JSON.stringify(target) ? 'current' : 'target_changed'};
  }
  private parse(row: Row): ResourceAssociation {
    const association = resourceAssociationSchema.parse(JSON.parse(row.snapshot_json));
    const {contentHash, ...body} = association;
    const {request} = association;
    if (resourceContentHash(body) !== contentHash || association.id !== row.id || association.projectId !== row.project_id ||
      request.projectId !== association.projectId || request.requestId !== row.request_id || request.resourceId !== row.resource_id ||
      request.target.kind !== row.target_kind || this.targetId(request.target) !== row.target_id) {
      throw new Error('research_resource_association_snapshot_invalid');
    }
    return association;
  }
}
