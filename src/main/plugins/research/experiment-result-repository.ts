import type {Database} from 'better-sqlite3';
import {researchExperimentResultReceiptSchema,researchExperimentResultSnapshotSchema,
  researchExperimentResultGetSchema,researchExperimentResultListSchema,
  type ResearchExperimentResultReceipt,type ResearchExperimentResultGet,type ResearchExperimentResultList} from '../../../shared/schemas/research-experiment-results';
import {researchContentHash} from './research-files';
import type {ResearchRepository} from './repository';

type Row={id:string;project_id:string;run_id:string;request_id:string;snapshot_json:string;snapshot_hash:string;created_at:string};
export class ResearchExperimentResultRepository {
  constructor(private readonly db:Database,private readonly repository:ResearchRepository) {}
  existing(projectId:string,requestId:string):ResearchExperimentResultReceipt|null {
    this.repository.getProject(projectId);
    const row=this.db.prepare('SELECT * FROM research_experiment_results WHERE project_id=? AND request_id=?')
      .get(projectId,requestId) as Row|undefined;
    return row===undefined?null:this.read(row);
  }
  save(value:ResearchExperimentResultReceipt):ResearchExperimentResultReceipt {
    const receipt=researchExperimentResultReceiptSchema.parse(value),snapshot=receipt.snapshot;
    this.repository.getProject(snapshot.request.projectId);
    const json=JSON.stringify(snapshot);
    if(researchContentHash(json)!==receipt.snapshotHash)throw new Error('research_result_snapshot_invalid');
    this.db.prepare(`INSERT INTO research_experiment_results
      (id,project_id,run_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(snapshot.id,snapshot.request.projectId,snapshot.request.runId,snapshot.request.requestId,json,receipt.snapshotHash,snapshot.recordedAt);
    return this.get({projectId:snapshot.request.projectId,resultId:snapshot.id,expectedHash:receipt.snapshotHash});
  }
  get(value:ResearchExperimentResultGet):ResearchExperimentResultReceipt {
    const request=researchExperimentResultGetSchema.parse(value);
    this.repository.getProject(request.projectId);
    const row=this.db.prepare('SELECT * FROM research_experiment_results WHERE id=?').get(request.resultId) as Row|undefined;
    if(row===undefined)throw new Error('research_result_not_found');
    if(row.project_id!==request.projectId)throw new Error('research_result_project_mismatch');
    const result=this.read(row);
    if(result.snapshotHash!==request.expectedHash)throw new Error('research_result_hash_mismatch');
    return result;
  }
  list(value:ResearchExperimentResultList):{items:ResearchExperimentResultReceipt[];total:number} {
    const request=researchExperimentResultListSchema.parse(value);
    this.repository.experiments.get(request.projectId,request.runId);
    const rows=this.db.prepare('SELECT * FROM research_experiment_results WHERE project_id=? AND run_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?')
      .all(request.projectId,request.runId,request.limit,request.offset) as Row[];
    const total=this.db.prepare('SELECT count(*) FROM research_experiment_results WHERE project_id=? AND run_id=?')
      .pluck().get(request.projectId,request.runId) as number;
    return {items:rows.map(row=>this.read(row)),total};
  }
  private read(row:Row):ResearchExperimentResultReceipt {
    const snapshot=researchExperimentResultSnapshotSchema.parse(JSON.parse(row.snapshot_json));
    if(JSON.stringify(snapshot)!==row.snapshot_json||researchContentHash(row.snapshot_json)!==row.snapshot_hash||
      snapshot.id!==row.id||snapshot.request.projectId!==row.project_id||snapshot.request.runId!==row.run_id||
      snapshot.execution.runId!==row.run_id||snapshot.execution.inputHash!==snapshot.request.expectedInputHash||
      snapshot.execution.output.path!==snapshot.request.resultPath||snapshot.execution.output.sha256!==snapshot.request.expectedResultHash||
      snapshot.recordedAt!==row.created_at||snapshot.request.requestId!==row.request_id)throw new Error('research_result_snapshot_invalid');
    return {snapshot,snapshotHash:row.snapshot_hash};
  }
}
