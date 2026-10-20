import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Loader2, RefreshCw, TerminalSquare } from 'lucide-react';
import type { TerminalSessionSnapshot } from '../../../shared/types';
import { useWorkspaceScope } from '../../app/workspace-scope';
import type { RocClient } from '../../shared/roc-client';
import { EmptyState } from '../../shell/EmptyState';
import { ErrorBar } from '../../shell/ErrorBar';
import { useRtkStatus } from '../../workspace/use-rtk-status';

/**
 * Embedded terminal (P3/T3.6) — a real PTY session, not a replay.
 *
 * `terminal.createSession` opens a pty on the main process; output arrives as
 * `terminal.onOutput` events and keystrokes go back through
 * `terminal.writeInput`. The session key is the bound workspace, so switching
 * projects closes the old pty and starts a new one in the new directory — the
 * "no data may leak across projects" rule of gate 6 applies to a shell process
 * more than to anything else in the app.
 *
 * Details that are easy to get wrong, and are therefore explicit here:
 *
 *   - **Geometry before creation.** The terminal is opened and fitted first, then
 *     `createSession` is given the *measured* `cols`/`rows`. Creating the session
 *     with guessed numbers and resizing afterwards makes the first prompt wrap
 *     oddly, and the pty's line editor would already be running with wrong
 *     dimensions.
 *   - **Resize through the fit addon**, driven by a `ResizeObserver` on the host:
 *     `fit()` recomputes rows/cols from the new box, and only then does
 *     `terminal.resize` tell the pty. Window resizes therefore keep the prompt
 *     geometry in sync (gate 5).
 *   - **Output is filtered by session id.** Events are broadcast to the renderer,
 *     so echoing another session's bytes is a one-line mistake with confusing
 *     symptoms.
 *   - **The terminal is always dark** (`--terminal-bg`): the theme is read from
 *     the token layer at mount, never hard-coded, and the light theme does not
 *     override it.
 *   - **Copy and paste are left to the system.** xterm's own clipboard handling
 *     plus the native Edit-menu roles cover ⌘C/⌘V; intercepting keys here would
 *     break ⌘K-style passthrough and is exactly what the plan forbids.
 *
 * ## Not ported: 「在终端里运行这个脚本」
 *
 * The canvas has one hand-off on this surface: a plot/script panel calls
 * `onRunScriptInTerminal(code)`, which switches to the terminal tab with a command
 * prefilled (`python src/plot_benchmarks.py`) and the terminal runs it on mount
 * (`initialCommand`).
 *
 * That has no counterpart here, and the reason is structural rather than an omission:
 * the command has to travel from the caller to this view, and every route for it is closed.
 *
 *   - **A route parameter** (`?view=terminal&run=…`) would extend the frozen route
 *     contract and its round-trip tests for a once-per-run hand-off.
 *   - **A new prefill entry in the workspace scope** means inventing the caller as well:
 *     this build has no plot panel that owns a script path — experiments and figures are
 *     records in the backend, and the script that produced them is not addressable from
 *     the renderer (the same reason the reader cannot embed the source PDF, B16).
 *
 * The user path is not lost, it is just not automated: the workspace file tree opens the
 * script and the terminal is right next to it, and the agent can run it through
 * `run_shell_command` (each call visible, and subject to its own approval policy). Recorded
 * so the next person does not read this file and conclude nobody noticed.
 */

