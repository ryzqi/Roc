import '../tools-workspace.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { RefreshCw, TerminalSquare } from 'lucide-react';
import type { TerminalSessionSnapshot, TerminalSessionOutputEvent, TerminalSessionExitEvent, TerminalSessionAttachment } from '../../../shared/types';
import { useWorkspaceScope } from '../../app/workspace-scope';
import type { RocClient } from '../../shared/roc-client';
import { EmptyState } from '../../shell/EmptyState';
import { ErrorBar } from '../../shell/ErrorBar';
import {ConfirmDialog} from '../../shell/ConfirmDialog';
import {useViewActive} from '../../shared/view-activity';
import {TerminalOutputCursor} from './terminal-output-cursor';
import {ActionStatus} from '../../shared/action-status';

/** The main process owns PTYs; this view owns only an attached xterm display. */
export type TerminalSessionViewProps = {
  client: RocClient;
  projectId?: string | null;
  /** Absolute path of the bound workspace, or null when none is bound. */
  workspacePath: string | null;
  /** Archived projects are read-only — see the gate in `TerminalView`. */
  writable: boolean;
};

type SessionPhase = 'starting' | 'ready' | 'exited' | 'error';

/** xterm reads concrete colours; they come from the token layer, not from here. */
function readTerminalTheme(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string): string => {
    const raw = styles.getPropertyValue(name).trim();
    return raw.length === 0 ? fallback : raw;
  };
  return {
    background: value('--terminal-bg', '#0c121e'),
    foreground: value('--terminal-text', '#dce4ef'),
    cursor: value('--terminal-cursor', '#7aa7ff'),
    cursorAccent: value('--terminal-bg', '#0c121e'),
    selectionBackground: value('--terminal-selection', 'rgba(122, 167, 255, 0.28)'),
    black: value('--term-ansi-black', '#1f2430'),
    red: value('--term-ansi-red', '#e06c75'),
    green: value('--term-ansi-green', '#98c379'),
    yellow: value('--term-ansi-yellow', '#e5c07b'),
    blue: value('--term-ansi-blue', '#61afef'),
    magenta: value('--term-ansi-magenta', '#c678dd'),
    cyan: value('--term-ansi-cyan', '#56b6c2'),
    white: value('--term-ansi-white', '#dce4ef'),
    brightBlack: value('--term-ansi-bright-black', '#5c6773'),
    brightRed: value('--term-ansi-bright-red', '#ef8a96'),
    brightGreen: value('--term-ansi-bright-green', '#b4d39a'),
    brightYellow: value('--term-ansi-bright-yellow', '#f0d399'),
    brightBlue: value('--term-ansi-bright-blue', '#82c0f5'),
    brightMagenta: value('--term-ansi-bright-magenta', '#d7a3e8'),
    brightCyan: value('--term-ansi-bright-cyan', '#7fcdd5'),
    brightWhite: value('--term-ansi-bright-white', '#ffffff')
  };
}

