import { useEffect, useState } from 'react';

export const RESEARCH_COMPACT_QUERY = '(max-width: 1099px)';
export const RESEARCH_NARROW_QUERY = '(max-width: 799px)';

export function useResearchLayout(): { compact: boolean; narrow: boolean } {
  const compact = useMediaQuery(RESEARCH_COMPACT_QUERY);
  const narrow = useMediaQuery(RESEARCH_NARROW_QUERY);
  return { compact, narrow };
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    function onChange(): void {
      setMatches(media.matches);
    }
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
