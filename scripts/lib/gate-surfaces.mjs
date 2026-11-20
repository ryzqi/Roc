/**
 * 闸门脚手架：校验一个 `?view=` 值，遇到不认识的面**抛错**。
 *
 * ## 这是为了修一类假绿灯
 *
 * 产品里的解析器对未知 `?view=` 必须给出确定答案（往返保证），所以它静默落到缺省视图。
 * 这在产品里是对的，在闸门里是错的：`parseView` 把 `view=overview` 变成 `latex`，于是 P10 删掉总览面之后，
 * 八处断言仍然在 `latex` 上通过了 ——
 * `verify-p8-settings.mjs:326,688,715,768,930`、`verify-p9-management.mjs:370,683,1104`。
 * 断言跑在别的页面上，绿灯比红灯更贵。
 *
 * 所以校验放在**测试这一侧**：产品代码继续静默归一，闸门脚本则要求每个 `view=` 都能解析成面。
 *
 * ## 为什么表是参数，而不是 import
 *
 * 这个文件**不 import 任何东西**，两个理由：
 *
 *   1. 它要被 `tests/unit` 打包加载，而 `import` 一个 .ts 会把加载方式绑到 Node 的类型剥离能力上
 *      （≥23.6），或者把 esbuild 拖进自己的 bundle 里解析不了。
 *   2. 表的加载方式由调用方决定（现在由 `scripts/lib/bundle-ts.mjs` 负责），校验逻辑只管判断。
 *
 * 于是这一份逻辑对任何加载路径都成立，而它要守的性质与怎么加载无关。
 */

/**
 * @param {{
 *   resolveSurface: (value: string | null | undefined) => { kind: string, surface?: { id: string, label: string, canvas: string }, parked?: { label: string, capability: string } },
 *   canvasViewIds: readonly string[]
 * }} surfaces
 */
export function createViewGuard(surfaces) {
  /**
   * @param {string} value 形如 `latex`
   * @returns {string} 同一个值，已验证有画布落点
   */
  return function assertKnownView(value) {
    const resolution = surfaces.resolveSurface(value);
    if (resolution.kind === 'surface') {
      if (resolution.surface.canvas === 'none') {
        throw new Error(
          `gate_view_without_canvas:${value}: 「${resolution.surface.label}」没有画布落点`
        );
      }
      return value;
    }
    if (resolution.kind === 'parked') {
      throw new Error(
        `gate_view_parked:${value}: 「${resolution.parked.label}」保留了契约（${resolution.parked.capability}）但没有界面（ADR 0024）`
      );
    }
    throw new Error(`gate_view_unknown:${value}: 已登记的面是 ${surfaces.canvasViewIds.join(', ')}`);
  };
}
