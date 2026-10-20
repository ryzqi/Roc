/**
 * 面的分类学：壳里每一个可以出现在屏幕上的东西，以及它落在哪里。
 *
 * ## 为什么要有这个模块
 *
 * 「有哪些面、每个面落在哪」这件事，在 P10 之前被重新声明在九个地方：`AppViewId`、`APP_VIEW_IDS`、
 * `DEFAULT_VIEW`、`WorkbenchTool`、`routeForNavigate`、`view-registry.viewLoaders`、`AppShell.PRIMARY_TABS`、
 * `WorkspaceCanvas.CanvasTabId` + `TABS`、`ManagementView.viewForInitialTab`，再加上两处把管理分区抄成
 * 字面量联合（`management-scope`、`use-search-groups`）。每个地方只覆盖其中一部分，彼此靠字符串字面量和
 * `Extract<>` 对齐。代价不是"多维护一点"，而是三件具体的事：
 *
 *   1. **加一个面要改七处，漏一处不报错。** 漏 `PRIMARY_TABS` 只是画布上没有 tab；漏 `routeForNavigate`
 *      是菜单点了没反应；漏 `viewForInitialTab` 是深链落错分区。三种都静默。
 *   2. **三套 id 域互相翻译。** 原生菜单说 `'chat' | 'tasks'`，路由说 `AppViewId`，抽屉说 `ManagementTabId`。
 *      翻译散在三处，每处各写一遍"哪个 id 是真的"，而主进程那一侧的 `openMainPage` 收的是**裸 `string`**
 *      （`src/main/application-menu.ts:4`），事件契约也是 `eventContract(z.string())`
 *      （`src/shared/ipc-registry.ts:508`）——没有任何东西拦住一个生产方发得出、消费方认不出的 page。
 *   3. **删掉一个面不会有人报警。** P10 删了 `overview / stage / activity / provenance / tasks / diagnostics`
 *      六个面，`parseView` 把未知值静默落到缺省视图。于是八个闸门断言在 `view=overview` 归一成的 `latex`
 *      上通过了——绿灯建立在错误的页面上（`scripts/verify-p8-settings.mjs:326,688,715,768,930`、
 *      `scripts/verify-p9-management.mjs:370,683,1104`）。修掉这八处不是本模块的价值，**让下一次不能这么修**
 *      才是。
 *
 * ## 归类方式
 *
 * 按**落点**分，不按 id 域分——因为"这个面能不能出现在画布上"是调用方真正要问的问题，
 * 而 id 域（`AppViewId` / `ManagementTabId`）是历史产物。一个面落在三种地方之一或多种：
 *
 *   - `canvas: 'tab'`  —— 画布一级 tab（文献 / LaTeX / 终端）
 *   - `canvas: 'view'` —— 只有 `?view=` 能到的画布视图（管理三节）
 *   - `canvas: 'none'` —— 不上画布
 *   - `drawer: true`   —— 管理抽屉的一个分区（记忆 / 技能 / MCP / 任务）
 *
 * 三个类型与三个集合**全部由这张表派生**，所以它们不可能互相漂移——这是本模块存在的理由，
 * 也是它不接受"再抄一份到别处"的原因。
 *
 * ## 没有落点的能力
 *
 * `PARKED_CAPABILITIES` 是七个今天**有契约、有数据库、没有界面**的域（ADR 0024 有意保留）。它们不是
 * 「未知」：深链到 `?view=manuscript` 应当明确告诉用户这个域今天没有界面，而不是静默落回缺省视图。
 * 三种结果因此要在类型上分开——`resolveSurface` 的返回值就是这个区分。
 *
 * 本模块**不 import 任何东西**：渲染层、主进程、preload 与闸门脚本都要读它，图标之类的渲染层细节留在
 * 渲染层（`WorkspaceCanvas` 用一张以 `CanvasTabId` 为键的 `Record`，漏一个 tab 编译不过）。
 */

/**
 * 一个面落在哪里。`canvas` 三值即落点本身。
 *
 * 三个类型从表派生，`Extract` 之所以能工作就是因为 `canvas` / `drawer` 在这里是字面量。
 */
export type Surface = {
  readonly id: string;
  readonly label: string;
  /** `tab` = 画布一级 tab；`view` = `?view=` 独有的画布视图；`none` = 不上画布。 */
  readonly canvas: 'tab' | 'view' | 'none';
  /** 管理抽屉的一个分区。 */
  readonly drawer: boolean;
  /** `?view=` 缺失时的落点。全表恰好一个。 */
  readonly defaultView?: true;
  /** 没有落点或只有部分落点的原因。写入表里，别写进别处的注释。 */
  readonly note?: string;
};

