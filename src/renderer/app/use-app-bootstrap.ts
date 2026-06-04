import type React from 'react';
import { useEffect, useState } from 'react';
import type { AgentRuntimeStatus, AppStatus, RtkStatus, TaskSnapshot, WindowStateSnapshot, Workspace } from '../../shared/types';
import { emptyMemoryData, emptyOperationsData, emptyTaskSurfaceData, emptyWorkspaceData } from './empty-states';
import { loadSettingsState } from './data-loading';
import type { LoadedState } from '../loaded-state';
import { unwrap } from '../loaded-state';
import type { RocClient } from '../shared/roc-client';
import { applySystemAppearance } from '../system-appearance';

export interface AppBootstrap {
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setState: React.Dispatch<React.SetStateAction<LoadedState | null>>;
  setWindowState: React.Dispatch<React.SetStateAction<WindowStateSnapshot>>;
  state: LoadedState | null;
  windowState: WindowStateSnapshot;
}

export function useAppBootstrap(client: RocClient): AppBootstrap {
  const [state, setState] = useState<LoadedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowState, setWindowState] = useState<WindowStateSnapshot>({
    maximized: false,
    minimized: false,
    fullscreen: false
  });

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      const [appStatus, taskSnapshot, agent, workspace, rtkStatus, loadedWindowState, settingsSnapshot] = await Promise.all([
        client.api.app.getStatus(),
        client.api.tasks.getSnapshot(),
        client.api.agent.getStatus(),
        client.api.workspace.getCurrent(),
        client.api.rtk.status(),
        client.api.window.getState(),
        loadSettingsState()
      ]);

      const loadedWorkspace = unwrap<Workspace | null>('workspace', workspace);
      const loadedAppStatus = unwrap<AppStatus>('app status', appStatus);
      const refreshedAppStatus =
        loadedAppStatus.mode === 'smoke'
          ? unwrap<AppStatus>('refreshed app status', await client.api.app.getStatus())
          : loadedAppStatus;
      applySystemAppearance(refreshedAppStatus.appearance);
      const loadedAgent =
        loadedAppStatus.mode === 'smoke'
          ? unwrap<AgentRuntimeStatus>('refreshed agent', await client.api.agent.getStatus())
          : unwrap<AgentRuntimeStatus>('agent', agent);
      const selectedMcpServers = settingsSnapshot.mcpServers.filter((server) => server.enabled).map((server) => server.id);
      const selectedSkills = settingsSnapshot.skills.filter((skill) => skill.enabled && skill.status === 'ready').map((skill) => skill.id);

      if (cancelled) {
        return;
      }

      setWindowState(unwrap<WindowStateSnapshot>('window state', loadedWindowState));
      setState({
        appStatus: refreshedAppStatus,
        taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
        ...settingsSnapshot,
        selectedMcpServers,
        selectedSkills,
        ...emptyTaskSurfaceData(),
        ...emptyOperationsData(refreshedAppStatus.mode),
        agent: loadedAgent,
        agentCapabilityPreview: null,
        workspace: loadedWorkspace,
        rtkStatus: unwrap<RtkStatus>('rtk status', rtkStatus),
        ...emptyWorkspaceData(),
        ...emptyMemoryData()
      });
    }

    load().catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : 'Roc renderer failed to load.');
    });

    return () => {
      cancelled = true;
    };
  }, [client]);

  return { error, setError, setState, setWindowState, state, windowState };
}