export type TerminalSessionViewProps = {
  client: RocClient;
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

export function TerminalSessionView({ client, workspacePath, writable }: TerminalSessionViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<TerminalSessionSnapshot | null>(null);
  const [phase, setPhase] = useState<SessionPhase>(workspacePath === null ? 'error' : 'starting');
  const [error, setError] = useState<string | null>(null);
  const [sessionNonce, setSessionNonce] = useState(0);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const rtk = useRtkStatus(client, workspacePath !== null && writable);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || workspacePath === null || !writable) {
      return;
    }

    setPhase('starting');
    setError(null);
    setSession(null);
    setExitCode(null);

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
    fitAddon.fit();
    terminal.focus();

    let disposed = false;
    let sessionId: string | null = null;

    const onOutputDispose = client.api.terminal.onOutput((event) => {
      if (event.sessionId !== sessionId) {
        return;
      }
      terminal.write(event.data);
    });

    const onExitDispose = client.api.terminal.onExit((event) => {
      if (event.sessionId !== sessionId) {
        return;
      }
      sessionId = null;
      setPhase('exited');
      setExitCode(event.exitCode);
      setSession((current) =>
        current === null ? current : { ...current, status: 'exited', exitCode: event.exitCode }
      );
      terminal.write(`\r\n[进程已退出，退出码 ${event.exitCode ?? '未知'}]\r\n`);
    });

    const dataDisposable = terminal.onData((data) => {
      if (sessionId === null) {
        return;
      }
      void client.api.terminal.writeInput({ sessionId, data });
    });

    /**
     * Pushes the measured geometry to the pty and stores the snapshot back.
     *
     * The write-back is not cosmetic: `terminal.resize` answers with the new
     * `TerminalSessionSnapshot`, and the footer renders `cols x rows` from it. Firing
     * the call and dropping the result leaves the pty correctly resized while the
     * footer keeps claiming the old size — and it makes "did the resize reach the
     * pty?" unobservable from the UI (which is exactly what the P3 gate checks).
     */
    const pushGeometry = (): void => {
      if (sessionId === null) {
        return;
      }
      void client.api.terminal
        .resize({ sessionId, cols: Math.max(20, terminal.cols), rows: Math.max(5, terminal.rows) })
        .then((result) => {
          if (!disposed && result.ok && result.data.id === sessionId) {
            setSession(result.data);
          }
        });
    };

    const resizeObserver = new ResizeObserver(() => {
      if (disposed) {
        return;
      }
      fitAddon.fit();
      pushGeometry();
    });
    resizeObserver.observe(host);

    void (async () => {
      const result = await client.api.terminal.createSession({
        cwd: workspacePath,
        cols: Math.max(20, terminal.cols),
        rows: Math.max(5, terminal.rows)
      });
      if (disposed) {
        if (result.ok) {
          // The panel closed while the pty was starting: release it instead of
          // leaking a shell process per unmount.
          void client.api.terminal.closeSession({ sessionId: result.data.id });
        }
        return;
      }
      if (!result.ok) {
        setPhase('error');
        setError(result.error.message);
        return;
      }
      sessionId = result.data.id;
      setSession(result.data);
      setPhase('ready');
      // The pty was created with the measured geometry; re-fit and push once more in
      // case the first layout pass changed the host's size while the session started.
      fitAddon.fit();
      pushGeometry();
    })();

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      dataDisposable.dispose();
      onOutputDispose();
      onExitDispose();
      if (sessionId !== null) {
        void client.api.terminal.closeSession({ sessionId });
      }
      sessionId = null;
      terminal.dispose();
    };
  }, [client, workspacePath, writable, sessionNonce]);

  const restart = useCallback(() => {
    setSessionNonce((value) => value + 1);
  }, []);

  if (workspacePath === null) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="terminal-view">
        <EmptyState
          icon={TerminalSquare}
          title="未绑定工作目录"
          description="终端需要一个工作目录作为起始路径。先在项目里选择目录。"
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
          description="项目已归档，仅可阅读。恢复项目后才能打开交互式终端。"
          testId="terminal-readonly"
        />
      </div>
    );
  }

  const statusLabel =
    phase === 'starting'
      ? '正在启动会话…'
      : phase === 'ready'
        ? '会话运行中'
        : phase === 'exited'
          ? `会话已退出（退出码 ${exitCode ?? '未知'}）`
          : '会话启动失败';

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--terminal-bg)]" data-testid="terminal-view" data-phase={phase}>
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
          className="h-full w-full px-1.5 py-1"
        />
        {phase === 'starting' ? (
          <p
            className="pointer-events-none absolute left-3 top-2 flex items-center gap-2 text-[var(--terminal-text)] text-[var(--font-meta-size)]"
            role="status"
          >
            <Loader2 size={12} aria-hidden="true" className="animate-spin" />
            正在启动 {session?.shell ?? 'shell'}…
          </p>
        ) : null}
      </div>

      <div
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-[var(--terminal-line)] px-2 py-1 text-[var(--terminal-text)] text-[var(--font-micro-size)]"
        data-testid="terminal-footer"
      >
        <span className="min-w-0 flex-1 truncate font-mono" data-testid="terminal-cwd" title={session?.cwd ?? workspacePath}>
          {session?.cwd ?? workspacePath}
        </span>
        <span data-testid="terminal-status" data-phase={phase}>
          {statusLabel}
        </span>
        <span className="font-mono" data-testid="terminal-geometry">
          {terminalGeometryLabel(session)}
        </span>
        {phase === 'exited' || phase === 'error' ? (
          <button
            type="button"
            onClick={restart}
            data-testid="terminal-restart"
            className="flex items-center gap-1 rounded-control px-1.5 text-[var(--terminal-text)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
          >
            <RefreshCw size={11} aria-hidden="true" />
            重新连接
          </button>
        ) : null}
        {rtk.status === 'idle' ? null : (
          <span
            data-testid="terminal-rtk-status"
            data-tone={rtk.summary?.tone ?? 'muted'}
            title={rtk.summary?.detail ?? rtk.error ?? ''}
            className={rtk.summary?.tone === 'warn' ? 'text-[var(--st-warn)]' : 'opacity-80'}
          >
            {rtk.status === 'loading' ? 'RTK 状态读取中…' : rtk.status === 'error' ? 'RTK 状态不可用' : rtk.summary?.label}
          </span>
        )}
      </div>
    </div>
  );
}

/** `80x24`, or a dash until the session reports its geometry. */
function terminalGeometryLabel(session: TerminalSessionSnapshot | null): string {
  if (session === null) {
    return '—';
  }
  return `${session.cols}x${session.rows}`;
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
      workspacePath={scope.workspacePath}
      writable={scope.writable}
    />
  );
}