export const SURFACES = [
  {
    id: 'literature',
    label: '文献',
    canvas: 'tab',
    drawer: false
  },
  {
    id: 'latex',
    label: 'LaTeX',
    canvas: 'tab',
    drawer: false,
    defaultView: true
  },
  {
    id: 'terminal',
    label: '终端',
    canvas: 'tab',
    drawer: false
  },
  {
    id: 'memory',
    label: '记忆',
    canvas: 'view',
    drawer: true
  },
  {
    id: 'skills',
    label: '技能',
    canvas: 'view',
    drawer: true
  },
  {
    id: 'mcp',
    label: 'MCP',
    canvas: 'view',
    drawer: true
  },
  {
    id: 'tasks',
    label: '任务',
    canvas: 'none',
    drawer: true,
    // ADR 0024：后台任务只有一个家——管理抽屉的任务分区。两个界面盯一个数据集就是发散，
    // 所以这个面**故意**没有画布落点，不是漏了。
    note: '只有抽屉一个落点：两个界面盯一个数据集是 P9 建 management-shell-parts 要防的发散。'
  }
] as const satisfies readonly Surface[];

export type SurfaceId = (typeof SURFACES)[number]['id'];
export type SurfaceRecord = (typeof SURFACES)[number];

/** 能作为 `?view=` 的值：一级 tab 与管理三节。 */
export type CanvasViewId = Extract<SurfaceRecord, { canvas: 'tab' | 'view' }>['id'];
/** 画布一级 tab：恰好三个。 */
export type CanvasTabId = Extract<SurfaceRecord, { canvas: 'tab' }>['id'];
/** 管理抽屉的分区：恰好四个。 */
export type DrawerSectionId = Extract<SurfaceRecord, { drawer: true }>['id'];

/**
 * `?view=` 缺失时的落点。
 *
 * 声明成常量而不是从表里 `find`：`as const` 让编译器检查 `'latex'` 确实是 `CanvasViewId`，
 * 而模块加载时不需要跑任何逻辑（渲染层不该因为一条程序性不变式在启动时抛异常）。
 * 表里那条 `defaultView: true` 由单测守住——两个方向都覆盖。
 */
export const defaultViewId: CanvasViewId = 'latex';

function idsWhere(predicate: (surface: SurfaceRecord) => boolean): readonly SurfaceId[] {
  const ids: SurfaceId[] = [];
  for (const surface of SURFACES) {
    if (predicate(surface)) {
      ids.push(surface.id);
    }
  }
  return ids;
}

/*
 * 三个断言只在这里出现一次。
 *
 * 数组遍历不窄化类型，而收窄的谓词就是下面那三行（`canvas === 'tab'` / `canvas !== 'none'` / `drawer`）——
 * 不变式由表保证，所以断言落在表的旁边是诚实的；散到各调用方去断言才是把不变式藏起来。
 */

/** 能作为 `?view=` 的值（一级 tab + 画布视图）。 */
export const canvasViewIds: readonly CanvasViewId[] = idsWhere(
  (surface) => surface.canvas !== 'none'
) as readonly CanvasViewId[];
/** 画布一级 tab。顺序即 tab 条的顺序。 */
export const canvasTabIds: readonly CanvasTabId[] = idsWhere(
  (surface) => surface.canvas === 'tab'
) as readonly CanvasTabId[];
/** 管理抽屉的分区。 */
export const drawerSectionIds: readonly DrawerSectionId[] = idsWhere(
  (surface) => surface.drawer
) as readonly DrawerSectionId[];

export const canvasViewIdSet: ReadonlySet<string> = new Set(canvasViewIds);
export const canvasTabIdSet: ReadonlySet<string> = new Set(canvasTabIds);
export const drawerSectionIdSet: ReadonlySet<string> = new Set(drawerSectionIds);

/**
 * 三个类型守卫，而不是让每个调用方写 `as`。
 *
 * `ReadonlySet<string>` 上的 `.has()` 不窄化类型，而这三个集合存在的意义就是替调用方回答
 * 「这个字符串是这种面吗」——答案必须带着类型，否则每个调用方都得自己补一次断言，
 * 而那正是这个模块要消掉的重复。
 */
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
  SURFACES.map((surface) => [surface.id, surface])
);

export function surfaceFor(id: SurfaceId): SurfaceRecord {
  const surface = surfaceById.get(id);
  if (surface === undefined) {
    throw new Error(`surface_unknown:${id}`);
  }
  return surface;
}

/** 管理分区 → 它在画布上的同义视图 id；`tasks` 没有画布落点，返回 null。 */
export function canvasViewForDrawerSection(section: DrawerSectionId): CanvasViewId | null {
  return canvasViewIdSet.has(section) ? (section as CanvasViewId) : null;
}

/**
 * 管理三节的画布视图 → 它的抽屉分区。
 *
 * 先确认它是画布视图：否则 `drawerSectionForCanvasView('tasks')` 会返回 `'tasks'`——而 任务 不是
 * 画布视图，那个返回值是假的。参数类型已经说了「这是画布视图」，但一个在越界输入上撒谎的接口比
 * 一个拒绝它的接口贵得多（调用方会信它）。
 */
