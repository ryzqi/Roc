import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ASSISTANT_WIDTH,
  SIDEBAR_WIDTH,
  readAssistantWidth,
  readSidebarCollapsed,
  readSidebarTab,
  readSidebarWidth,
  writeAssistantWidth,
  writeSidebarCollapsed,
  writeSidebarTab,
  writeSidebarWidth,
  type SidebarTab
} from './ui-state';

/**
 * Layout state for the three-column workspace, persisted as UI preferences.
 *
 * Scope is deliberately narrow: panel geometry and which sidebar tab is
 * showing. Two things that look like layout state are **not** here, because the
 * URL already owns them and a second copy would drift after reload:
 *
 *   - which canvas view is active   → `?view=`
 *   - whether the assistant is open → `?assistant=1`
 *
 * Width rules:
 *   sidebar   180–400, default 256
 *   assistant 280–(window − sidebar − 360), default 440
 * The canvas retains at least 360px, so the assistant cannot squeeze it away.
 */

/** Width the canvas must retain when sizing the assistant. */
const CANVAS_MIN_WIDTH = 360;

/**
 * Breakpoint policy.
 *
 * The window's own minimum is 1184px (`src/main/window-shell.ts`), so `drawers`
 * is not reachable by user resizing today — it appears only if that minimum is
 * ever lowered (the layout audit also exercises it via `setBounds`). It is
 * implemented rather than left as a TODO so a narrower window degrades into
 * drawers instead of collapsing the canvas.
 *
 * The "assistant collapsed by default" case needs no mode of its own: the
 * assistant already defaults to closed because `?assistant` is absent.
 */
export type LayoutMode = 'columns' | 'drawers';

const DRAWER_THRESHOLD = 1100;

export function layoutModeForWidth(width: number): LayoutMode {
  return width < DRAWER_THRESHOLD ? 'drawers' : 'columns';
}

export type LayoutPreset = 'normal' | 'focus' | 'collaboration';

export type LayoutState = {
  preset: LayoutPreset;
  setPreset: (preset: LayoutPreset) => void;
  mode: LayoutMode;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  assistantWidth: number;
  /** Sidebar and assistant render inside drawers rather than as columns. */
  sidebarAsDrawer: boolean;
  assistantAsDrawer: boolean;
  sidebarTab: SidebarTab;
  toggleSidebar: () => void;
  growSidebar: (deltaPx: number) => void;
  resetSidebar: () => void;
  growAssistant: (deltaPx: number) => void;
  resetAssistant: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
};

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(Math.max(value, min), max);
}

/**
 * Upper bound for the assistant so the canvas keeps `CANVAS_MIN_WIDTH`.
 *
 * `sidebarWidth` must be the *effective* width: a collapsed or drawer-mode
 * sidebar occupies nothing, and subtracting its stored width anyway would stop
 * the assistant 256px early with no visible reason.
 */
function assistantMaxWidth(windowWidth: number, effectiveSidebarWidth: number): number {
  return Math.max(ASSISTANT_WIDTH.min, windowWidth - effectiveSidebarWidth - CANVAS_MIN_WIDTH);
}

/** Debounce for persisting drag results; see `schedulePersistWidths`. */
const PERSIST_DEBOUNCE_MS = 200;

export function useLayoutState(): LayoutState {
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [sidebarWidth, setSidebarWidth] = useState(() => readSidebarWidth());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarCollapsed());
  const [assistantWidth, setAssistantWidth] = useState(() => readAssistantWidth());
  const [sidebarTab, setSidebarTabState] = useState<SidebarTab>(() => readSidebarTab());

  const [preset, setPresetState] = useState<LayoutPreset>('normal');
  const previousLayout = useRef<{ sidebarWidth: number; assistantWidth: number; sidebarCollapsed: boolean } | null>(null);
  const setPreset = useCallback((next: LayoutPreset) => {
    if (next === preset) return;
    if (preset === 'normal') previousLayout.current = { sidebarWidth, assistantWidth, sidebarCollapsed };
    if (next === 'normal') {
      const previous = previousLayout.current;
      if (previous !== null) {
        setSidebarWidth(previous.sidebarWidth);
        setAssistantWidth(previous.assistantWidth);
        setSidebarCollapsed(previous.sidebarCollapsed);
      }
      previousLayout.current = null;
    } else if (next === 'focus') {
      setSidebarCollapsed(true);
    } else {
      setSidebarCollapsed(false);
      setSidebarWidth(SIDEBAR_WIDTH.min);
      setAssistantWidth(Math.max(ASSISTANT_WIDTH.default, Math.floor(windowWidth * 0.4)));
    }
    setPresetState(next);
  }, [preset, sidebarWidth, assistantWidth, sidebarCollapsed, windowWidth]);

  const mode = layoutModeForWidth(windowWidth);
  const effectiveSidebarWidth = sidebarCollapsed || mode === 'drawers' ? 0 : sidebarWidth;

  // Dragging fires a pointermove per frame; writing both widths to localStorage
  // on each one is pointless churn, so persistence is debounced and reads the
  // latest values from refs at flush time.
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const assistantWidthRef = useRef(assistantWidth);
  assistantWidthRef.current = assistantWidth;
  const persistTimerRef = useRef<number | null>(null);

  const schedulePersistWidths = useCallback(() => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      if (previousLayout.current !== null) return;
      writeSidebarWidth(sidebarWidthRef.current);
      writeAssistantWidth(assistantWidthRef.current);
    }, PERSIST_DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    const onResize = (): void => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      if (previousLayout.current === null) writeSidebarCollapsed(next);
      return next;
    });
  }, []);

  const growSidebar = useCallback(
    (deltaPx: number) => {
      setSidebarWidth((current) => {
        const next = clamp(current + deltaPx, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max);
        if (next !== current) {
          schedulePersistWidths();
        }
        return next;
      });
    },
    [schedulePersistWidths]
  );

  const growAssistant = useCallback(
    (deltaPx: number) => {
      setAssistantWidth((current) => {
        // The divider sits on the assistant's *right* edge, so dragging it right
        // widens the panel.
        const next = clamp(current + deltaPx, ASSISTANT_WIDTH.min, assistantMaxWidth(windowWidth, effectiveSidebarWidth));
        if (next !== current) {
          schedulePersistWidths();
        }
        return next;
      });
    },
    [windowWidth, effectiveSidebarWidth, schedulePersistWidths]
  );

  const resetSidebar = useCallback(() => {
    setSidebarWidth(SIDEBAR_WIDTH.default);
    if (previousLayout.current === null) writeSidebarWidth(SIDEBAR_WIDTH.default);
  }, []);

  const resetAssistant = useCallback(() => {
    setAssistantWidth(ASSISTANT_WIDTH.default);
    if (previousLayout.current === null) writeAssistantWidth(ASSISTANT_WIDTH.default);
  }, []);

  const setSidebarTab = useCallback((tab: SidebarTab) => {
    writeSidebarTab(tab);
    setSidebarTabState(tab);
  }, []);

  return {
    mode,
    preset,
    setPreset,
    sidebarWidth: clamp(sidebarWidth, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max),
    sidebarCollapsed,
    assistantWidth: clamp(
      assistantWidth,
      ASSISTANT_WIDTH.min,
      assistantMaxWidth(windowWidth, effectiveSidebarWidth)
    ),
    sidebarAsDrawer: mode === 'drawers',
    assistantAsDrawer: mode === 'drawers',
    sidebarTab,
    toggleSidebar,
    growSidebar,
    resetSidebar,
    growAssistant,
    resetAssistant,
    setSidebarTab
  };
}
