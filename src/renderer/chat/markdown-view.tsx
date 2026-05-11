import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

export const MarkdownView = memo(
  function MarkdownView({ text }: { text: string }): React.JSX.Element {
    return (
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
        {text}
      </Markdown>
    );
  },
  (prev, next) => prev.text === next.text
);
