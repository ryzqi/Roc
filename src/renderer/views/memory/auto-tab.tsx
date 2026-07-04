import type { MemoryStatus } from '../../../shared/types';

export function AutoTab({ status }: { status: MemoryStatus }): React.JSX.Element {
  if (status.autoMemory.recent.length === 0) {
    return (
      <div className="section-empty-state" data-testid="memory-auto-empty">
        <strong>暂无自动写入记录</strong>
        <p>自动记忆写入、拒绝和清理记录会显示在这里。</p>
      </div>
    );
  }

  return (
    <div className="memory-auto-shell">
      <div className="memory-auto-records" data-testid="memory-auto-records">
        {status.autoMemory.recent.map((record) => (
          <article className="memory-auto-record" key={record.id}>
            <div className="memory-auto-meta">
              <span>{record.action}</span>
              <span>{record.type}</span>
              <span>{record.scope}</span>
              <span>{record.confidence}</span>
            </div>
            <div className="memory-auto-summary">{record.summary}</div>
            <div className="memory-auto-sub">
              <span>{record.reason}</span>
              <span>{record.sourceRunId}</span>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
