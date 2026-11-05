import { CheckCircle2, CirclePlay, LoaderCircle, XCircle } from 'lucide-react';
import type { ChatTranscriptActivityBlock } from '../transcript';
import { ActivityBlockBody, ActivityBlockShell, type ActivityTone } from './activity-shell';
import { useActivityBlockState } from './use-activity-block-state';
import {ReviewLinkActions} from './review-link-actions';

/**
 * Data expands on demand and failures open their payload. Successful review results
 * carry explicit receipt links; navigation never derives an identity from the tool name.
 */
type ToolCallBlockModel = Extract<ChatTranscriptActivityBlock, { kind: 'tool_call' }>;

const TOOL_STATE: Record<
  ToolCallBlockModel['status'],
  { label: string; tone: ActivityTone; Icon: typeof CirclePlay }
> = {
  start: { label: '开始', tone: 'start', Icon: CirclePlay },
  progress: { label: '执行中', tone: 'progress', Icon: LoaderCircle },
  end: { label: '成功', tone: 'end', Icon: CheckCircle2 },
  error: { label: '错误', tone: 'error', Icon: XCircle }
};

export type ToolCallBlockProps = {
  block: ToolCallBlockModel;
};

export function ToolCallBlock({ block }: ToolCallBlockProps): React.JSX.Element {
  const hasInput = block.input !== null && block.input !== undefined;
  const hasOutput = block.output !== null && block.output !== undefined;
  const hasError = block.error !== null && block.error !== undefined;
  const hasData = hasInput || hasOutput || hasError;
  const { open, setOpen } = useActivityBlockState({ defaultOpen: block.status === 'error' });
  const state = TOOL_STATE[block.status];

  return <div className="flex min-w-0 flex-col gap-1.5">
    <ActivityBlockShell
      testId="assistant-activity-tool"
      icon={state.Icon}
      title={block.name}
      statusLabel={state.label}
      tone={state.tone}
      visualDensity={block.status === 'end' ? 'quiet' : 'standard'}
      open={hasData && open}
      onToggle={setOpen}
      expandable={hasData}
    >
      {hasData ? (
        <ActivityBlockBody testId="assistant-tool-body">
          {hasInput ? <ToolDataSection label="输入" data={block.input} /> : null}
          {hasOutput ? <ToolDataSection label="输出" data={block.output} /> : null}
          {hasError ? <ToolDataSection label="错误" data={block.error} variant="error" /> : null}
        </ActivityBlockBody>
      ) : null}
    </ActivityBlockShell>
    {block.status === 'end' ? <ReviewLinkActions output={block.output} /> : null}
  </div>;
}

export function ToolDataSection({
  label,
  data,
  variant = 'default'
}: {
  label: string;
  data: unknown;
  variant?: 'default' | 'error';
}): React.JSX.Element {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  return (
    <div className="mb-1.5 last:mb-0" data-testid={`assistant-tool-data-${label}`}>
      <div className="mb-1 text-subtle text-[var(--font-meta-size)]">{label}</div>
      <pre
        className={
          variant === 'error'
            ? 'max-h-[320px] overflow-auto whitespace-pre-wrap rounded-control border border-line bg-[var(--tool-st-error-bg)] p-2 font-mono text-[var(--tool-st-error-text)] text-[var(--font-code-size)]'
            : 'max-h-[320px] overflow-auto whitespace-pre-wrap rounded-control border border-line bg-code-surface p-2 font-mono text-[var(--code-text)] text-[var(--font-code-size)]'
        }
      >
        {text}
      </pre>
    </div>
  );
}
