import { Brain } from 'lucide-react';
import { ActivityBlockShell } from './activity-shell';
import { useActivityBlockState } from './use-activity-block-state';

/**
 * Reasoning block (T4.4), ported from `chat/reasoning/ReasoningBlock.tsx`.
 *
 * The state hook is kept verbatim because its behaviour is deliberate: reasoning
 * **opens itself while the model is thinking** (otherwise the panel looks dead during
 * the slowest part of a run) and closes itself a second after the block settles, so a
 * finished answer is not buried under paragraphs of scratch work.
 *
 * The body renders paragraphs from `\n\n` splits instead of Markdown: reasoning is
 * plain prose from the model, and running it through the Markdown pipeline would make
 * a fast-changing stream re-parse on every token for no visual gain.
 */
export type ReasoningBlockProps = {
  id: string;
  content: string;
  isStreaming: boolean;
};

export function ReasoningBlock({ id, content, isStreaming }: ReasoningBlockProps): React.JSX.Element {
  const { open, setOpen } = useActivityBlockState({
    defaultOpen: isStreaming,
    forceOpenWhileStreaming: true,
    isStreaming,
    autoCloseDelayMs: 1000
  });

  return (
    <ActivityBlockShell
      testId="assistant-activity-reasoning"
      icon={Brain}
      title={id.length === 0 ? '推理' : `推理 ${id}`}
      statusLabel={isStreaming ? '思考中' : '已思考'}
      tone={isStreaming ? 'progress' : 'neutral'}
      open={open}
      onToggle={setOpen}
    >
      <div className="border-t border-line-soft px-2 py-1.5" data-testid="assistant-reasoning-body">
        <ReasoningTimeline content={content} />
      </div>
    </ActivityBlockShell>
  );
}

export function ReasoningTimeline({ content }: { content: string }): React.JSX.Element {
  const paragraphs = content
    .split('\n\n')
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  return (
    <div className="flex flex-col gap-1.5 text-muted text-[var(--font-meta-size)]">
      {paragraphs.map((paragraph, index) => (
        <p key={`${index}-${paragraph.slice(0, 16)}`} className="whitespace-pre-wrap">
          {paragraph}
        </p>
      ))}
    </div>
  );
}
