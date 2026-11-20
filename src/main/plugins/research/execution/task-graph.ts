import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {researchTaskGraphSchema, researchTaskNodeSchema, type ResearchNodeLease, type ResearchTaskNode} from '../../../../shared/schemas/research-task-graph';
import type {ResearchTaskExecution, ResearchTask} from '../../../../shared/schemas/research-tasks';
import type {FrozenExecutionInputs} from '../../../../shared/schemas/execution';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Request/attempt identities are audit data; the logical operation follows frozen content. */
export function nodeInputHash(inputs: FrozenExecutionInputs): string {
  return digest({manifestHash: inputs.manifestHash, policyHash: inputs.policyHash,
    versions: inputs.versions.map(version => ({...version, id: version.kind === 'context' ? 'context' : version.id}))});
}
type NodeRow = {id: string; task_id: string; project_id: string; execution_id: string; status: string; snapshot_json: string};
type Owner = {get(taskId: string, projectId: string): ResearchTask;
  hasUnresolvedEffects(taskId: string, projectId: string): boolean;
  requireExecution(kind: 'stage', executionId: string, projectId: string): ResearchTaskExecution};

/** Shares the Task database and lifecycle owner. All mutations commit before worker dispatch. */
export class ResearchTaskGraphRepository {
  constructor(private readonly db: Database, private readonly owner: Owner,
    private readonly now = () => new Date().toISOString()) {}

  get(id: string, projectId: string): ResearchTaskNode {
    const row = this.db.prepare('SELECT * FROM research_task_nodes WHERE id=?').get(id) as NodeRow | undefined;
    if (row === undefined) throw new Error('research_node_not_found');
    const node = researchTaskNodeSchema.parse(JSON.parse(row.snapshot_json));
    if (node.id !== row.id || node.taskId !== row.task_id || node.projectId !== row.project_id ||
      node.executionId !== row.execution_id || node.status !== row.status) throw new Error('research_node_identity_corrupt');
    if (node.projectId !== projectId) throw new Error('research_task_project_mismatch');
    this.owner.get(node.taskId, projectId);
    return node;
  }

  read(taskId: string, projectId: string) {
    this.owner.get(taskId, projectId);
    const revision = this.revision(taskId);
    const nodes = (this.db.prepare('SELECT id FROM research_task_nodes WHERE task_id=? ORDER BY rowid').all(taskId) as {id: string}[])
      .map(row => this.get(row.id, projectId));
    const edges = this.db.prepare('SELECT prerequisite,dependent FROM research_task_dependencies WHERE task_id=? ORDER BY rowid').all(taskId);
    return researchTaskGraphSchema.parse({revision, nodes, edges});
  }

