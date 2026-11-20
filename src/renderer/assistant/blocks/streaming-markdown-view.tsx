import { memo } from 'react';
import { Streamdown } from 'streamdown';
import { markdownComponents } from './markdown-components';
import { MarkdownView } from './markdown-view';

/**
 * Streaming Markdown (T4.4), ported from `chat/streaming-markdown-view.tsx`.
 *
 * While a run is producing tokens, `Streamdown` renders incomplete Markdown without
 * flickering between half-parsed states; once the block settles it hands over to
 * `MarkdownView`, which is also used for history. The compatibility gate records
 * parser and scroll-anchor differences, so keep this split until they are resolved.
 *
 * The streaming renderer remains behind the transcript's lazy boundary. See
 * `tests/renderer/markdown-renderers.test.mjs` before changing the settled parser.
 */
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
