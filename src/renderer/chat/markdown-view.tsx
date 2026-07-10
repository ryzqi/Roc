import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './code-block';
import { MarkdownLink } from './markdown-link';

const remarkPlugins = [remarkGfm];
const markdownComponents = { a: MarkdownLink, pre: CodeBlock };

export const MarkdownView = memo(
  function MarkdownView({ text }: { text: string }): React.JSX.Element {
    return (
      <Markdown remarkPlugins={remarkPlugins} components={markdownComponents}>
        {text}
      </Markdown>
    );
  },
  (prev, next) => prev.text === next.text
);