  register(execution: ResearchTaskExecution, input: {stage: string; role: string; readonly: boolean; retryNodeId: string | null}): ResearchTaskNode {
    return this.db.transaction(() => {
      this.requireRoot(execution.taskId, execution.projectId);
      if (execution.frozenInputs === null) throw new Error('research_execution_inputs_required');
      const inputHash = nodeInputHash(execution.frozenInputs);
      if (input.retryNodeId !== null) {
        const node = this.get(input.retryNodeId, execution.projectId);
        if (node.taskId !== execution.taskId || node.inputHash !== inputHash || node.stage !== input.stage || node.role !== input.role) {
          throw new Error('research_node_inputs_changed');
        }
        if (!['failed', 'cancelled', 'interrupted'].includes(node.status) || node.lease !== null) throw new Error('research_node_not_retryable');
        // An explicit retry is a new node revision, retaining logical operation identity.
        // A review retry replaces its panel; upstream accepted inputs remain prerequisites.
        for (const edge of this.read(node.taskId, node.projectId).edges.filter(edge => edge.dependent === node.id)) {
          const predecessor = this.get(edge.prerequisite, node.projectId);
          const prior = this.owner.requireExecution('stage', predecessor.executionId, node.projectId);
          if (prior.parentExecutionId === node.executionId && prior.associationSource === 'review') {
            this.db.prepare('DELETE FROM research_task_dependencies WHERE prerequisite=? AND dependent=?').run(predecessor.id, node.id);
          }
        }
        this.bumpRevision(node.taskId, this.revision(node.taskId));
        const next: ResearchTaskNode = {...node, revision: node.revision + 1, executionId: execution.executionId,
          status: 'pending', reason: null, output: null, updatedAt: this.now()};
        this.save(next);
        return next;
      }
      const revision = this.bumpRevision(execution.taskId, this.revision(execution.taskId));
      const id = `research_node_${randomUUID()}`;
      const node = researchTaskNodeSchema.parse({schemaVersion: 1, id,
        taskId: execution.taskId, projectId: execution.projectId, executionId: execution.executionId,
        stage: input.stage, role: input.role, readonly: input.readonly, graphRevision: revision, revision: 1,
        inputHash, operationKey: digest({projectId: execution.projectId, taskId: execution.taskId, nodeId: id, inputHash}),
        status: 'pending', reason: null, attempt: 0, generation: 0, outputRevision: 0,
        lease: null, output: null, createdAt: this.now(), updatedAt: this.now()});
      this.db.prepare('INSERT INTO research_task_nodes(id,task_id,project_id,execution_id,status,snapshot_json) VALUES(?,?,?,?,?,?)')
        .run(node.id, node.taskId, node.projectId, node.executionId, node.status, JSON.stringify(node));
      const inputs = new Set(execution.frozenInputs.versions.filter(version => version.kind === 'artifact').map(version => version.id));
      for (const prior of this.read(node.taskId, node.projectId).nodes) {
        if (prior.id !== node.id && prior.output?.artifactIds.some(id => inputs.has(id))) {
          this.db.prepare('INSERT INTO research_task_dependencies(task_id,prerequisite,dependent) VALUES(?,?,?)')
            .run(node.taskId, prior.id, node.id);
        }
      }
      return node;
    }).immediate();
  }

  addDependencies(taskId: string, projectId: string, expectedRevision: number, edges: Array<{prerequisite: string; dependent: string}>): number {
    return this.db.transaction(() => {
      this.requireRoot(taskId, projectId);
      const revision = this.bumpRevision(taskId, expectedRevision);
      for (const edge of edges) {
        const from = this.get(edge.prerequisite, projectId), to = this.get(edge.dependent, projectId);
        if (from.taskId !== taskId || to.taskId !== taskId) throw new Error('research_node_root_mismatch');
        if (from.id === to.id) throw new Error('research_graph_cycle');
        if (to.status !== 'pending' || to.lease !== null) throw new Error('research_graph_inputs_frozen');
        this.db.prepare('INSERT INTO research_task_dependencies(task_id,prerequisite,dependent) VALUES(?,?,?)').run(taskId, from.id, to.id);
      }
      const cycle = this.db.prepare(`WITH RECURSIVE reachable(a,b) AS (
        SELECT prerequisite,dependent FROM research_task_dependencies WHERE task_id=?
        UNION SELECT r.a,e.dependent FROM reachable r JOIN research_task_dependencies e ON e.prerequisite=r.b WHERE e.task_id=?
      ) SELECT 1 FROM reachable WHERE a=b LIMIT 1`).get(taskId, taskId);
      if (cycle !== undefined) throw new Error('research_graph_cycle');
      return revision;
    }).immediate();
  }

  candidates(): ResearchTaskNode[] {
    return (this.db.prepare("SELECT n.id,n.project_id FROM research_task_nodes n JOIN research_tasks t ON t.id=n.task_id WHERE n.status IN ('pending','ready') AND t.status='active' ORDER BY n.rowid")
      .all() as {id: string; project_id: string}[]).map(row => this.get(row.id, row.project_id));
  }

