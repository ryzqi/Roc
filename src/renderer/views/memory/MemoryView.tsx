import { useState } from 'react';
import { CompactStatusPill } from '../../components/CompactStatusPill';
import { EmptyState } from '../../components/EmptyState';
import { FieldPreview } from '../../components/FieldPreview';
import { Metric } from '../../components/Metric';
import { PageHeading } from '../../components/PageHeading';
import { Row } from '../../components/Row';
import { StatusPill } from '../../components/StatusPill';
import type { LazyLoadState, MemoryRecordViewModel } from '../../app/types';
import type { LoadedState } from '../../loaded-state';
import { memoryRecordTitle } from './memory-record-title';

export function MemoryView({
  loadState,
  state
}: {
  loadState: LazyLoadState;
  state: LoadedState;
}): React.JSX.Element {
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);

  if (loadState.status === 'loading') {
    return (
      <>
        <PageHeading kicker="控制面" title="记忆中心" />
        <section className="canvas-stage stage-grid" data-testid="memory-view">
          <EmptyState testId="memory-loading" title="记忆中心加载中" tone="loading" />
        </section>
      </>
    );
  }

  if (loadState.status === 'error') {
    return (
      <>
        <PageHeading kicker="控制面" title="记忆中心" />
        <section className="canvas-stage stage-grid" data-testid="memory-view">
          <EmptyState testId="memory-load-error" title="记忆中心加载失败" tone="error" />
        </section>
      </>
    );
  }
  const recoveredId = state.memoryRecovery?.id ?? null;
  const memoryItems = state.memorySearch?.items ?? [];
  const recallItems = state.sessionSearch?.items ?? [];
  const latestActiveMemory = memoryItems.find((item) => item.layer !== 'session') ?? null;
  const selectedCandidate = state.memoryCandidates[0] ?? null;
  const liveVisibleRecords: MemoryRecordViewModel[] = [
    ...(selectedCandidate === null
      ? []
      : [
          {
            id: selectedCandidate.id,
            layer: 'candidate',
            scope: selectedCandidate.scope,
            type: selectedCandidate.type,
            confidence: selectedCandidate.confidence,
            sourceTag: selectedCandidate.source,
            status: selectedCandidate.state,
            priority: selectedCandidate.priority,
            sourceRef: selectedCandidate.sourceRef,
            summary: selectedCandidate.content,
            detail: selectedCandidate.content,
            tone: selectedCandidate.state === 'conflict_detected' ? 'warn' : 'ok'
          }
        ]),
    ...memoryItems.slice(0, 4).map((item) => ({
      id: item.id,
      layer: item.layer,
      scope: item.scope,
      type: 'project_context',
      confidence: item.confidence,
      sourceTag: item.sourceRef,
      status: item.reason,
      priority: 'medium',
      sourceRef: item.sourceRef,
      summary: item.summary,
      detail: item.summary,
      tone: item.layer === 'hot' ? 'ok' : 'info'
    }))
  ];
  const visibleRecords = liveVisibleRecords;
  const selectedRecord = visibleRecords.find((record) => record.id === selectedRecordId) ?? visibleRecords[0] ?? null;
  const selectedRecordTitle = selectedRecord === null ? 'memory-center' : memoryRecordTitle(selectedRecord);
  const draftText = selectedRecord?.summary ?? '';
  return (
    <>
      <PageHeading
        flags={<StatusPill label="真相源" tone="ok" value={state.memoryStatus.truthSource} />}
        kicker="控制面"
        title="记忆中心"
      />
      <section className="canvas-stage stage-grid" data-testid="memory-view">
        <div className="memory-search-box">
          <span>搜索记忆 ID、正文、来源引用、scope 或会话摘要</span>
          <StatusPill label="当前范围" tone="info" value="project:Roc" />
        </div>
        <div className="memory-library-layout">
          <aside className="memory-library-sidebar">
            <div className="grid-2">
              <Metric
                label="全部记忆"
                note="含热 / 暖 / 会话回忆"
                value={Object.values(state.memoryStatus.layers).reduce((total, item) => total + item.entries, 0)}
              />
              <Metric
                label="草稿"
                note={selectedRecord === null ? '无待保存差异' : '当前条目可编辑'}
                value={selectedRecord === null ? 0 : 1}
              />
            </div>
            <section className="card">
              <div className="card-title">筛选与视图</div>
              <Row title="记忆域" sub="偏好 / 反馈 / 项目上下文 / 过程技能 / 知识笔记 / 会话回忆" tag="全部" tone="info" />
              <Row title="作用范围" sub="global / project:Roc / task threads" tag="自动约束" tone="ok" />
              <Row title="来源" sub="user_explicit / feedback / agent_extract / session_recall" tag="可筛选" tone="ok" />
            </section>
            <div className="memory-list-shell">
              <div className="memory-list-head">
                <span>记忆列表</span>
                <CompactStatusPill tone="ok" value={`${visibleRecords.length} 条记录`} />
              </div>
              <div className="memory-list-body">
                {visibleRecords.length === 0 ? (
                  <p className="muted">当前没有可显示记忆。</p>
                ) : (
                  visibleRecords.map((record) => (
                    <button
                      aria-pressed={selectedRecord?.id === record.id}
                      className={selectedRecord?.id === record.id ? 'memory-record active' : 'memory-record'}
                      key={record.id}
                      type="button"
                      onClick={() => setSelectedRecordId(record.id)}
                    >
                      <div className="memory-record-meta">
                        <span className="memory-record-title">{memoryRecordTitle(record)}</span>
                        <span className={`pill ${record.tone}`}>{record.layer}</span>
                        <span className="pill">{record.sourceTag}</span>
                      </div>
                      <div className="memory-record-copy">{record.summary}</div>
                      <div className="memory-record-meta">
                        <span className="pill">scope: {record.scope}</span>
                        <span className="pill">status: {record.status}</span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
            <section className="card">
              <div className="card-title">后台静默整理</div>
              <Row title="默认行为" tag="自动" tone="ok" />
            </section>
          </aside>
          <section className="memory-library-workspace">
            <div className="memory-editor-stage">
              <div className="memory-editor-topline">
                <div>
                  <div className="memory-editor-title">{selectedRecordTitle}</div>
                  {selectedRecord === null ? null : (
                    <div className="memory-editor-subtitle">{`${selectedRecord.layer} / ${selectedRecord.scope}`}</div>
                  )}
                </div>
                <CompactStatusPill tone={state.memoryStatus.degradedReason === undefined ? 'info' : 'warn'} value={state.memoryStatus.degradedReason === undefined ? '当前条目已同步' : '索引降级'} />
              </div>
              <div className="memory-editor-meta">
                {selectedRecord === null ? (
                  Object.entries(state.memoryStatus.layers).map(([layer, item]) => (
                    <span className="pill" key={layer}>{layer}: {item.entries}</span>
                  ))
                ) : (
                  <>
                    <span className={`pill ${selectedRecord.tone}`}>{selectedRecord.layer}</span>
                    <span className="pill">scope: {selectedRecord.scope}</span>
                    <span className="pill">type: {selectedRecord.type}</span>
                    <span className="pill">confidence: {selectedRecord.confidence}</span>
                    <span className="pill">source: {selectedRecord.sourceTag}</span>
                    <span className="pill">{selectedRecord.status}</span>
                    <span className="pill">{selectedRecord.priority}</span>
                  </>
                )}
              </div>
              <div className="memory-editor-main">
                <div className="memory-editor-panel">
                  <div className="memory-preview-surface">
                    {selectedRecord === null ? '来源引用：当前没有候选记忆。' : `来源引用：${selectedRecord.sourceRef}`}
                  </div>
                  <textarea className="memory-editor-textarea" readOnly value={draftText}></textarea>
                  <div className="memory-editor-copy">
                    {selectedRecord === null ? '当前没有候选内容。' : selectedRecord.note ?? selectedRecord.detail}
                  </div>
                  <div className="form-grid">
                    <FieldPreview label="最近恢复" value={recoveredId ?? latestActiveMemory?.id ?? '无恢复记录'} />
                    <FieldPreview label="召回结果" value={String(memoryItems.length)} />
                  </div>
                  <div className="memory-editor-actions">
                    <span className="memory-chip-button primary" data-testid="memory-save-status">
                      只读
                    </span>
                    <span className="memory-chip-button">
                      恢复受控
                    </span>
                    <span className="memory-chip-button">
                      归档受控
                    </span>
                    <span className="memory-chip-button warn">
                      分层受控
                    </span>
                    <span className="memory-chip-button bad">
                      删除受控
                    </span>
                  </div>
                  <section className="card">
                    <div className="card-title">删除与恢复</div>
                    <Row title="删除当前条目" sub="先展示影响范围；删除会话回忆不会自动级联删除策展记忆。" tag="受控" tone="warn" />
                    <Row title="恢复历史版本" sub="可从 cold history 恢复旧版本，并保留 superseded 轨迹。" tag="可恢复" tone="info" />
                  </section>
                </div>
              </div>
            </div>
          </section>
        </div>
        <div className="grid-2">
          <div className="notice" data-testid="memory-degraded">
            {state.memoryStatus.degradedReason === undefined ? '索引状态正常；向量索引可按需重建。' : state.memoryStatus.degradedReason}
          </div>
          <section className="card" data-testid="memory-candidates">
            <div className="card-title">候选记忆</div>
            {state.memoryCandidates.length === 0 ? <p className="muted">候选区为空。</p> : state.memoryCandidates.map((candidate) => (
              <Row key={candidate.id} sub={candidate.content} tag={candidate.state} title={candidate.type} tone={candidate.state === 'conflict_detected' ? 'warn' : 'info'} />
            ))}
          </section>
          <section className="card" data-testid="memory-conflicts">
            <div className="card-title">冲突裁决</div>
            {state.memoryConflicts.length === 0 ? <p className="muted">没有开放冲突。</p> : state.memoryConflicts.map((conflict) => (
              <Row key={conflict.id} sub={conflict.reason} tag={conflict.status} title={`${conflict.type} · ${conflict.scope}`} tone="warn" />
            ))}
          </section>
          <section className="card" data-testid="memory-search-results">
            <div className="card-title">记忆召回</div>
            {memoryItems.length === 0 ? <p className="muted">没有召回结果。</p> : memoryItems.map((item) => (
              <Row key={`${item.layer}:${item.id}`} sub={item.summary} tag={item.layer} title={item.reason} tone="ok" />
            ))}
          </section>
          <section className="card" data-testid="session-recall-results">
            <div className="card-title">会话回忆</div>
            {recallItems.length === 0 ? <p className="muted">没有会话回忆结果。</p> : recallItems.map((item) => (
              <Row key={item.id} sub={item.summary} tag={item.scope} title={item.title} tone="info" />
            ))}
          </section>
          <section className="card" data-testid="memory-recovery">
            <div className="card-title">删除恢复</div>
            {state.memoryRecovery !== null ? (
              <Row title="最近操作" sub={state.memoryRecovery.id} tag={state.memoryRecovery.status} tone="ok" />
            ) : latestActiveMemory !== null ? (
              <Row title="最近操作" sub={latestActiveMemory.id} tag="active" tone="ok" />
            ) : (
              <Row title="最近操作" sub="暂无删除恢复记录。" tag="空" tone="warn" />
            )}
          </section>
        </div>
      </section>
    </>
  );
}
