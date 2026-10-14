import { useState, type ComponentPropsWithoutRef } from 'react';

/**
 * Markdown image (T4.4), ported from `chat/markdown-image.tsx`.
 *
 * The legacy frame used `chat-rich-content.css` classes; this uses Tailwind +
 * semantic tokens. `onError` still degrades to an explicit label instead of leaving a
 * broken-image glyph, because a model-written image URL very often 404s and the alt
 * text is the only useful information in that case.
 */
function positiveLength(value: string | number | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function MarkdownImage({ alt, height, src, width }: ComponentPropsWithoutRef<'img'>): React.JSX.Element {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (src === undefined || src.length === 0) {
    return <span>{alt}</span>;
  }
  const failed = failedSrc === src;
  const frameWidth = positiveLength(width);
  const frameHeight = positiveLength(height);
  const aspectRatio = frameWidth !== null && frameHeight !== null ? `${frameWidth} / ${frameHeight}` : undefined;
  const label = alt === undefined || alt.length === 0 ? '图片没有加载' : alt;

  return (
    <span
      className="my-2 block overflow-hidden rounded-card border border-line bg-bg-soft"
      style={aspectRatio === undefined ? undefined : { aspectRatio }}
      data-testid="assistant-markdown-image"
    >
      {failed ? (
        <span className="block px-3 py-2 text-muted text-[var(--font-meta-size)]">{label}</span>
      ) : (
        <img
          alt={alt ?? ''}
          src={src}
          onError={() => setFailedSrc(src)}
          className="max-h-[420px] w-full object-contain"
        />
      )}
    </span>
  );
}