  claim(input: {nodeId: string; projectId: string; workerId: string; expectedRevision: number; ttlMs: number; concurrency: number}): ResearchNodeLease | null {
    if (!Number.isInteger(input.ttlMs) || input.ttlMs < 100 || input.ttlMs > 300_000 ||
      ![1,2].includes(input.concurrency) || !input.workerId.trim()) throw new Error('research_node_claim_invalid');
    return this.db.transaction(() => {
      const node = this.get(input.nodeId, input.projectId);
      this.requireRoot(node.taskId, node.projectId);
      if (node.revision !== input.expectedRevision) throw new Error('research_node_revision_conflict');
      if (!['pending', 'ready'].includes(node.status)) return null;
      const execution = this.owner.requireExecution('stage', node.executionId, node.projectId);
      this.assertBinding(node, execution);
      const prerequisites = this.db.prepare('SELECT prerequisite FROM research_task_dependencies WHERE dependent=?')
        .all(node.id) as {prerequisite: string}[];
      const blockers = prerequisites.map(edge => this.get(edge.prerequisite, node.projectId)).filter(dependency => dependency.status !== 'done');
      if (blockers.length) {
        this.save({...node, reason: 'research_node_dependency_pending'});
        return null;
      }
      // Fencing a lease precedes physical cleanup. Keep the project closed until
      // its owner confirms all resources stopped, including failed cleanup.
      const cleanup = this.db.prepare(`SELECT id FROM research_tasks WHERE project_id=?
        AND json_extract(snapshot_json,'$.statusReason') IN ('research_task_cleanup_pending','research_task_cleanup_failed') LIMIT 1`)
        .get(node.projectId);
      if (cleanup !== undefined) {
        this.save({...node, reason: 'research_task_cleanup_pending'});
        return null;
      }
      const running = this.db.prepare("SELECT snapshot_json FROM research_task_nodes WHERE status='running'").all() as {snapshot_json: string}[];
      // Expired workers retain their slot until cleanup/reconciliation confirms release.
      if (running.length >= input.concurrency) {
        this.save({...node, reason: 'research_node_capacity_pending'});
        return null;
      }
      if (!node.readonly && running.some(row => {
        const active = researchTaskNodeSchema.parse(JSON.parse(row.snapshot_json));
        return active.projectId === node.projectId && !active.readonly;
      })) {
        this.save({...node, reason: 'research_node_writer_pending'});
        return null;
      }
      const generation = node.generation + 1;
      const lease: ResearchNodeLease = {nodeId: node.id, taskId: node.taskId, projectId: node.projectId,
        executionId: node.executionId, workerId: input.workerId, revision: node.revision, generation, inputHash: node.inputHash,
        expiresAt: new Date(Date.parse(this.now()) + input.ttlMs).toISOString()};
      this.save({...node, status: 'running', reason: null, generation, lease, attempt: node.attempt + 1});
      this.event(node, 'node_claimed', String(generation));
      return lease;
    }).immediate();
  }

  assertLease(lease: ResearchNodeLease): ResearchTaskNode {
    const node = this.get(lease.nodeId, lease.projectId);
    this.requireRoot(node.taskId, node.projectId);
    if (node.status !== 'running' || node.lease === null || node.lease.workerId !== lease.workerId ||
      node.generation !== lease.generation || node.revision !== lease.revision || node.executionId !== lease.executionId ||
      node.taskId !== lease.taskId || node.inputHash !== lease.inputHash || Date.parse(node.lease.expiresAt) <= Date.parse(this.now())) {
      throw new Error('research_node_lease_stale');
    }
    this.assertBinding(node, this.owner.requireExecution('stage', node.executionId, node.projectId));
    return node;
  }

  heartbeat(lease: ResearchNodeLease, ttlMs: number): void {
    if (!Number.isInteger(ttlMs) || ttlMs < 100 || ttlMs > 300_000) throw new Error('research_node_claim_invalid');
    this.db.transaction(() => {
      const node = this.assertLease(lease);
      this.save({...node, lease: {...node.lease!, expiresAt: new Date(Date.parse(this.now()) + ttlMs).toISOString()}});
    }).immediate();
  }

