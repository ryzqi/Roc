import { useContext, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';
import { MotionConfig, MotionConfigContext } from 'motion/react';
import type { EffectiveMotionTransition } from './motion';

const query = '(prefers-reduced-motion: reduce)';
const inputAttributes = ['data-reduce-motion', 'data-reduced-motion'];
const listeners = new Set<() => void>();
let media: MediaQueryList | null = null;
let observer: MutationObserver | null = null;

function preferenceRoots(): Element[] {
  return [document.documentElement, document.body, document.getElementById('root')]
    .filter((element): element is HTMLElement => element !== null);
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined') return false;
  media ??= window.matchMedia(query);
  return media.matches || preferenceRoots().some(element => inputAttributes.some(
    attribute => element.getAttribute(attribute) === 'true'
  ));
}

const getServerSnapshot = (): boolean => false;
const notify = (): void => { for (const listener of listeners) listener(); };

/** All consumers share one media listener and one observer, including isolated surfaces. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    media ??= window.matchMedia(query);
    media.addEventListener('change', notify);
    observer = new MutationObserver(notify);
    for (const element of preferenceRoots()) {
      observer.observe(element, { attributes: true, attributeFilter: inputAttributes });
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      media?.removeEventListener('change', notify);
      observer?.disconnect();
      observer = null;
    }
  };
}

export function useEffectiveReducedMotion(): boolean {
  const preference = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const inherited = useContext(MotionConfigContext).reducedMotion;
  return preference || inherited === 'always';
}

/** No wrapper or remount: changing the preference preserves drafts, focus and presence. */
export function MotionPreferenceProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const reduced = useEffectiveReducedMotion();
  const transition: EffectiveMotionTransition = { reduceMotion: reduced };
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute('data-motion-reduced');
    root.setAttribute('data-motion-reduced', String(reduced));
    return () => {
      if (previous === null) root.removeAttribute('data-motion-reduced');
      else root.setAttribute('data-motion-reduced', previous);
    };
  }, [reduced]);
  return <MotionConfig reducedMotion={reduced ? 'always' : 'never'} transition={transition}>
    {children}
  </MotionConfig>;
}
