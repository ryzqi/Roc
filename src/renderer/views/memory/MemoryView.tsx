import { useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { PageHeading } from '../../components/PageHeading';
import type { LazyLoadState } from '../../app/types';
import { visibleMemoryLabel } from '../../app/view-routing';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { FilesTab } from './files-tab';
import { SessionsTab } from './sessions-tab';
import { SnapshotTab } from './snapshot-tab';

type MemoryTab = 'files' | 'sessions' | 'snapshot';

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
            aria-pressed={tab === 'files'}
            className={tab === 'files' ? 'tab active' : 'tab'}
            data-testid="memory-tab-files"
            onClick={() => setTab('files')}
            type="button"
          >
            文件
          </button>
          <button
            aria-pressed={tab === 'sessions'}
            className={tab === 'sessions' ? 'tab active' : 'tab'}
            data-testid="memory-tab-sessions"
            onClick={() => setTab('sessions')}
            type="button"
          >
            会话回顾
          </button>
          <button
            aria-pressed={tab === 'snapshot'}
            className={tab === 'snapshot' ? 'tab active' : 'tab'}
            data-testid="memory-tab-snapshot"
            onClick={() => setTab('snapshot')}
            type="button"
          >
            系统快照
          </button>
        </div>
        {tab === 'files' ? <FilesTab client={client} initialStatus={state.memoryStatus} /> : null}
        {tab === 'sessions' ? <SessionsTab client={client} /> : null}
        {tab === 'snapshot' ? <SnapshotTab client={client} /> : null}
      </section>
    </>
  );
}
