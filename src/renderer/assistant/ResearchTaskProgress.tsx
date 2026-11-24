import { useTaskDiagnostics } from '../research/tasks/use-task-diagnostics';
import { TaskSummary, TaskUsage } from '../research/tasks/TaskSummary';
import { TaskControls } from '../research/tasks/TaskControls';
import {ActionButton} from '../shared/form-ui';
import {ActionStatus} from '../shared/action-status';
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
      {resource.status === 'loading' ? <ActionStatus state="pending" testId="assistant-task-feedback" className="text-subtle">
        {data === null ? '正在读取科研任务…' : '正在更新任务进度…'}
      </ActionStatus> : null}
      {resource.status === 'error' ? (
        <div className="grid justify-items-start gap-1">
          <ActionStatus state="error" testId="assistant-task-feedback" className="text-[var(--st-bad)]">{resource.error}</ActionStatus>
          <ActionButton variant="compact" onClick={resource.reload}>重试读取任务</ActionButton>
        </div>
      ) : null}
      {data === null ? null : (
        <>
          <TaskSummary data={data} onOpenArtifact={onOpenArtifact} surface="assistant" />
          {resource.status === 'error' ? null :
            <TaskControls key={data.task.id} client={client} data={data} onChanged={resource.reload} surface="assistant" />}
          <ActionButton variant="compact" className="justify-self-start"
            data-testid="assistant-task-details" onClick={() => {recordUxEvent('action_initiated', 'assistant'); onOpenTask(data.task.id);}}>查看任务详情</ActionButton>
          <details className="task-usage-disclosure"><summary>用量与调用</summary><TaskUsage usage={data.usage} /></details>
        </>
      )}
    </section>
  );
}
