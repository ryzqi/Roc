import { useEffect } from 'react';
import type { ResearchTaskDiagnostics } from '../../../shared/schemas/research-task-diagnostics';
import { useAsyncResource, type AsyncResource } from '../../app/use-async-resource';
import type { RocClient } from '../../shared/roc-client';

type TaskScope = { projectId: string; taskId: string } | { projectId: string; threadId: string; runId: string };

export function useTaskDiagnostics(
  client: RocClient, scope: TaskScope | null, revision = ''
): AsyncResource<ResearchTaskDiagnostics | null> {
  const projectId = scope?.projectId ?? null;
  const taskId = scope !== null && 'taskId' in scope ? scope.taskId : null;
  const threadId = scope !== null && 'threadId' in scope ? scope.threadId : null;
  const runId = scope !== null && 'runId' in scope ? scope.runId : null;
  const resource = useAsyncResource<ResearchTaskDiagnostics | null>(
    scope === null ? null : JSON.stringify(['task-diagnostics', projectId, taskId, threadId, runId, revision]),
    async () => {
      if (scope === null) throw new Error('research_task_scope_required');
      const result = 'taskId' in scope ? await client.api.research.getTaskDiagnostics(scope)
        : await client.api.research.getTaskForChat(scope);
      if (result.ok && result.data !== null) {
        const data = result.data;
        if (data.task.projectId !== scope.projectId ||
          data.executions.some(execution => execution.association.taskId !== data.task.id ||
            execution.association.projectId !== scope.projectId) ||
          ('taskId' in scope ? data.task.id !== scope.taskId :
            !data.executions.some(execution => execution.association.kind === 'chat' &&
              execution.association.executionId === scope.runId))) {
          throw new Error('research_task_diagnostics_identity_mismatch');
        }
      }
      return result;
    },
    { label: '读取科研任务' }
  );
  const resolvedTaskId = resource.data?.task.id ?? taskId;
  const { reload } = resource;
  // Subscribe before subsequent asynchronous responses. Unknown task identity still
  // rereads this chat scope so its first trusted stage association cannot be missed.
  useEffect(() => {
    if (projectId === null) return;
    return client.api.research.onTaskUpdated(event => {
      if (event.projectId === projectId && (resolvedTaskId === null || event.taskId === resolvedTaskId)) reload();
    });
  }, [client, projectId, resolvedTaskId, reload]);
  return resource;
}
