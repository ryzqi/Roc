import { Ban, CheckCircle2, CircleOff, LoaderCircle, SkipForward } from 'lucide-react';
import type { ChatTranscriptActivityBlock } from '../../chat-transcript';
import { ActivityBlockBody } from '../activity-block/ActivityBlockBody';
import { ActivityBlockShell } from '../activity-block/ActivityBlockShell';
import { useActivityBlockState } from '../activity-block/use-activity-block-state';

type HookCallBlockModel = Extract<ChatTranscriptActivityBlock, { kind: 'hook_call' }>;

type HookCallBlockProps = {
  block: HookCallBlockModel;
};

const STATUS_LABEL = {
  running: '执行中',
  completed: '完成',
  failed: '失败',
  blocked: '阻止',
  skipped: '跳过'
} satisfies Record<HookCallBlockModel['status'], string>;

const TOOL_STATUS_CLASS = {
  running: 'tool-call-modern--progress',
  completed: 'tool-call-modern--end',
  failed: 'tool-call-modern--error',
  blocked: 'tool-call-modern--error',
  skipped: 'tool-call-modern--start'
} satisfies Record<HookCallBlockModel['status'], string>;

function HookStatusIcon({ status }: { status: HookCallBlockModel['status'] }): React.JSX.Element {
  if (status === 'running') {
    return <LoaderCircle aria-hidden="true" size={12} strokeWidth={2.5} />;
  }
  if (status === 'completed') {
    return <CheckCircle2 aria-hidden="true" size={12} strokeWidth={2.5} />;
  }
  if (status === 'blocked') {
    return <Ban aria-hidden="true" size={12} strokeWidth={2.5} />;
  }
  if (status === 'skipped') {
    return <SkipForward aria-hidden="true" size={12} strokeWidth={2.5} />;
  }
  return <CircleOff aria-hidden="true" size={12} strokeWidth={2.5} />;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return '运行中';
  }
  return `${durationMs}ms`;
}

export function HookCallBlock({ block }: HookCallBlockProps): React.JSX.Element {
  const { open, setOpen } = useActivityBlockState({
    defaultOpen: block.status === 'failed' || block.status === 'blocked'
  });

  return (
    <ActivityBlockShell
      className={`tool-call-modern ${TOOL_STATUS_CLASS[block.status]} hook-call-modern hook-call-modern--${block.status}`}
      dataTestId="chat-activity-hook"
      open={open}
      onToggle={setOpen}
      header={
        <summary className="tool-call-modern__header">
          <div className="tool-call-modern__icon">
            <HookStatusIcon status={block.status} />
          </div>
          <span className="tool-call-modern__name">{`Hook · ${block.event}`}</span>
          <div className="tool-call-modern__badge">{STATUS_LABEL[block.status]}</div>
          <svg className="tool-call-modern__expand" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </summary>
      }
    >
      <ActivityBlockBody className="tool-call-modern__body hook-call-modern__body">
        <dl className="hook-call-modern__meta">
          <div>
            <dt>command</dt>
            <dd>{block.commandDisplay}</dd>
          </div>
          <div>
            <dt>handler</dt>
            <dd>{block.handlerId}</dd>
          </div>
          <div>
            <dt>duration</dt>
            <dd>{formatDuration(block.durationMs)}</dd>
          </div>
          {block.message === null ? null : (
            <div>
              <dt>message</dt>
              <dd>{block.message}</dd>
            </div>
          )}
        </dl>
      </ActivityBlockBody>
    </ActivityBlockShell>
  );
}
