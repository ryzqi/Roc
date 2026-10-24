import { ClipboardCheck, RotateCw } from 'lucide-react';
import { useState } from 'react';
import type { ChatTranscriptActivityBlock } from '../transcript';
import { ActivityBlockShell, type ActivityTone } from './activity-shell';
import { useActivityBlockState } from './use-activity-block-state';

type TaskAcceptanceBlockModel = Extract<ChatTranscriptActivityBlock, { kind: 'task_acceptance' }>;

const STATUS_LABEL = {
  satisfied: '已满足',
  partial: '部分完成',
  blocked: '等待处理',
  unverified: '待验证',
  stale: '证据已变化'
} as const;

const VERDICT_LABEL = { passed: '通过', failed: '未通过', unverified: '待验证' } as const;

function acceptanceTone(status: TaskAcceptanceBlockModel['report']['status']): ActivityTone {
  if (status === 'satisfied') return 'end';
  if (status === 'blocked' || status === 'stale') return 'error';
  return 'progress';
}

export function TaskAcceptanceBlock({ block, onResumeCheckpoint }: {
  block: TaskAcceptanceBlockModel;
  onResumeCheckpoint?: (runId: string) => Promise<boolean>;
}): React.JSX.Element {
  const { open, setOpen } = useActivityBlockState({ defaultOpen: false });
  const [resumeBusy, setResumeBusy] = useState(false);
  const passed = block.report.criteria.filter((criterion) => criterion.verdict === 'passed').length;
  const resume = async (): Promise<void> => {
    if (onResumeCheckpoint === undefined || resumeBusy) return;
    setResumeBusy(true);
    try { await onResumeCheckpoint(block.report.runId); }
    finally { setResumeBusy(false); }
  };
  return (
    <ActivityBlockShell
      testId="assistant-activity-task-acceptance"
      icon={ClipboardCheck}
      title="任务验收"
      statusLabel={STATUS_LABEL[block.report.status]}
      meta={`${passed}/${block.report.criteria.length} 项通过`}
      tone={acceptanceTone(block.report.status)}
      open={open}
      onToggle={setOpen}
    >
      <div className="border-t border-line-soft px-3 py-2.5 text-[var(--font-body-size)] text-muted">
        <ul className="space-y-2">
          {block.report.criteria.map((criterion) => (
            <li className="min-w-0" key={criterion.id}>
              <div className="flex items-start gap-2">
                <span className="shrink-0 rounded-control bg-[var(--overlay-hover)] px-1.5 py-0.5 text-[var(--font-micro-size)]">
                  {VERDICT_LABEL[criterion.verdict]}
                </span>
                <span className="min-w-0 whitespace-pre-wrap">{criterion.description}</span>
              </div>
              <p className="mt-1 pl-1 text-subtle text-[var(--font-micro-size)]">{criterion.detail}</p>
              {criterion.artifactRefs.length === 0 ? null : (
                <ul className="mt-1 space-y-0.5 pl-1 text-subtle text-[var(--font-micro-size)]">
                  {criterion.artifactRefs.map((ref) => <li className="break-all" key={`${ref.path}:${ref.sha256}`}>证据：{ref.path}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
        {block.report.remainingItems.length === 0 ? null : (
          <section className="mt-3" aria-label="尚未完成">
            <h4 className="font-medium text-ink">尚未完成</h4>
            <ul className="mt-1 list-inside list-disc space-y-1">
              {block.report.remainingItems.map((item) => <li className="whitespace-pre-wrap" key={item}>{item}</li>)}
            </ul>
          </section>
        )}
        {block.report.blockedBy.length === 0 ? null : (
          <section className="mt-3" aria-label="等待原因">
            <h4 className="font-medium text-ink">等待原因</h4>
            <ul className="mt-1 list-inside list-disc space-y-1">
              {block.report.blockedBy.map((item) => <li className="whitespace-pre-wrap" key={item}>{item}</li>)}
            </ul>
          </section>
        )}
        <p className="mt-3 whitespace-pre-wrap text-ink">下一步：{block.report.nextSafeAction}</p>
        {block.report.checkpointResumeAvailable && onResumeCheckpoint !== undefined ? (
          <button type="button" data-testid="assistant-task-resume-checkpoint" aria-busy={resumeBusy} disabled={resumeBusy}
            onClick={() => void resume()}
            className="mt-2 inline-flex min-h-8 items-center gap-1.5 rounded-control border border-line-strong px-2.5 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-wait disabled:opacity-60">
            <RotateCw size={12} aria-hidden="true" />
            {resumeBusy ? '正在恢复…' : '从检查点继续'}
          </button>
        ) : null}
      </div>
    </ActivityBlockShell>
  );
}