  finish(lease: ResearchNodeLease, output: NonNullable<ResearchTaskNode['output']>, review: boolean): void {
    this.db.transaction(() => {
      const node = this.assertLease(lease);
      if (output.revision !== node.outputRevision + 1) throw new Error('research_node_output_revision_conflict');
      this.save({...node, status: review ? 'pending_review' : 'done', reason: review ? 'research_node_review_pending' : null,
        lease: null, output, outputRevision: output.revision});
      this.event(node, 'node_output', output.hash);
    }).immediate();
  }

  /** A research-DB receipt proves the write committed while the agent DB fence was held. */
  reconcileOutput(lease: ResearchNodeLease, output: NonNullable<ResearchTaskNode['output']>, review: boolean): void {
    this.db.transaction(() => {
      const node = this.get(lease.nodeId, lease.projectId);
      if (node.executionId !== lease.executionId || node.revision !== lease.revision || node.generation !== lease.generation ||
        node.inputHash !== lease.inputHash || node.taskId !== lease.taskId) throw new Error('research_node_receipt_conflict');
      this.assertBinding(node, this.owner.requireExecution('stage', node.executionId, node.projectId));
      if (node.output !== null) {
        if (JSON.stringify(node.output) !== JSON.stringify(output)) throw new Error('research_node_receipt_conflict');
        return;
      }
      if (node.status !== 'running' || node.lease?.workerId !== lease.workerId || output.revision !== node.outputRevision + 1) {
        throw new Error('research_node_receipt_conflict');
      }
      const task = this.owner.get(node.taskId, node.projectId);
      const permitted = ['active','waiting_approval'].includes(task.status);
      this.save({...node, lease: null, output, outputRevision: output.revision,
        status: permitted ? review ? 'pending_review' : 'done' : 'blocked',
        reason: permitted ? review ? 'research_node_review_pending' : null : 'research_task_not_active'});
      this.event(node, 'node_output', output.hash);
    }).immediate();
  }

  commitDecisions<T>(decisions: Array<{nodeId: string; projectId: string; hash: string; revision: number; accepted: boolean}>, write: () => T): T {
    return this.db.transaction(() => {
      for (const decision of decisions) this.assertDecision(decision);
      const result = write();
      if (result instanceof Promise) throw new Error('research_node_async_commit_forbidden');
      for (const decision of decisions) this.accept(decision.nodeId, decision.projectId, decision, decision.accepted);
      return result;
    }).immediate();
  }

  private assertDecision(decision: {nodeId: string; projectId: string; hash: string; revision: number; accepted: boolean}): ResearchTaskNode {
    const node = this.get(decision.nodeId, decision.projectId);
    const task = this.owner.get(node.taskId, decision.projectId);
    // A fresh human decision can review saved output after input revalidation failed.
    // Keep the failed task fenced: this accepts no worker lease and never resumes it.
    const savedOutputReview = task.status === 'failed' && task.statusReason === 'research_stage_inputs_stale';
    if (!['active','waiting_approval'].includes(task.status) && !savedOutputReview) throw new Error('research_task_not_active');
    if (savedOutputReview && this.owner.hasUnresolvedEffects(task.id, task.projectId)) throw new Error('research_task_effect_unresolved');
    const repeatedRejection = !decision.accepted && node.status === 'blocked' && node.reason === 'research_node_human_rejected';
    if ((!repeatedRejection && node.status !== 'pending_review') || node.output?.hash !== decision.hash || node.output.revision !== decision.revision) {
      throw new Error('research_node_output_changed');
    }
    return node;
  }

  reconcileDecision(decision: {nodeId: string; projectId: string; hash: string; revision: number; accepted: boolean}): void {
    this.db.transaction(() => {
      const node = this.get(decision.nodeId, decision.projectId);
      if (node.output?.hash !== decision.hash || node.output.revision !== decision.revision) throw new Error('research_node_output_changed');
      if (node.status === (decision.accepted ? 'done' : 'blocked')) return;
      if (node.status !== 'pending_review') throw new Error('research_node_output_changed');
      this.save({...node, status: decision.accepted ? 'done' : 'blocked', reason: decision.accepted ? null : 'research_node_human_rejected'});
      this.event(node, 'node_accepted', decision.accepted ? decision.hash : 'rejected');
    }).immediate();
  }

