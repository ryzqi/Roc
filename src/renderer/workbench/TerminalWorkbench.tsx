import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type {
  TerminalSessionExitEvent,
  TerminalSessionOutputEvent,
  TerminalSessionSnapshot,
  WindowStateSnapshot
} from '../../shared/types';
import { EmptyState } from '../components/EmptyState';
import type { WorkspaceData } from '../app/types';
import type { LoadedState } from '../loaded-state';

export function TerminalWorkbench({
  state,
  updateWorkspaceData,
  windowState: _windowState
}: {
  state: LoadedState;
  updateWorkspaceData: (partial: Partial<WorkspaceData>) => void;
  windowState: WindowStateSnapshot;
}): React.JSX.Element {
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<TerminalSessionSnapshot | null>(null);

  useEffect(() => {
    if (state.workspace === null || terminalHostRef.current === null) {
      updateWorkspaceData({
        terminalSession: null,
        terminalError: state.workspace === null ? '请先选择工作区。' : null
      });
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      letterSpacing: 0,
      scrollback: 5000,
      allowProposedApi: true,
      minimumContrastRatio: 4.5,
      theme: {
        background: '#0b121f',
        foreground: '#dce4ef',
        cursor: '#7aa7ff',
        cursorAccent: '#0b121f',
        selectionBackground: 'rgba(122, 167, 255, 0.28)',
        black: '#1f2430',
        red: '#e06c75',
        green: '#98c379',
        yellow: '#e5c07b',
        blue: '#61afef',
        magenta: '#c678dd',
        cyan: '#56b6c2',
        white: '#dce4ef',
        brightBlack: '#5c6773',
        brightRed: '#ef8a96',
        brightGreen: '#b4d39a',
        brightYellow: '#f0d399',
        brightBlue: '#82c0f5',
        brightMagenta: '#d7a3e8',
        brightCyan: '#7fcdd5',
        brightWhite: '#ffffff'
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalHostRef.current);
    fitAddon.fit();
    terminal.focus();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    let disposed = false;

    const onOutputDispose = window.roc.terminal.onOutput((event: TerminalSessionOutputEvent) => {
      if (event.sessionId !== sessionRef.current?.id) {
        return;
      }
      terminal.write(event.data);
    });
    const onExitDispose = window.roc.terminal.onExit((event: TerminalSessionExitEvent) => {
      if (event.sessionId !== sessionRef.current?.id) {
        return;
      }
      updateWorkspaceData({
        terminalSession: sessionRef.current === null
          ? null
          : {
              ...sessionRef.current,
              status: 'exited',
              exitCode: event.exitCode
            },
        terminalError: `终端会话已退出，退出码 ${event.exitCode}。`
      });
      terminal.write(`\r\n[session exited: ${event.exitCode}]\r\n`);
    });

    void window.roc.terminal
      .createSession({
        cwd: state.workspace.path,
        cols: Math.max(80, Math.floor((terminalHostRef.current.clientWidth || 720) / 9)),
        rows: Math.max(24, Math.floor((terminalHostRef.current.clientHeight || 420) / 18))
      })
      .then((result) => {
        if (!result.ok || disposed) {
          if (!result.ok) {
            updateWorkspaceData({ terminalSession: null, terminalError: result.error.message });
          }
          return;
        }
        sessionRef.current = result.data;
        updateWorkspaceData({ terminalSession: result.data, terminalError: null });
        fitAddon.fit();
        const nextCols = Math.max(20, terminal.cols);
        const nextRows = Math.max(5, terminal.rows);
        void window.roc.terminal.resize({
          sessionId: result.data.id,
          cols: nextCols,
          rows: nextRows
        }).then((resizeResult) => {
          if (resizeResult.ok && sessionRef.current?.id === resizeResult.data.id) {
            sessionRef.current = resizeResult.data;
            updateWorkspaceData({ terminalSession: resizeResult.data });
          }
        });
      });

    const resizeObserver = new ResizeObserver(() => {
      if (terminalRef.current === null || fitAddonRef.current === null) {
        return;
      }
      fitAddonRef.current.fit();
      if (sessionRef.current === null) {
        return;
      }
      void window.roc.terminal.resize({
        sessionId: sessionRef.current.id,
        cols: Math.max(20, terminalRef.current.cols),
        rows: Math.max(5, terminalRef.current.rows)
      }).then((result) => {
        if (result.ok && sessionRef.current?.id === result.data.id) {
          sessionRef.current = result.data;
          updateWorkspaceData({ terminalSession: result.data });
        }
      });
    });
    resizeObserver.observe(terminalHostRef.current);

    const keyDisposable = terminal.onData((data) => {
      if (sessionRef.current === null) {
        return;
      }
      void window.roc.terminal.writeInput({
        sessionId: sessionRef.current.id,
        data
      });
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      keyDisposable.dispose();
      onOutputDispose();
      onExitDispose();
      const sessionId = sessionRef.current?.id;
      if (sessionId !== undefined) {
        void window.roc.terminal.closeSession({ sessionId });
      }
      sessionRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [state.workspace?.path, updateWorkspaceData]);

  if (state.workspace === null) {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState testId="workbench-terminal-empty" title="未选择工作区" />
      </section>
    );
  }

  const terminalStatusLabel = state.terminalSession === null ? 'starting' : state.terminalSession.status;
  const terminalFooterStatus = state.terminalError;

  return (
    <section className="tool-panel workbench-surface workbench-surface--terminal">
      <div className="workbench-terminal">
        <div className="terminal-shell-frame">
          <div className="terminal-shell-topline">
            <span className="terminal-dot terminal-dot--danger" />
            <span className="terminal-dot terminal-dot--warn" />
            <span className="terminal-dot terminal-dot--ok" />
            <span className="terminal-shell-title">{state.terminalSession?.shell ?? 'PowerShell'}</span>
          </div>
          <div className="terminal-xterm-shell" data-testid="terminal-session-surface">
            <div ref={terminalHostRef} className="terminal-xterm-host" data-testid="terminal-xterm" />
          </div>
        </div>
        <footer className="workbench-footer-bar terminal-status-bar">
          <span data-role="path">{state.terminalSession?.cwd ?? state.workspace.path}</span>
          {terminalFooterStatus === null ? null : <span data-role="status" data-state={terminalStatusLabel}>{terminalFooterStatus}</span>}
        </footer>
      </div>
    </section>
  );
}
