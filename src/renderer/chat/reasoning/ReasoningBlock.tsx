import { Copy } from 'lucide-react';
import { useMemo } from 'react';
import { ActivityBlockBody } from '../activity-block/ActivityBlockBody';
import { ActivityBlockHeader } from '../activity-block/ActivityBlockHeader';
import { ActivityBlockShell } from '../activity-block/ActivityBlockShell';
import { useActivityBlockState } from '../activity-block/use-activity-block-state';
import { useCopyContent } from '../activity-block/use-copy-content';
import { parseReasoningContent } from './reasoning-parser';
import { ReasoningTimeline } from './ReasoningTimeline';

type ReasoningBlockProps = {
  id: string;
  content: string;
  isStreaming: boolean;
};

export function ReasoningBlock({ content, isStreaming }: ReasoningBlockProps): React.JSX.Element {
  const steps = useMemo(() => parseReasoningContent(content), [content]);
  const { open, setOpen } = useActivityBlockState({
    defaultOpen: isStreaming,
    forceOpenWhileStreaming: true,
    isStreaming
  });
  const { copied, copy } = useCopyContent(() => content);

  return (
    <ActivityBlockShell
      className="chat-bubble-reasoning"
      dataTestId="chat-activity-reasoning"
      open={open}
      onToggle={setOpen}
      header={
        <ActivityBlockHeader
          actions={
            <button
              aria-label={copied ? '已复制推理内容' : '复制推理内容'}
              className="reasoning-action-btn"
              onClick={(event) => {
                event.preventDefault();
                copy();
              }}
              title="复制推理内容"
              type="button"
            >
              <Copy aria-hidden="true" size={14} />
            </button>
          }
          actionsClassName="reasoning-actions"
          className="reasoning-summary"
          status={isStreaming ? '思考中' : undefined}
          statusClassName="reasoning-status"
          title={`推理 · ${steps.length} 步`}
          titleClassName="reasoning-label"
        />
      }
    >
      <ActivityBlockBody className="reasoning-body">
        <ReasoningTimeline steps={steps} />
      </ActivityBlockBody>
    </ActivityBlockShell>
  );
}
