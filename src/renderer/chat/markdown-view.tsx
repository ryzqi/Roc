import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './code-block';
import { MarkdownImage } from './markdown-image';
import { MarkdownLink } from './markdown-link';

const remarkPlugins = [remarkGfm];
const markdownComponents = { a: MarkdownLink, img: MarkdownImage, pre: CodeBlock };

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
