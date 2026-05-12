import { useState, type ReactElement, type ReactNode } from 'react';

type CodeBlockProps = {
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
  const match = className.match(/language-([\w+-]+)/);
  return match === null ? null : match[1];
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
    node !== null &&
    typeof node === 'object' &&
    'type' in node &&
    (node as { type?: unknown }).type === 'code'
  );
}

export function CodeBlock({ children, className }: CodeBlockProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const codeChild = Array.isArray(children) ? children.find(isCodeElement) : isCodeElement(children) ? children : null;
  const codeClassName = codeChild?.props.className;
  const language = extractLanguage(codeClassName);
  const codeText = extractText(codeChild?.props.children ?? children);

  async function handleCopy(): Promise<void> {
    if (codeText.length === 0) {
      return;
    }
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="code-card" data-language={language ?? 'text'}>
      <div className="code-card-head">
        <span className="code-card-lang">{language ?? 'text'}</span>
        <button
          type="button"
          className={copied ? 'code-card-copy is-copied' : 'code-card-copy'}
          onClick={() => void handleCopy()}
          aria-label={copied ? '已复制' : '复制代码'}
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className={className}>{children}</pre>
    </div>
  );
}
