import React, { useMemo } from 'react';
import katex from 'katex';

interface MathViewProps {
  math: string;
  inline?: boolean;
  displayMode?: boolean;
  className?: string;
}

export const MathView: React.FC<MathViewProps> = ({ math, inline = false, displayMode, className = '' }) => {
  const isDisplay = displayMode !== undefined ? displayMode : !inline;
  const renderedHtml = useMemo(() => {
    try {
      return katex.renderToString(math, {
        displayMode: isDisplay,
        throwOnError: false,
        strict: false
      });
    } catch {
      return `<code class="text-rose-400 font-mono text-xs">${math}</code>`;
    }
  }, [math, inline]);

  return (
    <span
      className={`katex-wrapper ${className}`}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
};
