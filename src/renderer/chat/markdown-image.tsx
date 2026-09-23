import type { ComponentPropsWithoutRef } from 'react';

export function MarkdownImage({ alt, src }: ComponentPropsWithoutRef<'img'>): React.JSX.Element {
  if (src === undefined || src.length === 0) {
    return <span>{alt}</span>;
  }

  return (
    <span className="markdown-image-frame">
      <img alt={alt ?? ''} src={src} />
    </span>
  );
}
