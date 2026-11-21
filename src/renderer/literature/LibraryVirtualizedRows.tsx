import {forwardRef, type ReactNode} from 'react';
import {Virtuoso, type Components, type ItemProps, type ListProps, type ListRange, type VirtuosoHandle} from 'react-virtuoso';
import type {ResearchLibraryItem} from '../../shared/types';

type LibraryVirtualizedRowsProps = {
  items: readonly ResearchLibraryItem[];
  initialIndex: number;
  onRangeChanged: (range: ListRange) => void;
  renderRow: (index: number, item: ResearchLibraryItem) => ReactNode;
};

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
export const LibraryVirtualizedRows = forwardRef<VirtuosoHandle, LibraryVirtualizedRowsProps>(
  function LibraryVirtualizedRows({items, initialIndex, onRangeChanged, renderRow}, ref) {
    return <Virtuoso ref={ref} style={{height: '100%'}} className="library-virtual-list"
      data={items} computeItemKey={(_index, item) => item.id} components={components}
      initialTopMostItemIndex={initialIndex} defaultItemHeight={88} increaseViewportBy={176}
      rangeChanged={onRangeChanged} itemContent={renderRow}/>;
  }
);
