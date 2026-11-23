import { useEffect, useState } from 'react';
import type { LayoutPreset } from './routes';
import {
  ASSISTANT_WIDTH, SIDEBAR_WIDTH, defaultWorkspaceLayout, readWorkspaceLayout, writeWorkspaceLayout,
  type WorkspaceLayoutPreference
} from './ui-state';

export const ACTIVITY_RAIL_WIDTH = 52;
export const CANVAS_MIN_WIDTH = 760;

export function layoutModeForWidth(width: number): 'wide' | 'balanced' | 'drawers' {
  return width >= 1440 ? 'wide' : width >= 1100 ? 'balanced' : 'drawers';
}

export type LayoutPersistence = ReturnType<typeof useLayoutPersistence>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function useLayoutPersistence(preset: LayoutPreset, projectId: string | null = null): {
  mode: ReturnType<typeof layoutModeForWidth>;
  preset: LayoutPreset;
  drawerWidth: number;
  drawerOpen: boolean;
  assistantWidth: number;
  assistantMaxWidth: number;
  assistantFloating: boolean;
  drawerFloating: boolean;
  setDrawerOpen: (open: boolean) => void;
  toggleDrawer: () => void;
  resizeDrawer: (width: number) => void;
  resizeAssistant: (width: number) => void;
  resetDrawer: () => void;
  resetAssistant: () => void;
  applyPreset: (preset: LayoutPreset) => void;
  reset: () => void;
} {
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const key = JSON.stringify([projectId, preset]);
  const [saved, setSaved] = useState(() => ({key, value: readWorkspaceLayout(projectId, preset)}));
  const current = saved.key === key ? saved.value : readWorkspaceLayout(projectId, preset);
  if (saved.key !== key) setSaved({key, value: current});
  const [floating, setFloating] = useState({key, open: false});
  const mode = layoutModeForWidth(windowWidth);
  const drawerWidth = current.sidebarWidth;
  const drawerOpen = mode !== 'drawers' ? !current.collapsed : floating.key === key && floating.open;
  const update = (patch: Partial<WorkspaceLayoutPreference>): void => {
    const value = {...current, ...patch};
    setSaved({key, value});
    writeWorkspaceLayout(projectId, preset, value);
  };
  const visibleDrawerWidth = Math.min(drawerWidth, Math.max(SIDEBAR_WIDTH.min, windowWidth - ACTIVITY_RAIL_WIDTH - CANVAS_MIN_WIDTH));
  const drawerInline = mode !== 'drawers' && drawerOpen;
  const assistantMaxWidth = clamp(
    windowWidth - ACTIVITY_RAIL_WIDTH - CANVAS_MIN_WIDTH - (drawerInline ? visibleDrawerWidth : 0),
    ASSISTANT_WIDTH.min, ASSISTANT_WIDTH.max);
  const requestedAssistantWidth = current.assistantWidth;
  const assistantFloating = mode !== 'wide' ||
    windowWidth - ACTIVITY_RAIL_WIDTH - (drawerInline ? visibleDrawerWidth : 0) - requestedAssistantWidth < CANVAS_MIN_WIDTH;

  useEffect(() => {
    const onResize = (): void => {
      if (layoutModeForWidth(window.innerWidth) !== mode) setFloating({key, open: false});
      setWindowWidth(window.innerWidth);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mode, key]);

  const setDrawerOpen = (open: boolean): void => {
    if (mode !== 'drawers') update({collapsed: !open});
    else setFloating({key, open});
  };
  const resetDrawer = (): void => update({sidebarWidth: SIDEBAR_WIDTH.default});
  const resetAssistant = (): void => update({assistantWidth: ASSISTANT_WIDTH.default});
  const applyPreset = (): void => setFloating({key, open: false});

  return {
    mode, preset, drawerWidth: visibleDrawerWidth, drawerOpen,
    drawerFloating: mode === 'drawers', assistantFloating,
    assistantWidth: clamp(requestedAssistantWidth, ASSISTANT_WIDTH.min, assistantFloating ? ASSISTANT_WIDTH.max : assistantMaxWidth),
    assistantMaxWidth,
    setDrawerOpen,
    toggleDrawer: () => setDrawerOpen(!drawerOpen),
    resizeDrawer: width => update({sidebarWidth: clamp(width, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max)}),
    resizeAssistant: width => {
      const next = clamp(width, ASSISTANT_WIDTH.min, assistantMaxWidth);
      update({assistantWidth: next});
    },
    resetDrawer, resetAssistant, applyPreset,
    reset: () => {
      update(defaultWorkspaceLayout(preset));
      setFloating({key, open: false});
    }
  };
}
