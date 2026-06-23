import { CompactStatusPill } from '../../components/CompactStatusPill';
import { EmptyState } from '../../components/EmptyState';
import { PageHeading } from '../../components/PageHeading';
import { Row } from '../../components/Row';
import { TreeItem } from '../../components/TreeItem';
import type { LoadedState } from '../../loaded-state';
import type { LazyLoadState } from '../../app/types';
import { gitErrorLabel } from '../../utils/git-error-label';

export function WorkspaceView({
  loadState,
  onSelectWorkspace,
  state
}: {
  loadState: LazyLoadState;
  onSelectWorkspace: () => Promise<void>;
  state: LoadedState;
}): React.JSX.Element {
  if (state.workspace === null) {
    return (
      <>
        <PageHeading title="工作区文件" />
        <section className="canvas-stage stage-grid" data-testid="workspace-view">
          <EmptyState
            action={
              <button className="action-button" data-testid="workspace-empty-select" type="button" onClick={() => void onSelectWorkspace()}>
                选择工作区
              </button>
            }
            testId="workspace-empty"
            title="未选择工作区"
          />
          <WorkspaceStatusPanels state={state} />
        </section>
      </>
    );
  }

  if (loadState.status === 'loading') {
    return (
      <>
        <PageHeading title="工作区文件" />
        <section className="canvas-stage stage-grid" data-testid="workspace-view">
          <EmptyState testId="workspace-loading" title="工作区数据加载中" tone="loading" />
          <WorkspaceStatusPanels state={state} />
        </section>
      </>
    );
  }

  if (loadState.status === 'error') {
    return (
      <>
        <PageHeading title="工作区文件" />
        <section className="canvas-stage stage-grid" data-testid="workspace-view">
          <EmptyState testId="workspace-load-error" title="工作区数据加载失败" tone="error" />
          <WorkspaceStatusPanels state={state} />
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeading title="工作区文件" meta={state.workspace.displayName} />
      <section className="canvas-stage stage-grid" data-testid="workspace-view">
        <div className="split workspace-surface-grid">
          <section className="file-tree file-tree-surface workspace-surface" data-testid="file-tree">
            {state.fileTree === null ? (
              <p className="muted">文件树未加载。</p>
            ) : (
              state.fileTree.entries.map((entry) => <TreeItem entry={entry} key={entry.relativePath} />)
            )}
          </section>
          <section className="section workspace-surface">
            <div className="section-head">
              <h2 className="section-title">文件操作预览</h2>
              <CompactStatusPill tone="ok" value="工作区内" />
            </div>
            <div className="list-rows">
              <Row title="搜索" sub="按标题、正文、任务 ID、记忆 ID 搜索" tag="可执行" tone="info" />
              <Row title="编辑" sub="写入前创建恢复点，高风险动作确认" tag="受控" tone="ok" />
              <Row title="预览" sub="Markdown、代码、图片、PDF、Office 按需加载" tag="可用" tone="ok" />
              <Row title="自动化" sub="默认限定当前工作区，外部写入需确认" tag="受控" tone="warn" />
            </div>
          </section>
        </div>
        <section className="code-preview workspace-surface" data-testid="file-preview">
          {state.filePreview === null
            ? '# 当前工作区无可预览文本文件'
            : state.filePreview.content}
        </section>
        <WorkspaceStatusPanels state={state} />
      </section>
    </>
  );
}

function WorkspaceStatusPanels({ state }: { state: LoadedState }): React.JSX.Element {
  const terminalLabel =
    state.terminalSession === null
      ? state.workspace === null
        ? '未建立会话'
        : '打开终端后建立会话'
      : `${state.terminalSession.shell} · ${state.terminalSession.cols}×${state.terminalSession.rows}`;
  return (
    <div className="stat-row workspace-status-row">
      <section className="section" data-testid="git-panel">
        <div className="section-head">
          <h2 className="section-title">工作区状态</h2>
        </div>
        <div className="list-rows">
          {state.gitStatus === null ? (
            <p className="muted">{gitErrorLabel(state.gitError)}</p>
          ) : (
            <Row sub={state.gitStatus.workspacePath} tag={`${state.gitStatus.changedFiles} 变更`} title={state.gitStatus.branch} tone="info" />
          )}
        </div>
      </section>
      <section className="section" data-testid="terminal-panel">
        <div className="section-head">
          <h2 className="section-title">终端</h2>
        </div>
        <div className="list-rows">
          <Row
            title={state.terminalSession === null ? '未连接' : state.terminalSession.status}
            sub={state.terminalError ?? terminalLabel}
            tag={state.terminalSession === null ? '空态' : '会话'}
            tone={state.terminalSession === null ? 'warn' : 'ok'}
          />
        </div>
      </section>
      <section className="section" data-testid="rtk-panel">
        <div className="section-head">
          <h2 className="section-title">RTK</h2>
        </div>
        <div className="list-rows">
          <Row title="资源状态" sub={state.rtkStatus.resourceState === 'ready' ? 'ready' : '缺失降级'} tag={state.rtkStatus.resourceState} tone="warn" />
          <Row title="tee" sub={state.rtkStatus.teeDir} tag={state.rtkStatus.enabledForAgentCommands ? 'agent' : 'terminal'} tone="info" />
        </div>
      </section>
    </div>
  );
}
