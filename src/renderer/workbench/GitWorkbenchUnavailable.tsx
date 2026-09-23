import { EmptyState, loadFailureDetail } from '../components/EmptyState';
import type { LazyLoadState } from '../app/types';
import type { LoadedState } from '../loaded-state';

export function renderGitWorkbenchUnavailable({
  loadState,
  state
}: {
  loadState: LazyLoadState;
  state: LoadedState;
}): React.JSX.Element | null {
  if (state.workspace === null) {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState detail="先在研究项目里绑定工作目录，再打开 Git。" testId="workbench-git-empty" title="未选择工作区" />
      </section>
    );
  }

  if (loadState.status === 'loading') {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState testId="workbench-git-loading" title="Git 工作台加载中" tone="loading" />
      </section>
    );
  }

  if (loadState.status === 'error') {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState detail={loadFailureDetail(loadState.error)} testId="workbench-git-load-error" title="Git 工作台加载失败" tone="error" />
      </section>
    );
  }

  return null;
}

export function renderGitRepositoryUnavailable(): React.JSX.Element {
  return (
    <section className="tool-panel workbench-surface">
      <EmptyState
        detail="这个目录还没有 Git 仓库。换一个仓库目录，或在这里初始化。"
        testId="workbench-git-empty"
        title="当前工作区不是 Git 仓库"
      />
    </section>
  );
}
