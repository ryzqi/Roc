import {taskFactsSaveSchema, taskFactsViewSchema, taskFactsHistoryRequestSchema, type TaskFactSource,
  type TaskFactsSave, type TaskFactsView} from '../../../shared/schemas/research-task-facts';
import {researchTaskRequestSchema} from '../../../shared/schemas/research-tasks';
import type {ResearchRepository} from './repository';
import {requireResearchHuman} from '../../services/research-human-context';

export class ResearchTaskFactsService {
  constructor(private readonly research: ResearchRepository, private readonly now = () => new Date().toISOString()) {}
  forChat(request: {projectId: string; threadId: string; runId: string}) {
    const task = this.research.tasks.taskForChatScope(request);
    return task === null ? null : {task, facts: this.get({projectId: task.projectId, taskId: task.id})};
  }
  get(input: {taskId: string; projectId: string}): TaskFactsView {
    const request = researchTaskRequestSchema.parse(input);
    this.research.tasks.get(request.taskId, request.projectId);
    const snapshot = this.research.tasks.facts.current(request.taskId);
    if (snapshot !== null && snapshot.projectId !== request.projectId) throw new Error('research_task_facts_scope_corrupt');
    const freshness = snapshot?.entries.flatMap(entry => entry.sources.map((source, sourceIndex) => {
      const reason = this.expired(source, request);
      return {entryId: entry.id, sourceIndex, state: reason === null ? 'current' as const : 'expired' as const, reason};
    })) ?? [];
    return taskFactsViewSchema.parse({snapshot, freshness, authority: 'research_data_only'});
  }
  save(input: TaskFactsSave) {
    const request = taskFactsSaveSchema.parse(input);
    const savedBy = requireResearchHuman('research.task.facts.save', request.projectId);
    this.research.tasks.get(request.taskId, request.projectId);
    for (const entry of request.entries) {
      for (const source of entry.sources) {
        const reason = this.expired(source, request);
        if (reason !== null && entry.state === 'active') throw new Error(`research_task_facts_source_expired:${reason}`);
      }
    }
    return this.research.tasks.facts.save({contractVersion: 1, taskId: request.taskId, projectId: request.projectId,
      revision: request.expectedRevision + 1, entries: request.entries, savedBy, createdAt: this.now()}, request.expectedRevision);
  }
  history(input: {taskId: string; projectId: string; beforeRevision: number | null; limit: number}) {
    const request = taskFactsHistoryRequestSchema.parse(input);
    this.research.tasks.get(request.taskId, request.projectId);
    return this.research.tasks.facts.history(request.taskId, request.beforeRevision, request.limit);
  }
  private expired(source: TaskFactSource, scope: {taskId: string; projectId: string}): string | null {
    try {
      switch (source.kind) {
        case 'user': return null;
        case 'artifact': {
          const current = this.research.inspectArtifact({projectId: scope.projectId, artifactId: source.artifactId, expectedVersion: null});
          return current.snapshot.version === source.version ? null : 'artifact_version_changed';
        }
        case 'document': {
          const document = this.research.documents.get(source.documentId);
          if (!this.research.library.get(document.libraryItemId).projectIds.includes(scope.projectId)) return 'document_unlinked';
          return document.sourceHash !== source.sourceHash ? 'document_source_changed'
            : document.currentParseId !== source.parseId ? 'document_parse_changed' : null;
        }
        case 'execution': {
          const execution = this.research.tasks.findExecution(source.executionKind, source.executionId, scope.projectId);
          if (execution === null) return 'execution_unlinked';
          if (execution.taskId !== scope.taskId) throw new Error('research_task_facts_execution_mismatch');
          return execution.manifestHash === source.manifestHash ? null : 'execution_manifest_changed';
        }
      }
    } catch (error) {
      // Deleted references are a real expiry state. Corruption and scope errors still propagate.
      if (error instanceof Error && (error.message.startsWith('research_artifact_not_found:')
        || ['research_document_not_found', 'research_library_item_not_found'].includes(error.message))) return 'source_missing';
      throw error;
    }
  }
}
