/**
 * The only module in renderer-next allowed to touch `localStorage` (ADR-M06).
 *
 * Allowed keys are UI layout preferences and nothing else. Product data —
 * projects, literature, sessions, settings, secrets, indexes, tasks — must come
 * from the backend over IPC. Adding a key here requires an ADR amendment.
 *
 * Every key is prefixed `roc.ui.`. Reads are defensive: a malformed or
 * unavailable store degrades to the default rather than throwing.
 */

export const UI_STATE_PREFIX = 'roc.ui.';

export const uiStateKeys = {
  sidebarWidth: `${UI_STATE_PREFIX}sidebar.width`,
  sidebarCollapsed: `${UI_STATE_PREFIX}sidebar.collapsed`,
  sidebarTab: `${UI_STATE_PREFIX}sidebar.tab`,
  assistantWidth: `${UI_STATE_PREFIX}assistant.width`,
  assistantOpen: `${UI_STATE_PREFIX}assistant.open`,
  canvasTab: `${UI_STATE_PREFIX}canvas.tab`,
  lastProjectId: `${UI_STATE_PREFIX}project.last`,
  themeOverride: `${UI_STATE_PREFIX}theme.override`,
  /** Local-only pinning. Not product data; the backend has no star field (B1). */
  starredProjectIds: `${UI_STATE_PREFIX}project.starred`,
  /** Per-project file-tree expansion, bucketed by project id. */
  fileTreeExpanded: `${UI_STATE_PREFIX}files.expanded`
} as const;

export type UiStateKey = (typeof uiStateKeys)[keyof typeof uiStateKeys];

export type ThemeOverride = 'system' | 'light' | 'dark';
export type SidebarTab = 'files' | 'literature' | 'sessions';
export type CanvasTab = 'literature' | 'latex' | 'terminal';

/**
 * Legacy keys written by the pre-migration shell and by research-studio's
 * `mockProjects.ts`. They are garbage after this migration — we delete them
 * once at startup. This is cleanup, not a compatibility layer: nothing reads
 * them (ADR-M02, P2/T2.6).
 */
export const LEGACY_STORAGE_KEYS = ['codex_projects_list', 'codex_model_settings'] as const;
export const LEGACY_STORAGE_PREFIXES = ['codex_project_data_'] as const;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Sandboxed or blocked storage: UI preferences simply do not persist.
    return null;
  }
}

function readRaw(key: UiStateKey): string | null {
  const store = storage();
  if (store === null) {
    return null;
  }
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: UiStateKey, value: string | null): void {
  const store = storage();
  if (store === null) {
    return;
  }
  try {
    if (value === null) {
      store.removeItem(key);
      return;
    }
    store.setItem(key, value);
  } catch {
    // Quota or permission failure: preferences are best-effort.
  }
}

