import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './code-block';
import { MarkdownImage } from './markdown-image';
import { MarkdownLink } from './markdown-link';

/**
 * Settled Markdown (T4.4), ported from `chat/markdown-view.tsx`.
 *
 * `react-markdown` + `remark-gfm` render plain HTML elements, which are styled by the
 * `.roc-prose` scope in `styles/index.css` — token-driven, so both themes work without
 * a second stylesheet and without a prose plugin dependency the repo does not have.
 *
 * `memo` with a `text` comparison is kept: the transcript re-renders on every event of
 * a run, and settled messages must not re-parse their Markdown each time (R8).
 */
const remarkPlugins = [remarkGfm];
const markdownComponents = { a: MarkdownLink, img: MarkdownImage, pre: CodeBlock };

export const MarkdownView = memo(
  function MarkdownView({ text }: { text: string }): React.JSX.Element {
    return (
      <div className="roc-prose" data-testid="assistant-markdown">
        <Markdown remarkPlugins={remarkPlugins} components={markdownComponents}>
          {text}
        </Markdown>
      </div>
    );
  },
  (prev, next) => prev.text === next.text
);