export function drawerSectionForCanvasView(view: CanvasViewId): DrawerSectionId | null {
  if (!isCanvasViewId(view) || !drawerSectionIdSet.has(view)) {
    return null;
  }
  return view as DrawerSectionId;
}

/**
 * 今天有契约、有数据库、没有界面的域（ADR 0024）。
 *
 * 它们的 id 是**将来**那个 `?view=` 的值。留在这里的理由不是"以后要用"，而是：一个深链到已保留能力的
 * 地址应当明确失败并说出原因，而不是像 P10 之后的 `view=overview` 那样静默落回缺省视图。
 *
 * `capability` 是该域在 IPC 契约里的**准确**名字（复数单数不统一，是既有契约的事实：`research.ideas` 复数，
 * `research.experiment` / `research.figure` / `research.export` / `research.template` 单数，
 * 阶段策略挂在 `research.workflow.policies` 下）。
 */
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

export type ParkedCapabilityId = (typeof PARKED_CAPABILITIES)[number]['id'];

const parkedById: ReadonlyMap<string, ParkedCapability> = new Map(
  PARKED_CAPABILITIES.map((entry) => [entry.id, entry])
);

/**
 * 一个 `?view=` 值的三种归宿。
 *
 * 调用方按自己的失败模式取用，模块不替它决定：URL 归一化静默落回缺省视图（ADR 0025 的往返保证要求
 * 解析器对垃圾输入有确定行为），闸门脚本则把后两种直接当失败——那正是八处假绿灯的入口。
 */
export type SurfaceResolution =
  | { readonly kind: 'surface'; readonly surface: SurfaceRecord }
  | { readonly kind: 'parked'; readonly parked: ParkedCapability }
  | { readonly kind: 'unknown' };

export function resolveSurface(value: string | null | undefined): SurfaceResolution {
  if (value === null || value === undefined || value.length === 0) {
    return { kind: 'unknown' };
  }
  const surface = surfaceById.get(value);
  if (surface !== undefined) {
    return { kind: 'surface', surface };
  }
  const parked = parkedById.get(value);
  if (parked !== undefined) {
    return { kind: 'parked', parked };
  }
  return { kind: 'unknown' };
}

/**
 * 主进程能发出的 page 名字。
 *
 * 这是一份**闭合**清单，主进程那一侧的 `openMainPage` 收这个联合而不是裸 `string`。生产方只有三处：
 * 应用菜单（`settings` / `research-new`）、托盘与全局热键（`chat` / `tasks`），以及
 * `roc:app:open-settings` 的 handler。
 *
 * P10 之前 `routeForNavigate` 有十三个分支而生产方只有这四个——九个分支没有任何生产者。它们不是被删掉的
 * 兼容层，就是被误以为存在的面；两者都不该留在翻译表里冒充能力。
 */
/**
 * 主进程能发出的 page 名字（运行时清单）。
 *
 * 类型由它派生，所以 IPC 契约里的 `z.enum(menuPages)`、意图表 `MENU_PAGES` 与主进程的函数签名
 * 三者不可能漂移。P10 之前这里只有 `z.string()` 与 `(page: string) => void`：任何渲染层代码都能发一个
 * 任意字符串，主进程把它当 navigate 事件原样广播回来（`register-ipc.ts` 那个通道自己叫
 * "Legacy App Supplement"）。
 */
export const menuPages = ['settings', 'research-new', 'chat', 'tasks'] as const;

export type MenuPage = (typeof menuPages)[number];

/**
 * 一个 page 让壳做的事。
 *
 * 做成联合而不是"目标视图 id"，是因为 `tasks` 说明了一件事：**有些 page 的目标不是画布视图**。
 * 托盘「打开任务」要开的是管理抽屉的任务分区，而抽屉不是 `?view=` 值。旧实现在这里无路可走，
 * 只能返回"什么都不改"——于是那个菜单项静默失效（见 `menuIntentForPage` 的注释）。
 */
export type MenuIntent =
  | { readonly kind: 'settings' }
  | { readonly kind: 'new-project' }
  /** 打开研究助手（全局热键与托盘「打开 Roc」）。 */
  | { readonly kind: 'assistant' }
  /** 打开管理抽屉的某个分区。 */
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

/**
 * page → 意图。未登记的 page 返回 null，调用方决定是忽略还是失败。
 *
 * `tasks` 是修正旧缺陷的那一条：`routeForNavigate('tasks')` 过去返回 `{...base, page: 'research'}`，
 * 而同一条路由的早退（`sameAppRoute`）让它在项目内、且已经停在 `page=research` 时**什么都不做**——
 * 托盘「打开任务」只把窗口提到前面，注释里写的"经由抽屉的任务分区兑现"从未实现。
 * 现在它有一个能表达的意图。
 *
 * 意图表按 `MenuPage` 穷举，所以往 `menuPages` 里加一项而不给它意图，编译不过。
 */
export function menuIntentForPage(page: string): MenuIntent | null {
  return isMenuPage(page) ? MENU_PAGES[page] : null;
}
