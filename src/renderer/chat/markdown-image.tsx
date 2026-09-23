import { useState, type ComponentPropsWithoutRef } from 'react';

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
    <span className="markdown-image-frame" style={aspectRatio === undefined ? undefined : { aspectRatio }}>
      {failed ? (
        <span className="markdown-image-fallback">{label}</span>
      ) : (
        <img alt={alt ?? ''} src={src} onError={() => setFailedSrc(src)} />
      )}
    </span>
  );
}
