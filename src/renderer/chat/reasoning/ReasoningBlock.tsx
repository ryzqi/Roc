import { ActivityBlockBody } from '../activity-block/ActivityBlockBody';
import { ActivityBlockHeader } from '../activity-block/ActivityBlockHeader';
import { ActivityBlockShell } from '../activity-block/ActivityBlockShell';
import { useActivityBlockState } from '../activity-block/use-activity-block-state';
import { ReasoningTimeline } from './ReasoningTimeline';

type ReasoningBlockProps = {
  id: string;
  content: string;
  isStreaming: boolean;
};

export function ReasoningBlock({ content, isStreaming }: ReasoningBlockProps): React.JSX.Element {
  const { open, setOpen } = useActivityBlockState({
    defaultOpen: isStreaming,
    forceOpenWhileStreaming: true,
    isStreaming,
    autoCloseDelayMs: 1000
  });

  return (
    <ActivityBlockShell
      className="chat-bubble-reasoning"
      dataTestId="chat-activity-reasoning"
      open={open}
      onToggle={setOpen}
      header={
        <ActivityBlockHeader
          className="reasoning-header"
          status={isStreaming ? '思考中' : '已完成'}
          statusClassName="reasoning-status"
          title="推理"
          titleClassName="reasoning-label"
        />
      }
    >
      <ActivityBlockBody className="reasoning-body">
        <ReasoningTimeline content={content} />
      </ActivityBlockBody>
    </ActivityBlockShell>
  );
}
