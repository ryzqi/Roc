import { useTaskDiagnostics } from '../research/tasks/use-task-diagnostics';
import { TaskSummary, TaskUsage } from '../research/tasks/TaskSummary';
import { TaskControls } from '../research/tasks/TaskControls';
import { formSecondaryButtonClass } from '../shared/form-ui';
import type { RocClient } from '../shared/roc-client';
import type {OpenResearchArtifact} from '../artifacts/artifact-interactions';
import {recordUxEvent} from '../app/ux-metrics';

export function ResearchTaskProgress({ client, projectId, threadId, runId, runStatus, onOpenTask, onOpenArtifact }: {
  client: RocClient; projectId: string; threadId: string; runId: string; runStatus: string;
  onOpenTask: (taskId: string) => void;
  onOpenArtifact?: OpenResearchArtifact | undefined;
}): React.JSX.Element | null {
  const resource = useTaskDiagnostics(client, { projectId, threadId, runId }, runStatus);
  const data = resource.data;
  if (resource.status === 'ready' && data === null) return null;
  return (
    <section className="grid min-w-0 gap-2 border-t-[0.5px] border-line pt-2 text-[length:var(--font-meta-size)]"
      data-testid="assistant-task" aria-label="科研任务" aria-busy={resource.status === 'loading'}>
      {resource.status === 'error' ? (
        <div>
          <p role="alert" className="break-words text-[var(--st-bad)]">{resource.error}</p>
          <button type="button" className={formSecondaryButtonClass} onClick={resource.reload}>重试读取任务</button>
        </div>
      ) : data === null ? (
        resource.status === 'loading' ? <p role="status" className="text-subtle">读取任务中…</p> : null
      ) : (
        <>
          <TaskSummary data={data} onOpenArtifact={onOpenArtifact} surface="assistant" />
          <TaskControls key={data.task.id} client={client} data={data} onChanged={resource.reload} surface="assistant" />
          <button type="button" className={`${formSecondaryButtonClass} justify-self-start`}
            data-testid="assistant-task-details" onClick={() => {recordUxEvent('action_initiated', 'assistant'); onOpenTask(data.task.id);}}>查看任务详情</button>
          <details className="task-usage-disclosure"><summary>用量与调用</summary><TaskUsage usage={data.usage} /></details>
        </>
      )}
    </section>
  );
}
