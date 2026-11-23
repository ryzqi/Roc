import {Component, type ReactNode, type RefObject} from 'react';

type Props = {
  selected: boolean;
  identity: unknown;
  containerRef: RefObject<HTMLElement | null>;
  scrollSelectors: readonly string[];
  children: ReactNode;
};
type Location = {
  scroll: {selector: string; top: number; left: number}[];
  details: Map<string, boolean>;
};

/** Retain reading position while a mounted owner releases only its readonly descendants. */
export class ReadingViewBoundary extends Component<Props> {
  private location: Location | null = null;
  private cancelRestore: (() => void) | null = null;
  private resetOnResume = false;

  override getSnapshotBeforeUpdate(previous: Props): null {
    if (previous.identity !== this.props.identity) {
      this.location = null;
      if (!previous.selected || !this.props.selected) this.resetOnResume = true;
    }
    else if (previous.selected && !this.props.selected && this.cancelRestore === null) {
      const root = previous.containerRef.current;
      if (root !== null) this.location = {
        scroll: previous.scrollSelectors.flatMap(selector => {
          const node = root.querySelector<HTMLElement>(selector);
          return node === null ? [] : [{selector, top: node.scrollTop, left: node.scrollLeft}];
        }),
        details: new Map(Array.from(root.querySelectorAll<HTMLDetailsElement>('details[data-reading-detail]'),
          node => [node.dataset.readingDetail!, node.open]))
      };
    }
    return null;
  }

  override componentDidUpdate(previous: Props): void {
    if (!this.props.selected || previous.identity !== this.props.identity) this.cancelRestore?.();
    if (this.props.selected && this.resetOnResume) {
      this.resetOnResume = false;
      const root = this.props.containerRef.current;
      for (const selector of this.props.scrollSelectors) {
        const node = root?.querySelector<HTMLElement>(selector);
        if (node) {node.scrollTop = 0; node.scrollLeft = 0;}
      }
      for (const node of root?.querySelectorAll<HTMLDetailsElement>('details[data-reading-detail]') ?? []) node.open = false;
    }
    if (!this.props.selected || previous.selected || this.location === null) return;
    const root = this.props.containerRef.current;
    if (root === null) return;
    const pending = new Map(this.location.scroll.map(value => [value.selector, value]));
    const details = new Map(this.location.details);
    let frame = 0, stopped = false;
    const observed = new Set<Element>();
    const schedule = (): void => {
      if (stopped || frame !== 0) return;
      frame = requestAnimationFrame(() => {frame = 0; restore();});
    };
    const resize = new ResizeObserver(schedule);
    const mutations = new MutationObserver(schedule);
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    const stop = (): void => {
      if (stopped) return;
      stopped = true; cancelAnimationFrame(frame); window.clearTimeout(deadline);
      resize.disconnect(); mutations.disconnect();
      for (const event of events) root.removeEventListener(event, stop, true);
      this.cancelRestore = null;
    };
    const restore = (): void => {
      if (stopped) return;
      for (const node of root.querySelectorAll<HTMLDetailsElement>('details[data-reading-detail]')) {
        const open = details.get(node.dataset.readingDetail!);
        if (open === undefined) continue;
        node.open = open; details.delete(node.dataset.readingDetail!);
      }
      for (const [selector, saved] of pending) {
        const node = root.querySelector<HTMLElement>(selector);
        if (node === null) continue;
        node.scrollTop = saved.top; node.scrollLeft = saved.left;
        if (Math.abs(node.scrollTop - saved.top) <= 1 && Math.abs(node.scrollLeft - saved.left) <= 1) pending.delete(selector);
        else for (const target of [node, ...node.children]) if (!observed.has(target)) {
          observed.add(target); resize.observe(target);
        }
      }
      if (pending.size === 0 && details.size === 0) stop();
    };
    // Lazy Markdown can arrive after the shell is visible. Stop once restored, on user
    // interaction, or at the bounded deadline; never fight the reader's next scroll.
    const deadline = window.setTimeout(stop, 1500);
    this.cancelRestore = stop;
    for (const event of events) root.addEventListener(event, stop, {capture: true, passive: true});
    mutations.observe(root, {subtree: true, childList: true, characterData: true});
    restore();
  }

  override componentWillUnmount(): void {this.cancelRestore?.();}
  override render(): ReactNode {return this.props.children;}
}
