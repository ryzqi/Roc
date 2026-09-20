import { useEffect, useState } from 'react';

export const RESEARCH_LIST_PAGE_SIZE = 20;

export function usePagedItems<T>(items: T[], resetKey: string): {
  remaining: number;
  showMore: () => void;
  visible: T[];
} {
  const [count, setCount] = useState(RESEARCH_LIST_PAGE_SIZE);
  useEffect(() => {
    setCount(RESEARCH_LIST_PAGE_SIZE);
  }, [resetKey]);
  return {
    remaining: Math.max(0, items.length - count),
    showMore() {
      setCount((current) => Math.min(items.length, current + RESEARCH_LIST_PAGE_SIZE));
    },
    visible: items.slice(0, count)
  };
}
