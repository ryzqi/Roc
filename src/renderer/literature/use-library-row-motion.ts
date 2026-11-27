import {useLayoutEffect, useRef, type RefObject} from 'react';
import type {ResearchLibraryItem} from '../../shared/types';
import {motionDurationSeconds, motionEasing} from '../shared/motion';
import {useEffectiveReducedMotion} from '../shared/motion-preference';

type VisibleRow = {node: HTMLElement; rect: DOMRect};
const MAX_ANIMATED_ROWS = 30;
const easing = `cubic-bezier(${motionEasing.standard.join(',')})`;

/** Presentation snapshots are bounded to the viewport; Virtuoso keeps all geometry. */
export function useLibraryRowMotion(bodyRef: RefObject<HTMLDivElement | null>, items: readonly ResearchLibraryItem[], scope: object, ready: boolean, removedIds: ReadonlySet<string>): void {
  const reduced = useEffectiveReducedMotion();
  const previous = useRef<{items: readonly ResearchLibraryItem[]; scope: object; rows: Map<string, VisibleRow>} | null>(null);
  const animations = useRef(new Set<Animation>());
  const ghosts = useRef(new Set<HTMLElement>());
  const scrolling = useRef(false);
  const cancel = (): void => {
    for (const animation of animations.current) animation.cancel();
    animations.current.clear();
    for (const ghost of ghosts.current) ghost.remove();
    ghosts.current.clear();
  };
  const snapshot = (): Map<string, VisibleRow> => {
    const body = bodyRef.current;
    const rows = new Map<string, VisibleRow>();
    if (body === null) return rows;
    const viewport = body.getBoundingClientRect();
    for (const node of body.querySelectorAll<HTMLElement>('[data-library-row]')) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > viewport.top && rect.top < viewport.bottom && rect.width > 0) {
        rows.set(node.dataset.libraryRow!, {node, rect});
        if (rows.size === MAX_ANIMATED_ROWS) break;
      }
    }
    return rows;
  };
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const settled = (): void => {
      clearTimeout(idle);
      scrolling.current = false;
      delete body.dataset.scrolling;
      if (previous.current !== null) previous.current.rows = snapshot();
    };
    const scroll = (): void => {
      scrolling.current = true;
      body.dataset.scrolling = 'true';
      cancel();
      clearTimeout(idle);
      idle = setTimeout(settled, motionDurationSeconds.fast * 1000);
    };
    const resize = new ResizeObserver(() => {cancel(); if (previous.current !== null) previous.current.rows = snapshot();});
    resize.observe(body);
    body.addEventListener('scroll', scroll, {capture: true, passive: true});
    body.addEventListener('scrollend', settled, {capture: true, passive: true});
    return () => {
      clearTimeout(idle); cancel(); resize.disconnect();
      body.removeEventListener('scroll', scroll, true);
      body.removeEventListener('scrollend', settled, true);
    };
  }, [bodyRef]);
  useLayoutEffect(() => {
    const before = previous.current;
    // Repeated changes cancel presentation immediately. Do not combine an old
    // layout endpoint with a partially interpolated rect as a new FLIP origin.
    const interrupted = animations.current.size > 0;
    cancel();
    const rows = snapshot();
    previous.current = {items, scope, rows};
    if (interrupted || before === null || before.scope !== scope || before.items === items || scrolling.current) return;
    const body = bodyRef.current;
    if (body === null) return;
    const currentIds = new Set(items.map(item => item.id));
    const removed = [...before.rows].filter(([id]) => !currentIds.has(id) && removedIds.has(id));
    const animate = (node: HTMLElement, frames: Keyframe[], duration: number, delay = 0, done?: () => void): void => {
      const animation = node.animate(frames, {duration, delay, easing, fill: 'backwards'});
      animations.current.add(animation);
      animation.onfinish = () => {animations.current.delete(animation); done?.();};
    };
    const exitMs = (reduced ? motionDurationSeconds.reduced : motionDurationSeconds.removal) * 1000;
    const bodyRect = body.getBoundingClientRect();
    // Removed data is already committed. The only retained pixels are inert
    // decorative clones, with no IDs, test hooks, focus targets or event handlers.
    for (const [, row] of removed) {
      const ghost = row.node.cloneNode(true) as HTMLElement;
      for (const element of [ghost, ...ghost.querySelectorAll<HTMLElement>('*')]) {
        element.removeAttribute('id'); element.removeAttribute('data-testid');
        element.removeAttribute('data-library-row');
      }
      ghost.inert = true; ghost.setAttribute('aria-hidden', 'true');
      ghost.classList.add('library-row-ghost');
      Object.assign(ghost.style, {left: `${row.rect.left - bodyRect.left}px`, top: `${row.rect.top - bodyRect.top}px`,
        width: `${row.rect.width}px`, height: `${row.rect.height}px`});
      body.appendChild(ghost); ghosts.current.add(ghost);
      animate(ghost, reduced ? [{opacity: 1}, {opacity: 0}]
        : [{opacity: 1, transform: 'scale(1)'}, {opacity: 0, transform: 'scale(.98)'}], exitMs, 0,
      () => {ghost.remove(); ghosts.current.delete(ghost);});
    }
    for (const [id, row] of rows) {
      const old = before.rows.get(id);
      if (old === undefined) continue;
      const delta = old.rect.top - row.rect.top;
      if (Math.abs(delta) < 1) continue;
      if (!reduced && (Math.max(before.items.length, items.length) <= MAX_ANIMATED_ROWS || removed.length > 0) && Math.abs(delta) <= 128) {
        animate(row.node, [{transform: `translateY(${delta}px)`}, {transform: 'translateY(0)'}],
          motionDurationSeconds.fast * 1000, removed.length > 0 ? exitMs : 0);
      } else {
        animate(row.node, [{opacity: .6}, {opacity: 1}],
          (reduced ? motionDurationSeconds.reduced : motionDurationSeconds.fast) * 1000);
      }
    }
  }, [items, scope, reduced, ready, removedIds]);
}
