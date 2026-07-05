import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { FilePreviewResult, FileTreeResult, FilesWorkbenchPdfPreviewResult } from '../../shared/types';
import { CompactStatusPill } from '../components/CompactStatusPill';
import { EmptyState } from '../components/EmptyState';
import { TreeItem } from '../components/TreeItem';
import type { LazyLoadState, WorkspaceData } from '../app/types';
import type { LoadedState } from '../loaded-state';
import { unwrap } from '../loaded-state';
import type { RocClient } from '../shared/roc-client';
import { createRocClient } from '../shared/roc-client';
import { flattenTreeEntries, isImagePreview, parentRelativePath, previewTextBody } from './file-tree-helpers';
import { resolveResizeSeparatorKeyWidth } from './resize-separator-keyboard';

const FILE_PANE_MIN_WIDTH = 228;
const FILE_PANE_MAX_WIDTH = 440;
const FILE_PANE_DEFAULT_WIDTH = 304;
const RESIZE_KEY_STEP = 16;

export function FilesWorkbench({
  client,
  loadState,
  state,
  updateWorkspaceData
}: {
  client?: RocClient;
  loadState: LazyLoadState;
  state: LoadedState;
  updateWorkspaceData: (partial: Partial<WorkspaceData>) => void;
}): React.JSX.Element {
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [directoryChildren, setDirectoryChildren] = useState<Record<string, FileTreeResult['entries']>>({});
  const [directoryLoadingPath, setDirectoryLoadingPath] = useState<string | null>(null);
  const [filePaneWidth, setFilePaneWidth] = useState(FILE_PANE_DEFAULT_WIDTH);
  const selectedPreviewRelativePath = state.fileWorkbenchPdfPreview?.relativePath ?? state.filePreview?.relativePath ?? null;
  const previewPath = selectedPreviewRelativePath ?? '当前没有可预览文件';

  function resolveClient(): RocClient {
    return client ?? createRocClient();
  }

  useEffect(() => {
    setExpandedDirectories(new Set());
    setDirectoryChildren({});
    setDirectoryLoadingPath(null);
    setFilePaneWidth(FILE_PANE_DEFAULT_WIDTH);
  }, [state.workspace?.path]);

  async function openFilePreview(relativePath: string): Promise<void> {
    const filesClient = resolveClient();
    const preview = unwrap<FilePreviewResult>('file preview', await filesClient.api.files.preview({ relativePath }));
    const pdfPreview =
      preview.mediaType === 'application/pdf'
        ? unwrap<FilesWorkbenchPdfPreviewResult>('file pdf preview', await filesClient.api.files.previewPdf({ relativePath }))
        : null;
    updateWorkspaceData({ filePreview: preview, fileWorkbenchPdfPreview: pdfPreview, fileSearch: null });
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
        const childTree = unwrap<FileTreeResult>('file tree', await resolveClient().api.files.listTree({ relativePath }));
        setDirectoryChildren((current) => ({ ...current, [relativePath]: childTree.entries }));
      } finally {
        setDirectoryLoadingPath((current) => (current === relativePath ? null : current));
      }
    }
    setExpandedDirectories((current) => new Set(current).add(relativePath));
  }

  useEffect(() => {
    if (selectedPreviewRelativePath === null) {
      return;
    }
    const parentPath = parentRelativePath(selectedPreviewRelativePath);
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
  }, [selectedPreviewRelativePath]);

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
    state.fileWorkbenchPdfPreview !== null ? (
      <div className="workbench-file-pdf-stage" data-testid="workbench-file-preview">
        <iframe
          className="workbench-file-pdf-frame"
          data-testid="workbench-file-pdf-preview"
          src={state.fileWorkbenchPdfPreview.resourceUrl}
          title={state.fileWorkbenchPdfPreview.relativePath}
        />
      </div>
    ) : state.filePreview === null ? (
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
      const nextWidth = Math.min(FILE_PANE_MAX_WIDTH, Math.max(FILE_PANE_MIN_WIDTH, startWidth + moveEvent.clientX - startX));
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

  function resizeFilePaneWithKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    const nextWidth = resolveResizeSeparatorKeyWidth({
      currentWidth: filePaneWidth,
      direction: 'normal',
      key: event.key,
      maxWidth: FILE_PANE_MAX_WIDTH,
      minWidth: FILE_PANE_MIN_WIDTH,
      step: RESIZE_KEY_STEP
    });
    if (nextWidth === null) {
      return;
    }
    event.preventDefault();
    setFilePaneWidth(nextWidth);
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
                  active={selectedPreviewRelativePath === entry.relativePath}
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
          aria-orientation="vertical"
          aria-valuemin={FILE_PANE_MIN_WIDTH}
          aria-valuemax={FILE_PANE_MAX_WIDTH}
          aria-valuenow={filePaneWidth}
          tabIndex={0}
          onKeyDown={resizeFilePaneWithKeyboard}
          onPointerDown={startFilePaneResize}
        />
        <section className="workbench-content-pane">
          <header className="pane-header pane-header--content">
            <div>
              <div className="pane-path">{previewPath}</div>
            </div>
          </header>
          <div
            className={
              state.filePreview?.kind === 'text'
                ? 'workbench-file-body workbench-file-body--code'
                : state.fileWorkbenchPdfPreview !== null
                  ? 'workbench-file-body workbench-file-body--pdf'
                  : 'workbench-file-body'
            }
          >
            {previewPanel}
          </div>
        </section>
      </div>
    </section>
  );
}
