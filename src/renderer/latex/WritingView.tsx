import { useEffect, useState } from 'react';
import { FileText, FileDiff, Terminal } from 'lucide-react';
import { useWorkspaceScope } from '../app/workspace-scope';
import { useViewSelected, ViewActivity } from '../shared/view-activity';
import { DelayedFallback } from '../shell/DelayedFallback';
import { LazyBoundary, retryableLazy } from '../shell/LazyBoundary';
import { LatexPanel } from './LatexPanel';

const TerminalView = retryableLazy(async () => ({ default: (await import('../canvas/terminal/TerminalView')).TerminalView }));
const ManuscriptSyncPanel = retryableLazy(async () => ({ default: (await import('./ManuscriptSyncPanel')).ManuscriptSyncPanel }));

/** Switching tools retains editor drafts and the existing PTY session. */
export function WritingView(): React.JSX.Element {
  const scope = useWorkspaceScope();
  const active = useViewSelected();
  const syncKey = JSON.stringify([scope.projectId, scope.workspacePath]);
  const [sync, setSync] = useState<{scope: string; open: boolean} | null>(null);
  const syncOpen = active && sync?.scope === syncKey && sync.open;
  const terminalOpen = scope.tool === 'terminal';
  const [terminalVisited, setTerminalVisited] = useState(terminalOpen);
  useEffect(() => {
    if (terminalOpen) setTerminalVisited(true);
  }, [terminalOpen]);

  return <section className="flex h-full min-h-0 flex-col" aria-label="写作" data-testid="writing-workspace">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b-[0.5px] border-line px-3 py-2" role="group" aria-label="写作工具">
      <button type="button" onClick={() => scope.openTool(null)} aria-pressed={!terminalOpen} data-testid="writing-editor"
        className="flex h-7 items-center gap-2 rounded-control px-2 text-muted hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] aria-pressed:bg-[var(--overlay-active)] aria-pressed:text-ink">
        <FileText size={14} aria-hidden="true" />正文
      </button>
      <button type="button" onClick={() => scope.openTool('terminal')} aria-pressed={terminalOpen} data-testid="writing-terminal"
        className="flex h-7 items-center gap-2 rounded-control px-2 text-muted hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] aria-pressed:bg-[var(--overlay-active)] aria-pressed:text-ink">
        <Terminal size={14} aria-hidden="true" />终端
      </button>
      {scope.projectId === null || scope.workspacePath === null ? null : <button type="button" aria-haspopup="dialog"
        className="flex h-7 items-center gap-2 rounded-control px-2 text-muted hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-focus-ring"
        data-testid="writing-manuscript-sync" onClick={() => setSync({scope: syncKey, open: true})}>
        <FileDiff size={14} aria-hidden="true" />稿件同步
      </button>}
    </div>
    <div className="min-h-0 flex-1" hidden={terminalOpen}>
      <ViewActivity active={!terminalOpen}><LatexPanel /></ViewActivity>
    </div>
    {terminalVisited || terminalOpen ? <div className="min-h-0 flex-1" hidden={!terminalOpen} dir="ltr">
      <ViewActivity active={terminalOpen}>
        <LazyBoundary label="终端加载失败" fallback={<DelayedFallback label="正在打开终端…" />}><TerminalView /></LazyBoundary>
      </ViewActivity>
    </div> : null}
    {scope.projectId === null || sync?.scope !== syncKey ? null : <LazyBoundary key={syncKey} label="稿件同步加载失败"
      fallback={<DelayedFallback label="正在打开稿件同步…" />}>
      <ManuscriptSyncPanel projectId={scope.projectId} open={syncOpen} onClose={() => setSync({scope: syncKey, open: false})}/>
    </LazyBoundary>}
  </section>;
}
