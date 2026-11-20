/**
 * Shared surface classification for the renderer, native menu and verification tools.
 * Canvas destinations and management sections derive from this table; legacy URL
 * migration belongs only to renderer/app/routes.ts.
 */
export type Surface = {
  readonly id: string;
  readonly label: string;
  readonly canvas: 'tab' | 'view' | 'none';
  readonly drawer: boolean;
  readonly defaultView?: true;
  readonly note?: string;
};

export const SURFACES = [
  { id: 'overview', label: '工作台', canvas: 'tab', drawer: false, defaultView: true },
  { id: 'discover', label: '发现', canvas: 'tab', drawer: false },
  { id: 'library', label: '文献', canvas: 'tab', drawer: false },
  { id: 'knowledge', label: '知识', canvas: 'tab', drawer: false },
  { id: 'writing', label: '写作', canvas: 'tab', drawer: false },
  { id: 'terminal', label: '终端', canvas: 'none', drawer: false },
  { id: 'memory', label: '记忆', canvas: 'none', drawer: true },
  { id: 'skills', label: '工作技能', canvas: 'none', drawer: true },
  { id: 'mcp', label: '外部工具连接', canvas: 'none', drawer: true },
  {
    id: 'tasks', label: '任务', canvas: 'none', drawer: true,
    note: '任务中心聚合现有任务来源，不建立独立画布或第二份持久化任务表。'
  }
] as const satisfies readonly Surface[];

export type SurfaceId = (typeof SURFACES)[number]['id'];
export type SurfaceRecord = (typeof SURFACES)[number];
export type CanvasViewId = Extract<SurfaceRecord, { canvas: 'tab' | 'view' }>['id'];
export type CanvasTabId = Extract<SurfaceRecord, { canvas: 'tab' }>['id'];
export type DrawerSectionId = Extract<SurfaceRecord, { drawer: true }>['id'];

export const defaultViewId: CanvasViewId = 'overview';

function idsWhere(predicate: (surface: SurfaceRecord) => boolean): readonly SurfaceId[] {
  return SURFACES.filter(predicate).map(surface => surface.id);
}

// Predicates and assertions stay together so consumers never duplicate the classification.
export const canvasViewIds: readonly CanvasViewId[] = idsWhere(
  surface => surface.canvas !== 'none'
) as readonly CanvasViewId[];
export const canvasTabIds: readonly CanvasTabId[] = idsWhere(
  surface => surface.canvas === 'tab'
) as readonly CanvasTabId[];
export const drawerSectionIds: readonly DrawerSectionId[] = idsWhere(
  surface => surface.drawer
) as readonly DrawerSectionId[];

export const canvasViewIdSet: ReadonlySet<string> = new Set(canvasViewIds);
export const canvasTabIdSet: ReadonlySet<string> = new Set(canvasTabIds);
export const drawerSectionIdSet: ReadonlySet<string> = new Set(drawerSectionIds);

export function isCanvasViewId(value: string): value is CanvasViewId {
  return canvasViewIdSet.has(value);
}

export function isCanvasTabId(value: string): value is CanvasTabId {
  return canvasTabIdSet.has(value);
}

export function isDrawerSectionId(value: string): value is DrawerSectionId {
  return drawerSectionIdSet.has(value);
}

const surfaceById: ReadonlyMap<string, SurfaceRecord> = new Map(
  SURFACES.map(surface => [surface.id, surface])
);

export function surfaceFor(id: SurfaceId): SurfaceRecord {
  const surface = surfaceById.get(id);
  if (surface === undefined) throw new Error(`surface_unknown:${id}`);
  return surface;
}

/** Domains with IPC/storage contracts but no standalone UI (ADR 0024). */
export type ParkedCapability = {
  readonly id: string;
  readonly label: string;
  readonly capability: string;
};

export const PARKED_CAPABILITIES = [
  { id: 'ideas', label: '构思', capability: 'research.ideas' },
  { id: 'experiments', label: '实验', capability: 'research.experiment' },
  { id: 'figures', label: '图稿', capability: 'research.figure' },
  { id: 'manuscript', label: '正文', capability: 'research.manuscript' },
  { id: 'exports', label: '导出', capability: 'research.export' },
  { id: 'templates', label: '模板包', capability: 'research.template' },
  { id: 'policies', label: '阶段策略', capability: 'research.workflow.policies' }
] as const satisfies readonly ParkedCapability[];

const parkedById: ReadonlyMap<string, ParkedCapability> = new Map(
  PARKED_CAPABILITIES.map(entry => [entry.id, entry])
);

export type SurfaceResolution =
  | { readonly kind: 'surface'; readonly surface: SurfaceRecord }
  | { readonly kind: 'parked'; readonly parked: ParkedCapability }
  | { readonly kind: 'unknown' };

export function resolveSurface(value: string | null | undefined): SurfaceResolution {
  if (!value) return { kind: 'unknown' };
  const surface = surfaceById.get(value);
  if (surface !== undefined) return { kind: 'surface', surface };
  const parked = parkedById.get(value);
  if (parked !== undefined) return { kind: 'parked', parked };
  return { kind: 'unknown' };
}

/** Native producers and IPC schemas share this closed set. */
export const menuPages = ['settings', 'research-new', 'chat', 'tasks'] as const;
export type MenuPage = (typeof menuPages)[number];

export type MenuIntent =
  | { readonly kind: 'settings' }
  | { readonly kind: 'new-project' }
  | { readonly kind: 'assistant' }
  | { readonly kind: 'management'; readonly section: DrawerSectionId };

export const MENU_PAGES: Readonly<Record<MenuPage, MenuIntent>> = {
  settings: { kind: 'settings' },
  'research-new': { kind: 'new-project' },
  chat: { kind: 'assistant' },
  tasks: { kind: 'management', section: 'tasks' }
};

export function isMenuPage(value: string): value is MenuPage {
  return Object.prototype.hasOwnProperty.call(MENU_PAGES, value);
}

export function menuIntentForPage(page: string): MenuIntent | null {
  return isMenuPage(page) ? MENU_PAGES[page] : null;
}
