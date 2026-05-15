import { useEffect, useState } from 'react';
import type { FilePreviewResult, FileTreeResult } from '../../shared/types';
import { CompactStatusPill } from '../components/CompactStatusPill';
import { EmptyState } from '../components/EmptyState';
import { TreeItem } from '../components/TreeItem';
import type { LazyLoadState, WorkspaceData } from '../app/types';
import type { LoadedState } from '../loaded-state';
import { unwrap } from '../loaded-state';
import { flattenTreeEntries, isImagePreview, parentRelativePath, previewTextBody } from './file-tree-helpers';

export function FilesWorkbench({
  loadState,
  state,
  updateWorkspaceData
}: {
  loadState: LazyLoadState;
  state: LoadedState;
  updateWorkspaceData: (partial: Partial<WorkspaceData>) => void;
}): React.JSX.Element {
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [directoryChildren, setDirectoryChildren] = useState<Record<string, FileTreeResult['entries']>>({});
  const [directoryLoadingPath, setDirectoryLoadingPath] = useState<string | null>(null);
  const [filePaneWidth, setFilePaneWidth] = useState(304);
  const previewPath = state.filePreview?.relativePath ?? '当前没有可预览文件';

  useEffect(() => {
    setExpandedDirectories(new Set());
    setDirectoryChildren({});
    setDirectoryLoadingPath(null);
    setFilePaneWidth(304);
  }, [state.workspace?.path]);

  async function openFilePreview(relativePath: string): Promise<void> {
    const preview = unwrap<FilePreviewResult>('file preview', await window.roc.files.preview({ relativePath }));
    updateWorkspaceData({ filePreview: preview, fileSearch: null });
  }

  async function toggleDirectory(relativePath: string): Promise<void> {
    if (expandedDirectories.has(relativePath)) {
      setExpandedDirectories((current) => {
        const next = new Set(current);
        next.delete(relativePath);
        return next;
      });
      return;
    }

    if (directoryChildren[relativePath] === undefined) {
      setDirectoryLoadingPath(relativePath);
      try {
        const childTree = unwrap<FileTreeResult>('file tree', await window.roc.files.listTree({ relativePath }));
        setDirectoryChildren((current) => ({ ...current, [relativePath]: childTree.entries }));
      } finally {
        setDirectoryLoadingPath((current) => (current === relativePath ? null : current));
      }
    }
    setExpandedDirectories((current) => new Set(current).add(relativePath));
  }

  useEffect(() => {
    if (state.filePreview === null) {
      return;
    }
    const parentPath = parentRelativePath(state.filePreview.relativePath);
    if (parentPath === null) {
      return;
    }
    setExpandedDirectories((current) => {
      if (current.has(parentPath)) {
        return current;
      }
      const next = new Set(current);
      next.add(parentPath);
      return next;
    });
  }, [state.filePreview?.relativePath]);

  if (state.workspace === null) {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState testId="workbench-files-empty" title="未选择工作区" />
      </section>
    );
  }

  if (loadState.status === 'loading') {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState testId="workbench-files-loading" title="文件工作台加载中" tone="loading" />
      </section>
    );
  }

  if (loadState.status === 'error') {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState testId="workbench-files-load-error" title="文件工作台加载失败" tone="error" />
      </section>
    );
  }

  const previewBody = previewTextBody(state.filePreview);
  const treeNodes = state.fileTree === null ? [] : flattenTreeEntries(state.fileTree.entries, expandedDirectories, directoryChildren);
  const previewPanel =
    state.filePreview === null ? (
      <div className="workbench-file-empty" data-testid="workbench-file-preview">
        <strong>尚未选中文件</strong>
        <p>从左侧文件树选择一个文件后，这里会显示原内容、图片或不可直接阅读的说明。</p>
      </div>
    ) : isImagePreview(state.filePreview) ? (
      <div className="workbench-file-image-stage" data-testid="workbench-file-preview">
        <img
          alt={state.filePreview.relativePath}
          className="workbench-file-image-preview"
          data-testid="workbench-file-image-preview"
          src={state.filePreview.content}
        />
      </div>
    ) : state.filePreview.kind === 'binary' ? (
      <div className="workbench-file-empty" data-testid="workbench-file-preview">
        <strong>该文件不能直接作为文本阅读</strong>
        <p>当前文件属于二进制内容。请在外部工具中打开，或使用 Git / 文件操作继续处理。</p>
      </div>
    ) : (
      <pre className="workbench-file-preview" data-testid="workbench-file-preview">
        {previewBody}
      </pre>
    );

  function startFilePaneResize(event: React.PointerEvent<HTMLDivElement>): void {
    const startX = event.clientX;
    const startWidth = filePaneWidth;
    const onMove = (moveEvent: PointerEvent): void => {
      const nextWidth = Math.min(440, Math.max(228, startWidth + moveEvent.clientX - startX));
      setFilePaneWidth(nextWidth);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  return (
    <section className="tool-panel workbench-surface workbench-surface--files">
      <div className="workbench-files" style={{ '--file-pane-width': `${filePaneWidth}px` } as React.CSSProperties}>
        <section className="workbench-sidebar-pane workbench-sidebar-pane--files">
          <header className="pane-header">
            <div>
              <div className="pane-title">文件树</div>
              {directoryLoadingPath === null ? null : <div className="pane-subtitle">正在展开目录</div>}
            </div>
            <CompactStatusPill tone="info" value={state.fileTree?.truncated ? '已截断' : '工作区内'} />
          </header>
          <div className="workbench-sidebar-summary">
            <span>{state.workspace.displayName}</span>
          </div>
          <section className="workbench-file-tree" data-testid="workbench-file-tree">
            {state.fileTree === null ? (
              <p className="muted">文件树未加载。</p>
            ) : (
              treeNodes.slice(0, 240).map(({ entry, depth }) => (
                <TreeItem
                  active={state.filePreview?.relativePath === entry.relativePath}
                  depth={depth}
                  expanded={expandedDirectories.has(entry.relativePath)}
                  entry={entry}
                  key={entry.relativePath}
                  loading={directoryLoadingPath === entry.relativePath}
                  onClick={
                    entry.type === 'file' ? () => void openFilePreview(entry.relativePath) : () => void toggleDirectory(entry.relativePath)
                  }
                />
              ))
            )}
          </section>
        </section>
        <div
          aria-label="调节文件树宽度"
          className="workbench-file-splitter"
          data-testid="workbench-file-splitter"
          role="separator"
          tabIndex={0}
          onPointerDown={startFilePaneResize}
        />
        <section className="workbench-content-pane">
          <header className="pane-header pane-header--content">
            <div>
              <div className="pane-path">{previewPath}</div>
            </div>
          </header>
          <div className={state.filePreview?.kind === 'text' ? 'workbench-file-body workbench-file-body--code' : 'workbench-file-body'}>
            {previewPanel}
          </div>
        </section>
      </div>
    </section>
  );
}