function readNumber(key: UiStateKey): number | null {
  const raw = readRaw(key);
  if (raw === null) {
    return null;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampi(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function readBoolean(key: UiStateKey, fallback: boolean): boolean {
  const raw = readRaw(key);
  if (raw === null) {
    return fallback;
  }
  return raw === '1' || raw === 'true';
}

function readStringList(key: UiStateKey): string[] {
  const raw = readRaw(key);
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

export const SIDEBAR_WIDTH = { min: 180, max: 400, default: 256 } as const;
export const ASSISTANT_WIDTH = { min: 280, default: 440 } as const;

export function readSidebarWidth(): number {
  const value = readNumber(uiStateKeys.sidebarWidth);
  return value === null ? SIDEBAR_WIDTH.default : clampi(value, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max);
}

export function writeSidebarWidth(width: number): void {
  writeRaw(uiStateKeys.sidebarWidth, String(Math.round(clampi(width, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max))));
}

export function readSidebarCollapsed(): boolean {
  return readBoolean(uiStateKeys.sidebarCollapsed, false);
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  writeRaw(uiStateKeys.sidebarCollapsed, collapsed ? '1' : '0');
}

export function readSidebarTab(): SidebarTab {
  const raw = readRaw(uiStateKeys.sidebarTab);
  if (raw === 'files' || raw === 'literature' || raw === 'sessions') {
    return raw;
  }
  return 'files';
}

export function writeSidebarTab(tab: SidebarTab): void {
  writeRaw(uiStateKeys.sidebarTab, tab);
}

export function readAssistantWidth(): number {
  const value = readNumber(uiStateKeys.assistantWidth);
  return value === null ? ASSISTANT_WIDTH.default : Math.max(value, ASSISTANT_WIDTH.min);
}

export function writeAssistantWidth(width: number): void {
  writeRaw(uiStateKeys.assistantWidth, String(Math.round(Math.max(width, ASSISTANT_WIDTH.min))));
}

export function readAssistantOpen(): boolean | null {
  const raw = readRaw(uiStateKeys.assistantOpen);
  if (raw === null) {
    return null;
  }
  return raw === '1';
}

export function writeAssistantOpen(open: boolean): void {
  writeRaw(uiStateKeys.assistantOpen, open ? '1' : '0');
}

export function readCanvasTab(): CanvasTab {
  const raw = readRaw(uiStateKeys.canvasTab);
  if (raw === 'literature' || raw === 'latex' || raw === 'terminal') {
    return raw;
  }
  return 'literature';
}

export function writeCanvasTab(tab: CanvasTab): void {
  writeRaw(uiStateKeys.canvasTab, tab);
}

/* ------------------------------------------------------------------ */
/* Project highlight / pinning                                         */
/* ------------------------------------------------------------------ */

export function readLastProjectId(): string | null {
  const raw = readRaw(uiStateKeys.lastProjectId);
  return raw === null || raw.trim().length === 0 ? null : raw;
}

export function writeLastProjectId(projectId: string | null): void {
  writeRaw(uiStateKeys.lastProjectId, projectId);
}

export function readStarredProjectIds(): string[] {
  return readStringList(uiStateKeys.starredProjectIds);
}

export function writeStarredProjectIds(ids: readonly string[]): void {
  writeRaw(uiStateKeys.starredProjectIds, JSON.stringify([...new Set(ids)]));
}

/* ------------------------------------------------------------------ */
/* Theme override                                                      */
/* ------------------------------------------------------------------ */

export function readThemeOverride(): ThemeOverride {
  const raw = readRaw(uiStateKeys.themeOverride);
  if (raw === 'light' || raw === 'dark') {
    return raw;
  }
  return 'system';
}

export function writeThemeOverride(override: ThemeOverride): void {
  writeRaw(uiStateKeys.themeOverride, override);
}

/* ------------------------------------------------------------------ */
/* File-tree expansion                                                 */
/* ------------------------------------------------------------------ */

export function readFileTreeExpanded(projectId: string | null): string[] {
  if (projectId === null) {
    return [];
  }
  const raw = readRaw(uiStateKeys.fileTreeExpanded);
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return [];
    }
    const bucket = (parsed as Record<string, unknown>)[projectId];
    if (!Array.isArray(bucket)) {
      return [];
    }
    return bucket.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

export function writeFileTreeExpanded(projectId: string, paths: readonly string[]): void {
  if (projectId.trim().length === 0) {
    return;
  }
  const raw = readRaw(uiStateKeys.fileTreeExpanded);
  let record: Record<string, string[]> = {};
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        record = parsed as Record<string, string[]>;
      }
    } catch {
      record = {};
    }
  }
  record[projectId] = [...new Set(paths)];
  writeRaw(uiStateKeys.fileTreeExpanded, JSON.stringify(record));
}

/* ------------------------------------------------------------------ */
/* Legacy cleanup                                                      */
/* ------------------------------------------------------------------ */

/** Removes keys left behind by earlier shells. Never reads them. */
export function purgeLegacyStorage(): string[] {
  const store = storage();
  if (store === null) {
    return [];
  }
  const removed: string[] = [];
  try {
    for (const key of LEGACY_STORAGE_KEYS) {
      if (store.getItem(key) !== null) {
        store.removeItem(key);
        removed.push(key);
      }
    }
    const prefixed: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key === null) {
        continue;
      }
      if (LEGACY_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        prefixed.push(key);
      }
    }
    for (const key of prefixed) {
      store.removeItem(key);
      removed.push(key);
    }
  } catch {
    return removed;
  }
  return removed;
}
