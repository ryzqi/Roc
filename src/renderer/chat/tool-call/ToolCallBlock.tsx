import { CheckCircle2, CirclePlay, LoaderCircle, XCircle } from 'lucide-react';
import type { ChatTranscriptActivityBlock } from '../../chat-transcript';
import { ActivityBlockBody } from '../activity-block/ActivityBlockBody';
import { ActivityBlockShell } from '../activity-block/ActivityBlockShell';
import { useActivityBlockState } from '../activity-block/use-activity-block-state';
import { ToolDataSection } from './ToolDataSection';

type ToolCallBlockModel = Extract<ChatTranscriptActivityBlock, { kind: 'tool_call' }>;

type ToolCallBlockProps = {
  block: ToolCallBlockModel;
};

const STATUS_LABEL = {
  start: '开始',
  progress: '执行中',
  end: '成功',
  error: '错误'
} satisfies Record<ToolCallBlockModel['status'], string>;

function ToolStatusIcon({ status }: { status: ToolCallBlockModel['status'] }): React.JSX.Element {
  if (status === 'start') {
    return <CirclePlay aria-hidden="true" size={12} strokeWidth={2.5} />;
  }
  if (status === 'progress') {
    return <LoaderCircle aria-hidden="true" size={12} strokeWidth={2.5} />;
  }
  if (status === 'end') {
    return <CheckCircle2 aria-hidden="true" size={12} strokeWidth={2.5} />;
  }
  return <XCircle aria-hidden="true" size={12} strokeWidth={2.5} />;
}

export function ToolCallBlock({ block }: ToolCallBlockProps): React.JSX.Element {
  const hasInput = block.input !== null && block.input !== undefined;
  const hasOutput = block.output !== null && block.output !== undefined;
  const hasError = block.error !== null && block.error !== undefined;
  const hasData = hasInput || hasOutput || hasError;
  const { open, setOpen } = useActivityBlockState({
    defaultOpen: block.status === 'error'
  });

  return (
    <ActivityBlockShell
      className={`tool-call-modern tool-call-modern--${block.status}`}
      dataTestId="chat-activity-tool"
      open={hasData && open}
      onToggle={setOpen}
      header={
        <summary className="tool-call-modern__header">
          <div className="tool-call-modern__icon">
            <ToolStatusIcon status={block.status} />
          </div>
          <span className="tool-call-modern__name">{block.name}</span>
          <div className="tool-call-modern__badge">{STATUS_LABEL[block.status]}</div>
          {hasData ? (
            <svg className="tool-call-modern__expand" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          ) : null}
        </summary>
      }
    >
      {hasData ? (
        <ActivityBlockBody className="tool-call-modern__body">
          {hasInput ? <ToolDataSection label="输入" data={block.input} /> : null}
          {hasOutput ? <ToolDataSection label="输出" data={block.output} /> : null}
          {hasError ? <ToolDataSection label="错误" data={block.error} variant="error" /> : null}
        </ActivityBlockBody>
      ) : null}
    </ActivityBlockShell>
  );
}
