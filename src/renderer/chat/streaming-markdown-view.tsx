import { memo } from 'react';
import { Streamdown } from 'streamdown';
import { CodeBlock } from './code-block';
import { MarkdownView } from './markdown-view';

const markdownComponents = { pre: CodeBlock };

type StreamingMarkdownViewProps = {
  text: string;
  isStreaming: boolean;
};

export const StreamingMarkdownView = memo(
  function StreamingMarkdownView({ text, isStreaming }: StreamingMarkdownViewProps): React.JSX.Element {
    if (!isStreaming) {
      return <MarkdownView text={text} />;
    }

    return (
      <div data-testid="streaming-markdown">
        <Streamdown animated components={markdownComponents} isAnimating={isStreaming}>
          {text}
        </Streamdown>
      </div>
    );
  },
  (prev, next) => prev.text === next.text && prev.isStreaming === next.isStreaming
);
