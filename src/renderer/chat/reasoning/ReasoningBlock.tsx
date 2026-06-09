import { useActivityBlockState } from '../activity-block/use-activity-block-state';
import { ReasoningTimeline } from './ReasoningTimeline';

interface ReasoningBlockProps {
  id: string;
  content: string;
  isStreaming: boolean;
}

export function ReasoningBlock({ id, content, isStreaming }: ReasoningBlockProps): React.JSX.Element {
  const { open, setOpen } = useActivityBlockState({
    defaultOpen: isStreaming,
    forceOpenWhileStreaming: true,
    isStreaming,
    autoCloseDelayMs: 1000
  });

  return (
    <details
      className="chat-bubble-reasoning"
      data-activity-id={id}
      data-testid="chat-activity-reasoning"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{isStreaming ? '思考中' : '已思考'}</span>
      </summary>
      <div className="reasoning-body">
        <ReasoningTimeline content={content} />
      </div>
    </details>
  );
}
