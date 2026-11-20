import { useEffect, useState } from 'react';
import type { LayoutPreset } from './routes';
import {
  ASSISTANT_WIDTH, SIDEBAR_WIDTH, readAssistantWidth, readSidebarCollapsed, readSidebarWidth,
  writeAssistantWidth, writeSidebarCollapsed, writeSidebarWidth
} from './ui-state';

export const ACTIVITY_RAIL_WIDTH = 52;
export const CANVAS_MIN_WIDTH = 520;
const REVIEW_WIDTH = 420;

export function layoutModeForWidth(width: number): 'wide' | 'balanced' | 'drawers' {
  return width >= 1360 ? 'wide' : width >= 1080 ? 'balanced' : 'drawers';
}

export type LayoutState = ReturnType<typeof useLayoutState>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function useLayoutState(preset: LayoutPreset): {
  mode: ReturnType<typeof layoutModeForWidth>;
  preset: LayoutPreset;
  drawerWidth: number;
  drawerOpen: boolean;
  assistantWidth: number;
  assistantMaxWidth: number;
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
  const [drawerWidth, setDrawerWidth] = useState(readSidebarWidth);
  const [assistantWidth, setAssistantWidth] = useState(readAssistantWidth);
  const [reviewWidth, setReviewWidth] = useState(REVIEW_WIDTH);
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [wideOverride, setWideOverride] = useState<{ preset: LayoutPreset; open: boolean } | null>(null);
  const [floatingOpen, setFloatingOpen] = useState(false);
  const mode = layoutModeForWidth(windowWidth);
  const drawerOpen = mode === 'wide'
    ? (wideOverride?.preset === preset ? wideOverride.open : preset !== 'review' && !collapsed)
    : floatingOpen;
  const drawerInline = mode === 'wide' && drawerOpen;
  const assistantMaxWidth = Math.max(ASSISTANT_WIDTH.min,
    windowWidth - ACTIVITY_RAIL_WIDTH - CANVAS_MIN_WIDTH - (drawerInline ? drawerWidth : 0));

  useEffect(() => {
    const onResize = (): void => {
      if (layoutModeForWidth(window.innerWidth) !== mode) setFloatingOpen(false);
      setWindowWidth(window.innerWidth);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mode]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      writeSidebarWidth(drawerWidth);
      writeAssistantWidth(assistantWidth);
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [drawerWidth, assistantWidth]);

  const setDrawerOpen = (open: boolean): void => {
    if (mode === 'wide') {
      setWideOverride({ preset, open });
      if (preset !== 'review') {
        setCollapsed(!open);
        writeSidebarCollapsed(!open);
      }
    } else {
      setFloatingOpen(open);
    }
  };
  const resetDrawer = (): void => setDrawerWidth(SIDEBAR_WIDTH.default);
  const resetAssistant = (): void => {
    if (preset === 'review') setReviewWidth(REVIEW_WIDTH);
    else setAssistantWidth(ASSISTANT_WIDTH.default);
  };
  const applyPreset = (next: LayoutPreset): void => {
    setFloatingOpen(false);
    setWideOverride(next === 'writing' ? null : { preset: next, open: next === 'research' });
    if (next === 'review') setReviewWidth(REVIEW_WIDTH);
  };

  return {
    mode, preset, drawerWidth, drawerOpen,
    assistantWidth: clamp(preset === 'review' ? reviewWidth : assistantWidth, ASSISTANT_WIDTH.min, assistantMaxWidth),
    assistantMaxWidth,
    setDrawerOpen,
    toggleDrawer: () => setDrawerOpen(!drawerOpen),
    resizeDrawer: width => setDrawerWidth(clamp(width, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max)),
    resizeAssistant: width => {
      const next = clamp(width, ASSISTANT_WIDTH.min, assistantMaxWidth);
      if (preset === 'review') setReviewWidth(next);
      else setAssistantWidth(next);
    },
    resetDrawer, resetAssistant, applyPreset,
    reset: () => {
      resetDrawer();
      setAssistantWidth(ASSISTANT_WIDTH.default);
      setCollapsed(false);
      writeSidebarCollapsed(false);
      applyPreset('research');
    }
  };
}
