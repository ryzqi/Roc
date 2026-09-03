import { useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { PageHeading } from '../../components/PageHeading';
import type { LazyLoadState } from '../../app/types';
import { visibleMemoryLabel } from '../../app/view-routing';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { AutoTab } from './auto-tab';
import { FilesTab } from './files-tab';
import { SessionsTab } from './sessions-tab';
import { SnapshotTab } from './snapshot-tab';

type MemoryTab = 'files' | 'sessions' | 'snapshot' | 'auto';

export function MemoryView({
  client,
  loadState,
  state
}: {
  client?: RocClient;
  loadState: LazyLoadState;
  state: LoadedState;
}): React.JSX.Element {
  const [tab, setTab] = useState<MemoryTab>('files');

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
      <PageHeading title="记忆中心" meta={visibleMemoryLabel(state)} />
      <section className="canvas-stage memory-center-stage" data-testid="memory-view">
        <div className="memory-tabs" role="tablist" aria-label="记忆中心">
          <button
            aria-controls="memory-panel-files"
            aria-selected={tab === 'files'}
            className={tab === 'files' ? 'tab active' : 'tab'}
            data-testid="memory-tab-files"
            id="memory-tab-files"
            onClick={() => setTab('files')}
            role="tab"
            type="button"
          >
            文件
          </button>
          <button
            aria-controls="memory-panel-sessions"
            aria-selected={tab === 'sessions'}
            className={tab === 'sessions' ? 'tab active' : 'tab'}
            data-testid="memory-tab-sessions"
            id="memory-tab-sessions"
            onClick={() => setTab('sessions')}
            role="tab"
            type="button"
          >
            会话回顾
          </button>
          <button
            aria-controls="memory-panel-snapshot"
            aria-selected={tab === 'snapshot'}
            className={tab === 'snapshot' ? 'tab active' : 'tab'}
            data-testid="memory-tab-snapshot"
            id="memory-tab-snapshot"
            onClick={() => setTab('snapshot')}
            role="tab"
            type="button"
          >
            系统快照
          </button>
          <button
            aria-controls="memory-panel-auto"
            aria-selected={tab === 'auto'}
            className={tab === 'auto' ? 'tab active' : 'tab'}
            data-testid="memory-tab-auto"
            id="memory-tab-auto"
            onClick={() => setTab('auto')}
            role="tab"
            type="button"
          >
            自动写入
          </button>
        </div>
        {tab === 'files' ? (
          <div aria-labelledby="memory-tab-files" id="memory-panel-files" role="tabpanel">
            <FilesTab client={client} initialStatus={state.memoryStatus} />
          </div>
        ) : null}
        {tab === 'sessions' ? (
          <div aria-labelledby="memory-tab-sessions" id="memory-panel-sessions" role="tabpanel">
            <SessionsTab client={client} workspaceHash={state.memoryStatus.workspaceHash} />
          </div>
        ) : null}
        {tab === 'snapshot' ? (
          <div aria-labelledby="memory-tab-snapshot" id="memory-panel-snapshot" role="tabpanel">
            <SnapshotTab client={client} />
          </div>
        ) : null}
        {tab === 'auto' ? (
          <div aria-labelledby="memory-tab-auto" id="memory-panel-auto" role="tabpanel">
            <AutoTab status={state.memoryStatus} />
          </div>
        ) : null}
      </section>
    </>
  );
}
