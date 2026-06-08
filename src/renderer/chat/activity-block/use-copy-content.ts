import { useCallback, useState } from 'react';

export function useCopyContent(content: () => string): {
  copied: boolean;
  copy: () => void;
} {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(content()).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      (error) => {
        console.error('复制失败:', error);
      }
    );
  }, [content]);

  return { copied, copy };
}
