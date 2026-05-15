import { EmptyState } from '../../components/EmptyState';
import { PageHeading } from '../../components/PageHeading';
import { Row } from '../../components/Row';
import type { LazyLoadState } from '../../app/types';
import { isImagePreview, previewTextBody } from '../../workbench/file-tree-helpers';
import type { LoadedState } from '../../loaded-state';

export function PreviewView({
  loadState,
  state
}: {
  loadState: LazyLoadState;
  state: LoadedState;
}): React.JSX.Element {
  if (state.workspace !== null && loadState.status === 'loading') {
    return (
      <>
        <PageHeading title="文件预览" />
        <section className="canvas-stage stage-grid" data-testid="preview-view">
          <EmptyState testId="preview-loading" title="文件预览加载中" tone="loading" />
        </section>
      </>
    );
  }

  if (state.workspace !== null && loadState.status === 'error') {
    return (
      <>
        <PageHeading title="文件预览" />
        <section className="canvas-stage stage-grid" data-testid="preview-view">
          <EmptyState testId="preview-load-error" title="文件预览加载失败" tone="error" />
        </section>
      </>
    );
  }

  const previewBody = previewTextBody(state.filePreview);
  const previewStage =
    isImagePreview(state.filePreview) ? (
      <div className="workbench-file-image-stage">
        <img
          alt={state.filePreview.relativePath}
          className="workbench-file-image-preview"
          data-testid="preview-view-image"
          src={state.filePreview.content}
        />
      </div>
    ) : (
      <div className="code-preview">{state.filePreview === null ? '当前没有加载可预览内容。' : state.filePreview.content}</div>
    );

  return (
    <>
      <PageHeading title="文件预览" meta={state.filePreview === null ? '无可预览文件' : state.filePreview.relativePath} />
      <section className="canvas-stage stage-grid" data-testid="preview-view">
        <div className="preview-surface-grid">
          <section className="section preview-surface">
            <div className="section-head">
              <h2 className="section-title">Markdown / 文本预览</h2>
            </div>
            <div className="card-pad">
              <div className="page-title mini">{state.filePreview === null ? '无可预览文件' : state.filePreview.relativePath}</div>
              <div className="page-subtitle">
                {state.filePreview === null ? '当前根目录没有可预览文本文件。' : `${state.filePreview.sizeBytes} bytes`}
              </div>
              {state.filePreview === null ? null : state.filePreview.kind === 'image' ? (
                <p className="muted">图片预览已加载。</p>
              ) : (
                <p className="muted">{previewBody}</p>
              )}
            </div>
          </section>
          <section className="section preview-surface">
            <div className="section-head">
              <h2 className="section-title">代码 / Diff 预览</h2>
            </div>
            {previewStage}
          </section>
        </div>
        <section className="section preview-surface">
          <div className="section-head">
            <h2 className="section-title">搜索命中</h2>
          </div>
          <div className="list-rows">
            {state.fileSearch === null || state.fileSearch.matches.length === 0 ? (
              <p className="muted">没有匹配项。</p>
            ) : (
              state.fileSearch.matches.map((match) => (
                <Row
                  key={`${match.relativePath}:${match.line}:${match.column}`}
                  sub={match.preview}
                  tag={`${match.line}:${match.column}`}
                  title={match.relativePath}
                  tone="info"
                />
              ))
            )}
          </div>
        </section>
      </section>
    </>
  );
}
