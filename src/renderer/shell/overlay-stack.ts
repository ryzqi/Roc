/**
 * 浮层栈：谁在最上面、Esc 关哪一层。
 *
 * 纯数据，不依赖 React —— 层级规则是这一屏最容易出错的地方，必须能单测
 * （`tests/unit/renderer-overlay-stack.test.mjs`）。
 *
 * ## 为什么分两层，而不是一个栈
 *
 * 栈的顺序以前就是**打开顺序**，于是「谁后挂载谁在上」成了唯一规则。窗口变窄时这条规则会
 * 反过来咬人：左栏改成抽屉（`< 1100px`），它是**跟着布局出现**的，不是用户打开的；
 * 一旦它比设置面板后挂载，它就以同为 `z-50` 的身份整体压在设置面板之上 —— 抽屉右边缘正好
 * 切掉「工具审批模式」下拉框的左段，而且 Esc 会先关抽屉、Tab 也被困在抽屉里。
 *
 * 所以分成两类：
 *
 *   - `ambient`（环境层）：布局自己冒出来的界面（窄窗时的左栏 / 助手抽屉）。它属于页面
 *     背景，永远在所有对话框**之下**；
 *   - `dialog`（对话层）：用户显式打开的（设置、管理、Git、各类确认框）。后打开的在上。
 *
 * 同层之内仍然按打开顺序（后开在上），这是用户唯一会主动感知的规则。
 */

export type OverlayLayer = 'dialog' | 'ambient';

/**
 * 两层的 z-index。
 *
 * 必须留出差距：`ambient` 之上要能放对话框，`dialog` 之上还要能放它的嵌套确认框。数值本身
 * 只在这里定义一次（`ModalShell` 不写字面量），否则下一个组件又会随手写一个 `z-50` 把顺序
 * 打回「看 DOM 顺序」。
 */
export const OVERLAY_Z_INDEX: Readonly<Record<OverlayLayer, number>> = {
  ambient: 40,
  dialog: 50
};

const stacks: { dialog: string[]; ambient: string[] } = { dialog: [], ambient: [] };
export function pushOverlay(overlayId: string, layer: OverlayLayer): void {
  const stack = stacks[layer];
  const existing = stack.indexOf(overlayId);
  if (existing >= 0) {
    stack.splice(existing, 1);
  }
  stack.push(overlayId);
}

export function popOverlay(overlayId: string): void {
  for (const layer of ['dialog', 'ambient'] as const) {
    const stack = stacks[layer];
    const index = stack.indexOf(overlayId);
    if (index >= 0) {
      stack.splice(index, 1);
    }
  }
}

/**
 * 最上面那一层：有对话框就是最后一个对话框，否则才是最后一个环境层。
 *
 * Esc 与 Tab 都只认它 —— 环境层在被对话框盖住时不该响应任何键。
 */
export function topOverlayId(): string | null {
  const dialog = stacks.dialog.at(-1);
  if (dialog !== undefined) {
    return dialog;
  }
  return stacks.ambient.at(-1) ?? null;
}

/** 打开中的浮层总数（快捷键据此屏蔽会改动背后视图的按键）。 */
export function overlayStackDepth(): number {
  return stacks.dialog.length + stacks.ambient.length;
}

/**
 * 有对话层打开吗。
 *
 * 背景惰性（`aria-hidden`）跟的是它，而不是总数：窄窗的左栏抽屉属于页面本身，它开着时页面
 * 仍然该是页面；只有对话框才把背后判为惰性。
 */
export function hasOpenDialog(): boolean {
  return stacks.dialog.length > 0;
}

/** 仅测试使用：清空两层。 */
export function resetOverlayStack(): void {
  stacks.dialog.length = 0;
  stacks.ambient.length = 0;
}
