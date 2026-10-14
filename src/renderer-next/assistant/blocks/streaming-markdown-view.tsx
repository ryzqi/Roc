import { memo } from 'react';
import { Streamdown } from 'streamdown';
import { CodeBlock } from './code-block';
import { MarkdownImage } from './markdown-image';
import { MarkdownLink } from './markdown-link';
import { MarkdownView } from './markdown-view';

/**
 * Streaming Markdown (T4.4), ported from `chat/streaming-markdown-view.tsx`.
 *
 * While a run is producing tokens, `Streamdown` renders incomplete Markdown without
 * flickering between half-parsed states; once the block settles it hands over to
 * `MarkdownView`, which is the same renderer used for history. That split is kept
 * as-is — it is the reason a streaming answer does not jump on completion.
 *
 * Both Markdown renderers are lazily loaded by the transcript, so `streamdown` and
 * `react-markdown` stay out of the eager graph (the P3 eager-package guard enforces
 * it; they are on its deny-list).
 */
const markdownComponents = { a: MarkdownLink, img: MarkdownImage, pre: CodeBlock };

export type StreamingMarkdownViewProps = {
  text: string;
  isStreaming: boolean;
};

export const StreamingMarkdownView = memo(
  function StreamingMarkdownView({ text, isStreaming }: StreamingMarkdownViewProps): React.JSX.Element {
    if (!isStreaming) {
      return <MarkdownView text={text} />;
    }

    return (
      <div className="roc-prose" data-testid="assistant-streaming-markdown">
        <Streamdown animated={false} components={markdownComponents} isAnimating={isStreaming}>
          {text}
        </Streamdown>
      </div>
    );
  },
  (prev, next) => prev.text === next.text && prev.isStreaming === next.isStreaming
);
