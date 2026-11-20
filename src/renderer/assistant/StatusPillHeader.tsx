import { Bot, ChevronDown, Loader2, Minimize2, Plus } from 'lucide-react';
import type { ChatRunState } from './run-state';

export type StatusPillHeaderProps = {
  projectName: string | null;
  conversationTitle: string | null;
  stageLabel?: string | null;
  runStatus: ChatRunState['status'];
  statusLabel: string | null;
  messageCount: number;
  timelineOpen: boolean;
  onToggleTimeline: () => void;
  onNewThread?: () => void;
  onResetWidth?: () => void;
};

export function StatusPillHeader({projectName, conversationTitle, stageLabel, runStatus, statusLabel, messageCount, timelineOpen, onToggleTimeline, onNewThread, onResetWidth}: StatusPillHeaderProps): React.JSX.Element {
  const running = runStatus === 'running' || runStatus === 'recovering';
  const failed = runStatus === 'failed';
  const summary = statusLabel ?? conversationTitle ?? stageLabel ?? projectName ?? '未进入项目';
  return <header className="assistant-status-header relative flex h-10 shrink-0 items-center gap-2 border-b-[0.5px] border-line-default px-3" data-testid="assistant-status-header">
    <Bot size={14} aria-hidden="true" className="shrink-0 text-[var(--icon-agent)]" />
    <span className="assistant-context min-w-0 flex-1 truncate font-medium text-ink-primary" data-testid="assistant-context" title={conversationTitle ?? '研究助手'}>{conversationTitle ?? '研究助手'}</span>
    {onNewThread === undefined ? null : <button type="button" onClick={onNewThread} aria-label="新建会话" title="新建会话" data-testid="assistant-new-thread" className="flex size-7 shrink-0 items-center justify-center rounded-control text-ink-muted hover:bg-[var(--overlay-hover)] hover:text-ink-primary active:bg-[var(--overlay-active)]"><Plus size={14} aria-hidden="true" /></button>}
    {onResetWidth === undefined ? null : <button type="button" onClick={onResetWidth} aria-label="重置助手宽度" title="重置助手宽度" data-testid="assistant-reset-width" className="flex size-7 shrink-0 items-center justify-center rounded-control text-ink-muted hover:bg-[var(--overlay-hover)] hover:text-ink-primary active:bg-[var(--overlay-active)]"><Minimize2 size={13} aria-hidden="true" /></button>}
    <button type="button" onClick={onToggleTimeline} aria-expanded={timelineOpen} aria-controls="assistant-execution-timeline" data-testid="assistant-status-pill" className={`assistant-status-pill flex min-w-0 max-w-[55%] items-center gap-1 rounded-control border-[0.5px] px-2 py-1 text-[length:var(--font-micro-size)] ${failed ? 'border-[var(--st-bad-line)] text-[var(--st-bad)]' : 'border-line-default text-ink-muted'}`} title={summary}>
      {running ? <Loader2 size={11} aria-hidden="true" className="shrink-0 animate-spin" /> : null}
      {statusLabel === null ? <span className="min-w-0 truncate">{summary}</span> : <span className="min-w-0 truncate" data-testid="assistant-run-status" data-status={runStatus}>{summary}</span>}
      <ChevronDown size={11} aria-hidden="true" className={`shrink-0 transition-transform motion-reduce:transition-none ${timelineOpen ? 'rotate-180' : ''}`} />
    </button>
    <span className="shrink-0 font-mono tabular-nums text-ink-muted text-[length:var(--font-micro-size)]" data-testid="assistant-message-count">{messageCount} 条</span>
  </header>;
}
