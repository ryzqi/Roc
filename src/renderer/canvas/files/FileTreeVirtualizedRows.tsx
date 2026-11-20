import { forwardRef, type ReactNode } from 'react';
import {
  Virtuoso,
  type Components,
  type ItemProps,
  type ListProps,
  type VirtuosoHandle
} from 'react-virtuoso';
import type { FileTreeRow } from '../../workspace/use-file-tree';

type VirtualizedFileTreeRowsProps = {
  rows: readonly FileTreeRow[];
  scrollParent: HTMLElement;
  rowHeight: number;
  overscan: number;
  renderRow: (index: number, row: FileTreeRow) => ReactNode;
};

type TreeListProps = Omit<ListProps<HTMLDivElement>, 'ref'> & { context?: unknown };

const TreeList = forwardRef<HTMLDivElement, TreeListProps>(function TreeList(
  { children, context, ...props },
  ref
) {
  void context;
  return (
    <div {...props} ref={ref} role="group">
      {children}
    </div>
  );
});

const TreeItem = forwardRef<HTMLDivElement, ItemProps<FileTreeRow> & { context?: unknown }>(
  function TreeItem(
    {
      children,
      style,
      item,
      context,
      'data-index': dataIndex,
      'data-item-group-index': groupIndex,
      'data-item-index': itemIndex,
      'data-known-size': knownSize
    },
    ref
  ) {
    void item;
    void context;
    return (
      <div
        ref={ref}
        data-index={dataIndex}
        data-item-group-index={groupIndex}
        data-item-index={itemIndex}
        data-known-size={knownSize}
        role="none"
        style={style}
      >
        {children}
      </div>
    );
  }
);

const treeComponents: Components<FileTreeRow> = {
  List: TreeList,
  Item: TreeItem
};

export const FileTreeVirtualizedRows = forwardRef<VirtuosoHandle, VirtualizedFileTreeRowsProps>(
  function FileTreeVirtualizedRows({ rows, scrollParent, rowHeight, overscan, renderRow }, ref) {
    return (
      <Virtuoso
        ref={ref}
        style={{ height: '100%' }}
        customScrollParent={scrollParent}
        data={rows}
        computeItemKey={(_index, row) => row.entry.relativePath}
        defaultItemHeight={rowHeight}
        increaseViewportBy={rowHeight * overscan}
        components={treeComponents}
        itemContent={(index, row) => renderRow(index, row)}
      />
    );
  }
);

FileTreeVirtualizedRows.displayName = 'FileTreeVirtualizedRows';

export type { VirtualizedFileTreeRowsProps };
export type { VirtuosoHandle };
