import {memo, useMemo} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import katex from 'katex';
import {MarkdownLink} from '../assistant/blocks/markdown-link';
import 'katex/dist/katex.min.css';
import './scientific-markdown.css';

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins: NonNullable<React.ComponentProps<typeof Markdown>['rehypePlugins']> = [
  [rehypeKatex, {trust: false, strict: 'ignore', maxExpand: 1000}]
];
const components = {
  a: MarkdownLink,
  // Reading a note must not fetch arbitrary remote tracking images.
  img: ({alt}: {alt?: string}) => <span className="text-muted">{alt || '图片'}</span>
};

/** Safe, shared scientific prose. Raw HTML stays inert; math retains its source on error. */
const ScientificMarkdown = memo(function ScientificMarkdown({text, className = ''}: {
  text: string;
  className?: string;
}): React.JSX.Element {
  return <div className={`roc-prose scientific-markdown ${className}`}>
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} skipHtml>
      {text}
    </Markdown>
  </div>;
});

export default ScientificMarkdown;

/** Formula drafts update before insertion; incomplete input is recoverable. */
export function FormulaPreview({text, displayMode = false}: {text: string; displayMode?: boolean}): React.JSX.Element {
  const rendered = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return {html: katex.renderToString(text, {
        displayMode, trust: false, strict: 'ignore', throwOnError: true, maxExpand: 1000
      }), error: false};
    } catch {
      return {html: null, error: true};
    }
  }, [text, displayMode]);
  return <div className="reading-formula-preview" data-testid="notes-formula-preview" aria-label="公式实时预览">
    {rendered === null ? <span className="text-muted">输入 LaTeX 后预览</span> : rendered.error ?
      <span className="text-muted">公式尚未完整，继续输入即可更新预览。</span> :
      <div dangerouslySetInnerHTML={{__html: rendered.html!}}/>}
  </div>;
}
