import { useCallback } from 'react';
import { useCopyFeedback } from '../../utils/use-copy-feedback';

export function useCopyContent(content: () => string): {
  copied: boolean;
  copy: () => void;
} {
  const { copied, markCopied } = useCopyFeedback();

  const copy = useCallback(() => {
    navigator.clipboard.writeText(content()).then(
      () => {
        markCopied();
      },
      (error) => {
        console.error('复制失败:', error);
      }
    );
  }, [content, markCopied]);

  return { copied, copy };
}
