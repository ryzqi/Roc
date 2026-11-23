import type {Database} from 'better-sqlite3';
import {RocDomainError} from '../../services/errors';

/** Project ownership stays in the research database, including for workspace terminals. */
export class ResearchProjectWorkspaceContract {
  constructor(private readonly researchDb: Database) {}

  requireWritableWorkspace(projectId: string, workspacePath: string): void {
    const project = this.researchDb.prepare(
      'SELECT workspace_path, status FROM research_projects WHERE id = ?'
    ).get(projectId) as {workspace_path: string | null; status: string} | undefined;
    if (project === undefined || project.workspace_path !== workspacePath || project.status === 'archived') {
      throw new RocDomainError({code: 'terminal_project_workspace_mismatch',
        message: '项目已归档或工作目录已变更，无法连接此终端。', category: 'permission', retryable: false});
    }
  }
}
