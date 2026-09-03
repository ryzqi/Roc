import type { MemoryStatus } from '../../../shared/types';
import { formatAction, formatConfidence, formatScope, formatType, truncatePath } from './formatters';

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
        {status.autoMemory.recent.map((record) => {
          const actionDisplay = formatAction(record.action);
          const displayPath = record.targetPath !== null ? truncatePath(record.targetPath) : '未写入文件';
          return (
            <article className="memory-auto-record" key={record.id}>
              <div className="memory-auto-meta">
                <span className={`memory-auto-action ${actionDisplay.className}`}>{actionDisplay.text}</span>
                <span>{formatType(record.type)}</span>
                <span>{formatScope(record.scope)}</span>
                <span>{formatConfidence(record.confidence)}</span>
                <span title={record.targetPath ?? undefined}>{displayPath}</span>
              </div>
              <div className="memory-auto-summary">{record.summary}</div>
              <div className="memory-auto-sub">
                <span>{record.reason}</span>
                <span>{record.sourceRunId}</span>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
