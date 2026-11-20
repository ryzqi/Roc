import { useEffect, useState } from 'react';
import { FileText, Terminal } from 'lucide-react';
import { useWorkspaceScope } from '../app/workspace-scope';
import { ViewActivity } from '../shared/view-activity';
import { DelayedFallback } from '../shell/DelayedFallback';
import { LazyBoundary, retryableLazy } from '../shell/LazyBoundary';
import { LatexPanel } from './LatexPanel';

const TerminalView = retryableLazy(async () => ({ default: (await import('../canvas/terminal/TerminalView')).TerminalView }));

/** Switching tools retains editor drafts and the existing PTY session. */
export function WritingView(): React.JSX.Element {
  const scope = useWorkspaceScope();
  const terminalOpen = scope.tool === 'terminal';
  const [terminalVisited, setTerminalVisited] = useState(terminalOpen);
  useEffect(() => {
    if (terminalOpen) setTerminalVisited(true);
  }, [terminalOpen]);

  return <section className="flex h-full min-h-0 flex-col" aria-label="写作" data-testid="writing-workspace">
    <div className="flex shrink-0 items-center gap-2 border-b-[0.5px] border-line px-3 py-2" role="group" aria-label="写作工具">
      <button type="button" onClick={() => scope.openTool(null)} aria-pressed={!terminalOpen} data-testid="writing-editor"
        className="flex h-7 items-center gap-2 rounded-control px-2 text-muted hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] aria-pressed:bg-[var(--overlay-active)] aria-pressed:text-ink">
        <FileText size={14} aria-hidden="true" />正文
      </button>
      <button type="button" onClick={() => scope.openTool('terminal')} aria-pressed={terminalOpen} data-testid="writing-terminal"
        className="flex h-7 items-center gap-2 rounded-control px-2 text-muted hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] aria-pressed:bg-[var(--overlay-active)] aria-pressed:text-ink">
        <Terminal size={14} aria-hidden="true" />终端
      </button>
    </div>
    <div className="min-h-0 flex-1" hidden={terminalOpen}>
      <ViewActivity active={!terminalOpen}><LatexPanel /></ViewActivity>
    </div>
    {terminalVisited || terminalOpen ? <div className="min-h-0 flex-1" hidden={!terminalOpen} dir="ltr">
      <ViewActivity active={terminalOpen}>
        <LazyBoundary label="终端加载失败" fallback={<DelayedFallback label="正在打开终端…" />}><TerminalView /></LazyBoundary>
      </ViewActivity>
    </div> : null}
  </section>;
}
