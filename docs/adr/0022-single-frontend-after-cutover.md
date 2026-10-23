# 切换后仓库里只有一套前端

P0–P9 期间新旧两套前端并行存在：旧壳在 `src/renderer/`，新壳在 `src/renderer-next/`，入口由临时环境变量 `ROC_RENDERER=next` 决定。并行是迁移期的脚手架，不是产品形态：两套 DOM、两套测试、两套样式同时维护，任何一次 UI 改动都要判断「改哪一套」。

## 决定

- **一次原子切换**：入口改动（`electron.vite.config.ts` 去掉别名）、目录改名（`git mv src/renderer-next src/renderer`）与旧壳删除放在**同一个提交**里，便于整体 revert。
- **不保留兼容层**：旧壳的 testid、旧视图 id、旧 URL 参数一律不做别名映射；旧壳的 smoke 套件直接删除，新壳的关键路径用新壳的 testid 重写。
- **后端零改动**：契约、schema、插件与数据库都不动，`pnpm check:ipc` 是「后端未变」的证明。
- 旧壳拥有的资产按需要搬迁：`declare module '*.css'`（旧的 `vite-env.d.ts`）移到新壳自己的 `src/renderer/vite-env.d.ts`。
- 记忆页最近查看的分类是界面偏好，由 `src/renderer/app/ui-state.ts` 使用 `roc.ui.memory.category` 保存；值仅允许五类记忆的分类标识，不保存正文、草稿或预览。首次进入时，有绑定项目则显示项目记忆，否则显示全局长期记忆；项目分类在未绑定项目时回退到全局长期记忆。抽屉与画布共用同一实现。

## 理由

用户裁定「全面迁移过去，全部采用新前端」，并且「不向后兼容」。并行期的临时开关（`ROC_RENDERER`）与旧资产长期留存会让仓库无法判断哪一套是真的，也会让后续每个任务多一次「这是哪一套」的判断成本。

## 代价

- 切换后 `pnpm typecheck` 会暴露所有对已删文件的残留引用——这是设计意图，不是意外。
- 旧壳的 smoke 断言（约 200KB）不能复用：新壳的验收改由阶段闸门（`pnpm verify:p3…p9`）与重写的 `pnpm test` / `pnpm smoke:electron` 承担。