export function TerminalSessionView({ client, projectId = null, workspacePath, writable }: TerminalSessionViewProps): React.JSX.Element {
  const active = useViewActive();
  const attachmentRef = useRef<TerminalSessionAttachment | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal|null>(null);
  const [session, setSession] = useState<TerminalSessionSnapshot | null>(null);
  const [phase, setPhase] = useState<SessionPhase>(workspacePath === null ? 'error' : 'starting');
  const [error, setError] = useState<string | null>(null);
  const [sessionNonce, setSessionNonce] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!active || host === null || workspacePath === null || !writable) {
      return;
    }

    setPhase('starting');
    setError(null);
    setSession(null);
    setTruncated(false);
    setCloseOpen(false);
    setClosing(false);

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 5000,
      minimumContrastRatio: 4.5,
      theme: readTerminalTheme()
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddon.fit();
    terminal.focus();

    let disposed = false;
    let sessionId: string | null = null;
    let attachmentId: string | null = null;
    let cursor: TerminalOutputCursor | null = null;
    let queued: TerminalSessionOutputEvent[] = [];
    let queuedLength = 0;
    let queuedExit: TerminalSessionExitEvent | null = null;
    const writeOutput = (event: TerminalSessionOutputEvent): void => {
      const next = cursor?.accept(event);
      if (next === null || next === undefined) return;
      if (next.gap) {setTruncated(true); terminal.reset();}
      terminal.write(next.data);
    };
    const onOutputDispose = client.api.terminal.onOutput(event => {
      if (disposed) return;
      if (cursor !== null) {writeOutput(event); return;}
      queued.push(event);
      queuedLength += event.data.length;
      while (queuedLength > 256 * 1024 && queued.length > 1) queuedLength -= queued.shift()!.data.length;
      if (queuedLength > 256 * 1024) {
        const tail = queued[0]!;
        queued[0] = {...tail, startSequence: tail.sequence - 256 * 1024, data: tail.data.slice(-256 * 1024)};
        queuedLength = 256 * 1024;
      }
    });
    const exit = (event: TerminalSessionExitEvent): void => {
      if (event.sessionId !== sessionId || event.attachmentId !== attachmentId) return;
      setPhase('exited');
      setSession(current => current === null ? current : {...current, status: 'exited', exitCode: event.exitCode});
      if (attachmentRef.current) attachmentRef.current = {...attachmentRef.current,
        session: {...attachmentRef.current.session, status: 'exited', exitCode: event.exitCode}};
      terminal.write(`\r\n[进程已退出，退出码 ${event.exitCode ?? '未知'}]\r\n`);
    };
    const onExitDispose = client.api.terminal.onExit(event => {
      if (disposed) return;
      if (cursor === null) queuedExit = event;
      else exit(event);
    });

    const dataDisposable = terminal.onData((data) => {
      if (sessionId === null || attachmentId === null || attachmentRef.current?.session.status !== 'ready') {
        return;
      }
      void client.api.terminal.writeInput({ sessionId, projectId, attachmentId, data });
    });

    /**
     * Pushes the measured geometry to the pty and keeps the latest session snapshot.
     * The snapshot also supplies the shell and working directory shown by this view.
     */
    const pushGeometry = (): void => {
      if (sessionId === null || attachmentId === null || attachmentRef.current === null) {
        return;
      }
      void client.api.terminal
        .resize({ sessionId, projectId, attachmentId, cols: Math.max(20, terminal.cols), rows: Math.max(5, terminal.rows) })
        .then((result) => {
          if (!disposed && result.ok && result.data.id === sessionId) {
            setSession(result.data);
          }
        });
    };

    const resizeObserver = new ResizeObserver(() => {
      if (disposed || host.clientWidth === 0 || host.clientHeight === 0) {
        return;
      }
      fitAddon.fit();
      pushGeometry();
    });
    resizeObserver.observe(host);

    void (async () => {
      const result = await client.api.terminal.attachSession({
        projectId,
        cwd: workspacePath,
        cols: Math.max(20, terminal.cols),
        rows: Math.max(5, terminal.rows)
      });
      if (disposed) {
        if (result.ok) void client.api.terminal.detachSession({sessionId: result.data.session.id,
          projectId, attachmentId: result.data.attachmentId}).catch(() => {});
        return;
      }
      if (!result.ok) {
        setPhase('error');
        setError(result.error.message);
        return;
      }
      sessionId = result.data.session.id;
      attachmentId = result.data.attachmentId;
      attachmentRef.current = result.data;
      setSession(result.data.session);
      setPhase(result.data.session.status);
      cursor = new TerminalOutputCursor(sessionId, attachmentId, result.data.replay.sequence);
      if (result.data.replay.truncated) {setTruncated(true); terminal.reset();}
      terminal.write(result.data.replay.data);
      for (const event of queued) writeOutput(event);
      queued = [];
      if (queuedExit !== null) exit(queuedExit);
      // The pty was created with the measured geometry; re-fit and push once more in
      // case the first layout pass changed the host's size while the session started.
      fitAddon.fit();
      pushGeometry();
    })().catch(cause => {if (!disposed) {setPhase('error'); setError(cause instanceof Error ? cause.message : String(cause));}});

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      dataDisposable.dispose();
      onOutputDispose();
      onExitDispose();
      if (sessionId !== null && attachmentId !== null) {
        void client.api.terminal.detachSession({ sessionId, projectId, attachmentId }).catch(() => {});
      }
      attachmentRef.current = null;
      queued = [];
      sessionId = null;
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [active, client, projectId, workspacePath, writable, sessionNonce]);

  const restart = useCallback(async () => {
    const current = attachmentRef.current;
    try {
      if (current !== null) {
        const result = await client.api.terminal.closeSession({sessionId: current.session.id, projectId, attachmentId: current.attachmentId});
        if (attachmentRef.current?.attachmentId !== current.attachmentId) return;
        if (!result.ok) {setError(result.error.message); return;}
      }
      setSessionNonce(value => value + 1);
    } catch (cause) {
      if (attachmentRef.current?.attachmentId === current?.attachmentId) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client, projectId]);

  const endSession = async (): Promise<void> => {
    const current = attachmentRef.current;
    if (current === null || closing) return;
    setClosing(true);
    try {
      const result = await client.api.terminal.closeSession({sessionId: current.session.id, projectId, attachmentId: current.attachmentId});
      if (attachmentRef.current?.attachmentId !== current.attachmentId) return;
      if (!result.ok) {setError(result.error.message); return;}
      attachmentRef.current = null;
      setCloseOpen(false);
      setPhase('exited');
      terminalRef.current?.write('\r\n[会话已结束]\r\n');
    } catch (cause) {
      if (attachmentRef.current?.attachmentId === current.attachmentId) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (attachmentRef.current === null || attachmentRef.current.attachmentId === current.attachmentId) setClosing(false);
    }
  };

  if (workspacePath === null) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="terminal-view">
        <EmptyState
          icon={TerminalSquare}
          title="未绑定工作目录"
          testId="terminal-no-workspace"
        />
      </div>
    );
  }

  /**
   * Archived projects get no interactive shell.
   *
   * A pty is the most powerful write path in the app — typing `echo > f` in it
   * writes to the project directory — so leaving it open in a project the shell
   * banner calls "仅可阅读" would be an inconsistency the user cannot see through.
   * Commands the *agent* runs (`shell.execute`) are a different surface with its
   * own authorization, and are unaffected by this gate.
   */
  if (!writable) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="terminal-view" data-phase="readonly">
        <EmptyState
          icon={TerminalSquare}
          title="归档项目不提供终端"
          testId="terminal-readonly"
        />
      </div>
    );
  }

  return (
    <div dir="ltr" className="flex h-full min-h-0 flex-col bg-[var(--terminal-bg)]" data-testid="terminal-view" data-phase={phase}>
      <header className="tools-terminal-header">
        <TerminalSquare size={14} aria-hidden="true"/><h1>终端</h1>
        <span role="status">{phase==='ready'?'已连接':phase==='exited'?'已退出':phase==='error'?'连接失败':'连接中'}</span>
        <button type="button" disabled={phase!=='ready'} title="清除当前终端显示，不中断运行中的命令" data-testid="terminal-clear" onClick={()=>{terminalRef.current?.clear();terminalRef.current?.focus();}}>清屏</button>
        <button type="button" disabled={phase !== 'ready' || closing} data-testid="terminal-end" onClick={() => setCloseOpen(true)}>结束会话</button>
      </header>
      {truncated ? <p role="status" data-testid="terminal-replay-truncated" className="shrink-0 px-3 py-2 text-[var(--terminal-text)] text-xs">已恢复最近输出；更早内容超出回放容量，终端显示已重置。</p> : null}
      {error === null ? null : (
        <div className="shrink-0 p-2">
          <ErrorBar error={{ level: 'page', message: error, retry: restart }} />
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div
          ref={hostRef}
          data-testid="terminal-xterm"
          data-session-id={session?.id ?? ''}
          className="h-full w-full px-3 py-2"
        />
        {phase === 'starting' ? (
          <ActionStatus
            state="pending"
            announce={false}
            className="pointer-events-none absolute left-3 top-2 text-[var(--terminal-text)] text-[length:var(--font-meta-size)]"
          >
            正在启动 {session?.shell ?? 'shell'}…
          </ActionStatus>
        ) : null}
      </div>

      <ConfirmDialog open={active && closeOpen} title="结束终端会话" message="将终止此会话及正在运行的命令，未完成的工作可能丢失。"
        confirmLabel="结束会话" pending={closing} error={error} onConfirm={endSession} onCancel={() => setCloseOpen(false)} testId="terminal-end-confirm"/>
      <div
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-t-[0.5px] border-[var(--terminal-line)] px-2 py-1 text-[var(--terminal-text)] text-[length:var(--font-micro-size)]"
        data-testid="terminal-footer"
      >
        <span className="min-w-0 flex-1 truncate font-mono" data-testid="terminal-cwd" title={session?.cwd ?? workspacePath}>
          {session?.cwd ?? workspacePath}
        </span>
        {phase === 'exited' || phase === 'error' ? (
          <button
            type="button"
            onClick={restart}
            data-testid="terminal-restart"
            className="flex min-h-[var(--control-height-compact)] items-center gap-2 rounded-control px-2 text-[var(--terminal-text)] hover:bg-[var(--terminal-selection)] active:bg-[var(--overlay-active)]"
          >
            <RefreshCw size={11} aria-hidden="true" />
            重新连接
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The canvas `terminal` view.
 *
 * A thin scope reader around `TerminalSessionView`: the session view takes
 * explicit props so it can be rendered without the shell's context (and reasoned
 * about as "a pty bound to this directory"), while the view entry point is what
 * the view registry loads.
 */
export function TerminalView(): React.JSX.Element {
  const scope = useWorkspaceScope();
  return (
    <TerminalSessionView
      client={scope.client}
      projectId={scope.projectId}
      workspacePath={scope.workspacePath}
      writable={scope.writable}
    />
  );
}
