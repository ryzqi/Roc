import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { useCopyFeedback } from '../../shared/hooks/use-copy-feedback';
import { highlightCodeTokens, type CodeToken } from '../syntax-highlight';

/**
 * Fenced code block (T4.4), ported from the legacy `chat/code-block.tsx`.
 *
 * Two deliberate differences from the legacy version:
 *
 *   1. **No `dangerouslySetInnerHTML`.** The legacy block injected highlight.js's
 *      `.value` string. The highlighter is a trust boundary on a surface that renders
 *      model output, so this renders Lowlight's validated AST as `CodeToken[]` and
 *      real `<span>` elements. Unexpected AST shapes fall back to plain source text.
 *   2. Legacy CSS classes → Tailwind + semantic tokens; the legacy shell's
 *      `useCopyFeedback` (`markCopied`) → the new shell's (`copy`).
 *
 * `extractText` pulls the raw source out of the React children `react-markdown` hands
 * over (including the nested `<code>` element), so the copy button copies source rather
 * than highlighted markup.
 */

export type CodeBlockProps = {
  children?: ReactNode;
  className?: string;
};

type CodeChildProps = {
  className?: string;
  children?: ReactNode;
};

function extractLanguage(className: string | undefined): string | null {
  if (typeof className !== 'string' || className.length === 0) {
    return null;
  }
  const match = className.match(/language-([\w+-]+)/u);
  const language = match?.[1];
  return language === undefined || language.length === 0 ? null : language;
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string') {
    return node;
  }
  if (typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => extractText(child)).join('');
  }
  if (node !== null && typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    if (props === undefined) {
      return '';
    }
    return extractText(props.children);
  }
  return '';
}

function isCodeElement(node: ReactNode): node is ReactElement<CodeChildProps> {
  return (
    node !== null && typeof node === 'object' && 'type' in node && (node as { type?: unknown }).type === 'code'
  );
}

function HighlightedCode({ tokens }: { tokens: readonly CodeToken[] }): React.JSX.Element {
  return (
    <code>
      {tokens.map((token, index) =>
        token.classes.length === 0 ? (
          // Plain runs are their own text node; `key` on a string needs the fragment form.
          <span key={index}>{token.text}</span>
        ) : (
          <span key={index} className={token.classes.join(' ')}>
            {token.text}
          </span>
        )
      )}
    </code>
  );
}

export function CodeBlock({ children, className }: CodeBlockProps): React.JSX.Element {
  const copy = useCopyFeedback();
  const codeChild = Array.isArray(children) ? children.find(isCodeElement) : isCodeElement(children) ? children : null;
  const language = extractLanguage(codeChild?.props.className);
  const codeText = extractText(codeChild?.props.children ?? children);
  const [tokens, setTokens] = useState<readonly CodeToken[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTokens(null);
    void highlightCodeTokens(language, codeText).then((next) => {
      if (!cancelled) {
        setTokens(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [codeText, language]);

  return (
    <div
      className="roc-code my-2 overflow-hidden rounded-card border border-line bg-code-surface"
      data-language={language ?? 'text'}
      data-testid="assistant-code-block"
    >
      <div className="flex items-center gap-2 border-b border-line-soft bg-code-header-bg px-2 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--code-header-text)] text-[var(--font-micro-size)]">
          {language ?? 'text'}
        </span>
        <button
          type="button"
          onClick={() => copy.copy(codeText)}
          disabled={codeText.length === 0}
          aria-label={copy.copied ? '已复制' : '复制代码'}
          data-testid="assistant-code-copy"
          className="flex h-6 items-center gap-1 rounded-control px-1.5 text-[var(--code-header-text)] hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-40"
        >
          {copy.copied ? (
            <Check size={11} aria-hidden="true" className="text-[var(--st-ok)]" />
          ) : (
            <Copy size={11} aria-hidden="true" />
          )}
          <span className="text-[var(--font-micro-size)]">{copy.copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre
        className={[
          'overflow-x-auto p-2 font-mono text-[var(--font-code-size)] text-[var(--code-text)]',
          className ?? ''
        ].join(' ')}
      >
        {tokens === null ? <code>{codeText}</code> : <HighlightedCode tokens={tokens} />}
      </pre>
    </div>
  );
}