  commit<T>(lease: ResearchNodeLease, write: () => T): T {
    return this.db.transaction(() => {
      this.assertLease(lease);
      const result = write();
      if (result instanceof Promise) throw new Error('research_node_async_commit_forbidden');
      return result;
    }).immediate();
  }

  accept(nodeId: string, projectId: string, output: {hash: string; revision: number}, accepted: boolean): void {
    this.db.transaction(() => {
      const node = this.assertDecision({nodeId, projectId, ...output, accepted});
      if (!accepted && node.status === 'blocked') return;
      this.save({...node, status: accepted ? 'done' : 'blocked', reason: accepted ? null : 'research_node_human_rejected'});
      this.event(node, 'node_accepted', accepted ? output.hash : 'rejected');
    }).immediate();
  }

  stopExecution(executionId: string, projectId: string, status: 'failed'|'cancelled'|'interrupted', reason: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT id FROM research_task_nodes WHERE execution_id=? AND project_id=?').get(executionId, projectId) as {id: string}|undefined;
      if (row === undefined) return;
      const node = this.get(row.id, projectId);
      if (!['pending','ready','running'].includes(node.status)) return;
      this.save({...node, status, reason, lease: null});
    }).immediate();
  }

  expire(lease: ResearchNodeLease, cleanupConfirmed: boolean, effectsResolved: boolean): void {
    this.db.transaction(() => {
      const node = this.get(lease.nodeId, lease.projectId);
      if (node.lease?.generation !== lease.generation || node.lease.workerId !== lease.workerId ||
        Date.parse(node.lease.expiresAt) > Date.parse(this.now())) throw new Error('research_node_lease_not_expired');
      if (!cleanupConfirmed) throw new Error('research_task_cleanup_unconfirmed');
      // No automatic replay of a possible write: explicit continue/reconciliation owns that decision.
      this.save({...node, status: node.readonly && effectsResolved ? 'interrupted' : 'blocked',
        reason: effectsResolved ? 'research_node_lease_expired' : 'research_task_effect_unresolved', lease: null});
      this.event(node, 'lease_expired', String(lease.generation));
    }).immediate();
  }

  private assertBinding(node: ResearchTaskNode, execution: ResearchTaskExecution): void {
    if (execution.associationState !== 'confirmed' || execution.frozenInputs === null || execution.nodeBinding.kind !== 'dag' ||
      execution.nodeBinding.nodeId !== node.id || execution.nodeBinding.graphRevision !== node.graphRevision ||
      nodeInputHash(execution.frozenInputs) !== node.inputHash) throw new Error('research_node_binding_invalid');
  }
  private requireRoot(taskId: string, projectId: string): void {
    if (this.owner.get(taskId, projectId).status !== 'active') throw new Error('research_task_not_active');
  }
  private revision(taskId: string): number {
    return (this.db.prepare('SELECT revision FROM research_task_graphs WHERE task_id=?').get(taskId) as {revision: number}|undefined)?.revision ?? 0;
  }
  private bumpRevision(taskId: string, expected: number): number {
    this.db.prepare('INSERT OR IGNORE INTO research_task_graphs(task_id,revision) VALUES(?,0)').run(taskId);
    if (this.db.prepare('UPDATE research_task_graphs SET revision=revision+1 WHERE task_id=? AND revision=?').run(taskId, expected).changes !== 1) {
      throw new Error('research_graph_revision_conflict');
    }
    return expected + 1;
  }
  private save(node: ResearchTaskNode): void {
    const value = researchTaskNodeSchema.parse({...node, updatedAt: this.now()});
    this.db.prepare('UPDATE research_task_nodes SET execution_id=?,status=?,snapshot_json=? WHERE id=?')
      .run(value.executionId, value.status, JSON.stringify(value), value.id);
  }
  private event(node: ResearchTaskNode, type: string, reason: string): void {
    this.db.prepare('INSERT INTO research_task_events(task_id,event_type,execution_kind,execution_id,state,reason,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(node.taskId,type,'stage',node.executionId,node.id,reason,this.now());
  }
}
