import { EmptyState } from '../../components/EmptyState';
import { Metric } from '../../components/Metric';
import { PageHeading } from '../../components/PageHeading';
import { Row } from '../../components/Row';
import type { LazyLoadState } from '../../app/types';
import type { LoadedState } from '../../loaded-state';
import { gitErrorLabel } from '../../utils/git-error-label';

export function GitView({
  loadState,
  state
}: {
  loadState: LazyLoadState;
  state: LoadedState;
}): React.JSX.Element {
  if (state.workspace !== null && loadState.status === 'loading') {
    return (
      <>
        <PageHeading title="Git 面板" />
        <section className="canvas-stage stage-grid" data-testid="git-view">
          <EmptyState testId="git-loading" title="Git 状态加载中" tone="loading" />
        </section>
      </>
    );
  }

  if (state.workspace !== null && loadState.status === 'error') {
    return (
      <>
        <PageHeading title="Git 面板" />
        <section className="canvas-stage stage-grid" data-testid="git-view">
          <EmptyState testId="git-load-error" title="Git 状态加载失败" tone="error" />
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeading title="Git 面板" meta={state.gitStatus === null ? '无仓库' : state.gitStatus.branch} />
      <section className="canvas-stage stage-grid" data-testid="git-view">
        <div className="stat-row">
          <Metric label="变更文件" note="来自 git status" value={state.gitStatus === null ? 0 : state.gitStatus.changedFiles} />
          <Metric label="当前分支" note="本地工作区" value={state.gitStatus === null ? '无仓库' : state.gitStatus.branch} />
          <Metric label="风险动作" note="分支切换 / 创建后切换需确认" tone="warn" value={2} />
        </div>
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Git 状态</h2>
          </div>
          <div className="list-rows">
            {state.gitStatus === null ? (
              <Row title="非 Git 工作区" sub={gitErrorLabel(state.gitError)} tag="空" tone="warn" />
            ) : state.gitStatus.porcelain.length === 0 ? (
              <Row title="工作区" sub="工作区干净" tag="无变更" tone="ok" />
            ) : (
              state.gitStatus.porcelain.map((item) => <Row key={item} sub={item} tag="未暂存" title="变更" tone="warn" />)
            )}
          </div>
        </section>
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">最近变更焦点</h2>
          </div>
          <div className="list-rows">
            {state.gitStatus === null ? (
              <Row title="当前工作区" sub="当前工作区不是 Git 仓库，未生成提交说明。" tag="空" tone="warn" />
            ) : (
              <Row
                title="当前工作区"
                sub={`${state.gitStatus.porcelain.length} 条变更可进入批量暂存或分支联动。`}
                tag={state.gitStatus.branch}
                tone="info"
              />
            )}
          </div>
        </section>
      </section>
    </>
  );
}
