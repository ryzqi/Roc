import { EmptyState } from '../../components/EmptyState';
import { PageHeading } from '../../components/PageHeading';
import type { LazyLoadState } from '../../app/types';
import type { LoadedState } from '../../loaded-state';

export function MemoryView({
  loadState,
  state
}: {
  loadState: LazyLoadState;
  state: LoadedState;
}): React.JSX.Element {
  if (loadState.status === 'loading') {
    return (
      <>
        <PageHeading title="记忆中心" />
        <section className="canvas-stage stage-grid" data-testid="memory-view">
          <EmptyState testId="memory-loading" title="记忆中心加载中" tone="loading" />
        </section>
      </>
    );
  }

  if (loadState.status === 'error') {
    return (
      <>
        <PageHeading title="记忆中心" />
        <section className="canvas-stage stage-grid" data-testid="memory-view">
          <EmptyState testId="memory-load-error" title="记忆中心加载失败" tone="error" />
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeading title="记忆中心" meta="Phase 1 占位" />
      <section className="canvas-stage stage-grid" data-testid="memory-view">
        <div className="notice" data-testid="memory-phase-1-placeholder">
          记忆系统正在重构中。旧候选审核、冲突裁决和会话回忆视图已删除；新版文件编辑、会话回顾与系统快照视图将在后续阶段接入。
        </div>
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">当前状态</h2>
          </div>
          <div className="list-rows">
            <p className="muted">根目录：{state.memoryStatus.root}</p>
            <p className="muted">当前工作区：{state.memoryStatus.workspaceLabel ?? '未选择'}</p>
            <p className="muted">全文索引：{state.memoryStatus.fullTextIndex.status}</p>
          </div>
        </section>
      </section>
    </>
  );
}
