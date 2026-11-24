import {forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, type ReactNode} from 'react';
import {Virtuoso, type Components, type ItemProps, type ListProps, type ListRange, type VirtuosoHandle} from 'react-virtuoso';
import type {ResearchLibraryItem} from '../../shared/types';

type LibraryVirtualizedRowsProps = {
  items: readonly ResearchLibraryItem[];
  initialIndex: number;
  navigationScope: string;
  onRangeChanged: (range: ListRange) => void;
  onNavigationInterrupted: () => void;
  renderRow: (index: number, item: ResearchLibraryItem) => ReactNode;
};

export type LibraryVirtualizedRowsHandle = Pick<VirtuosoHandle, 'scrollIntoView'>;

const LibraryList = forwardRef<HTMLDivElement, Omit<ListProps, 'ref'> & {context?: unknown}>(
  function LibraryList({children, context, ...props}, ref) {
    void context;
    return <div {...props} ref={ref} role="list" aria-label="文献列表">{children}</div>;
  }
);

const LibraryItem = forwardRef<HTMLDivElement, ItemProps<ResearchLibraryItem> & {context?: unknown}>(
  function LibraryItem({children, item, context, ...props}, ref) {
    void item;
    void context;
    return <div {...props} ref={ref} role="listitem">{children}</div>;
  }
);

const components: Components<ResearchLibraryItem> = {List: LibraryList, Item: LibraryItem};

/** Loaded only for large result sets; variable-height titles remain fully measurable. */
export const LibraryVirtualizedRows = forwardRef<LibraryVirtualizedRowsHandle, LibraryVirtualizedRowsProps>(
  function LibraryVirtualizedRows({items, initialIndex, navigationScope, onRangeChanged, onNavigationInterrupted, renderRow}, ref) {
    const virtualizerRef = useRef<VirtuosoHandle | null>(null);
    const scrollerRef = useRef<HTMLElement | null>(null);
    const previousScope = useRef({items, navigationScope});
    const navigating = useRef(true);
    const manualScroll = useRef(false);
    const navigationGeneration = useRef(0);
    const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const keepNavigationActive = useCallback((): void => {
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      // Virtuoso 4.18 retries variable-height positioning after size changes until
      // 150ms of quiet. Keep the manual handoff available through that short tail.
      settleTimer.current = setTimeout(() => {
        navigating.current = false;
        manualScroll.current = false;
        settleTimer.current = null;
      }, 200);
    }, []);
    const preserveViewport = useCallback((scroller: HTMLElement): void => {
      // Replace the old selected-row retry with the user's current viewport.
      // This flat, headerless list starts at index zero: its origin stays fixed
      // even while distant, previously unmeasured rows change height.
      virtualizerRef.current?.scrollToIndex({index: 0, align: 'start', behavior: 'auto', offset: scroller.scrollTop});
      navigating.current = true;
      // A thumb drag can keep scrolling without another pointerdown.
      keepNavigationActive();
    }, [keepNavigationActive]);
    const setScrollerRef = useCallback((scroller: HTMLElement | Window | null): void => {
      scrollerRef.current = scroller instanceof HTMLElement ? scroller : null;
    }, []);
    useEffect(() => {
      keepNavigationActive();
      return () => {
        navigationGeneration.current++;
        onNavigationInterrupted();
        if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      };
    }, [keepNavigationActive, onNavigationInterrupted]);
    useLayoutEffect(() => {
      if (previousScope.current.items === items && previousScope.current.navigationScope === navigationScope) return;
      previousScope.current = {items, navigationScope};
      navigationGeneration.current++;
      onNavigationInterrupted();
      if (navigating.current && scrollerRef.current !== null) preserveViewport(scrollerRef.current);
    }, [items, navigationScope, onNavigationInterrupted, preserveViewport]);
    useImperativeHandle(ref, () => ({
      scrollIntoView(location): void {
        const generation = ++navigationGeneration.current;
        navigating.current = true;
        manualScroll.current = false;
        keepNavigationActive();
        virtualizerRef.current?.scrollIntoView({...location, done: () => {
          if (generation === navigationGeneration.current) location.done?.();
        }});
      }
    }), [keepNavigationActive]);
    const requestManualScroll = (): void => {
      if (!navigating.current) return;
      manualScroll.current = true;
      navigationGeneration.current++;
      onNavigationInterrupted();
    };
    return <Virtuoso ref={virtualizerRef} scrollerRef={setScrollerRef} style={{height: '100%'}} className="library-virtual-list"
      data={items} computeItemKey={(_index, item) => item.id} components={components}
      initialTopMostItemIndex={initialIndex} defaultItemHeight={88} increaseViewportBy={176}
      rangeChanged={onRangeChanged} itemContent={renderRow}
      itemsRendered={() => {if (navigating.current) keepNavigationActive();}}
      totalListHeightChanged={() => {if (navigating.current) keepNavigationActive();}}
      onWheelCapture={requestManualScroll} onPointerDownCapture={requestManualScroll}
      onKeyDownCapture={event => {
        if (event.key === 'PageUp' || event.key === 'PageDown') requestManualScroll();
      }}
      onScrollCapture={event => {
        if (!navigating.current) return;
        if (!manualScroll.current) {keepNavigationActive(); return;}
        preserveViewport(event.currentTarget);
      }}/>;
  }
);
