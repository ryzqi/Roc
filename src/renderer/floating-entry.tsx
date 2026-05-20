import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import type { AppStatus, AgentRuntimeStatus, RtkStatus, TaskSnapshot, TraySummary, WindowStateSnapshot } from '../shared/types';
import { emptyMemoryData, emptyOperationsData, emptyTaskSurfaceData, emptyWorkspaceData } from './app/empty-states';
import { parseViewId } from './app/view-routing';
import { unwrap, type LoadedState } from './loaded-state';
import { loadSettingsState } from './app/data-loading';
import { QuickEntryView } from './views/floating/QuickEntryView';
import { TrayEntryView } from './views/floating/TrayEntryView';
import './styles/index.css';
import 'highlight.js/styles/github.css';

function buildFloatingLoadedState(input: {
  agent: AgentRuntimeStatus;
  appStatus: AppStatus;
  rtkStatus: RtkStatus;
  settingsState: Awaited<ReturnType<typeof loadSettingsState>>;
  taskSnapshot: TaskSnapshot;
  traySummary: TraySummary;
  windowState: WindowStateSnapshot;
}): LoadedState {
  return {
    appStatus: input.appStatus,
    taskSnapshot: input.taskSnapshot,
    ...emptyMemoryData(),
    ...input.settingsState,
    selectedMcpServers: input.settingsState.mcpServers.filter((server) => server.enabled).map((server) => server.id),
    selectedSkills: input.settingsState.skills.filter((skill) => skill.enabled && skill.status === 'ready').map((skill) => skill.id),
    ...emptyTaskSurfaceData(),
    ...emptyOperationsData(input.appStatus.mode),
    agent: input.agent,
    agentCapabilityPreview: null,
    workspace: null,
    ...emptyWorkspaceData(),
    rtkStatus: input.rtkStatus,
    backgroundTask: null,
    backgroundTasks: [],
    traySummary: input.traySummary,
    windowState: input.windowState
  } as LoadedState & { windowState: WindowStateSnapshot };
}

function FloatingEntryApp(): React.JSX.Element {
  const activeView = parseViewId(new URLSearchParams(window.location.search).get('page'));
  const [state, setState] = useState<LoadedState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      const [appStatus, taskSnapshot, agent, rtkStatus, settingsState, traySummary, windowState] = await Promise.all([
        window.roc.app.getStatus(),
        window.roc.tasks.getSnapshot(),
        window.roc.agent.getStatus(),
        window.roc.rtk.status(),
        loadSettingsState(),
        window.roc.lifecycle.getTraySummary(),
        window.roc.window.getState()
      ]);

      if (cancelled) {
        return;
      }

      setState(
        buildFloatingLoadedState({
          appStatus: unwrap<AppStatus>('app status', appStatus),
          taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
          agent: unwrap<AgentRuntimeStatus>('agent', agent),
          rtkStatus: unwrap<RtkStatus>('rtk status', rtkStatus),
          settingsState,
          traySummary: unwrap<TraySummary>('tray summary', traySummary),
          windowState: unwrap<WindowStateSnapshot>('window state', windowState)
        })
      );
    }

    load().catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : 'Roc floating entry failed to load.');
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return window.roc.tasks.onUpdated(() => {
      void Promise.all([window.roc.tasks.getSnapshot(), window.roc.lifecycle.getTraySummary()]).then(([taskSnapshot, traySummary]) => {
        setState((current) =>
          current === null
            ? current
            : {
                ...current,
                taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
                traySummary: unwrap<TraySummary>('tray summary', traySummary)
              }
        );
      });
    });
  }, []);

  if (error !== null) {
    return <div className="fatal">Roc 启动失败：{error}</div>;
  }

  if (state === null) {
    return <div className="boot">Roc 正在加载浮动入口</div>;
  }

  if (activeView === 'tray') {
    return (
      <main className="floating-stage" data-testid="floating-tray">
        <TrayEntryView state={state} updateLoadedState={(partial) => setState((current) => (current === null ? current : { ...current, ...partial }))} />
      </main>
    );
  }

  return (
    <main className="floating-stage" data-testid="floating-quick">
      <QuickEntryView
        onSubmitChatTask={async (input) => {
          const result = await window.roc.chat.startRun({
            input,
            mode: 'task',
            enabledCapabilities: {
              mcpServers: state.selectedMcpServers,
              skills: state.selectedSkills
            }
          });
          if (!result.ok) {
            return { ok: false as const, error: result.error.message };
          }
          return { ok: true as const };
        }}
        state={state}
      />
    </main>
  );
}

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Renderer root element is missing.');
}

createRoot(root).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <FloatingEntryApp />
    </MotionConfig>
  </React.StrictMode>
);
