# 切换后仓库里只有一套前端

P0–P9 期间新旧两套前端并行存在：旧壳在 `src/renderer/`，新壳在 `src/renderer-next/`，入口由临时环境变量
`ROC_RENDERER=next` 决定（ADR-M01）。并行是迁移期的脚手架，不是产品形态：两套 DOM、两套测试、两套样式
同时维护，任何一次 UI 改动都要判断「改哪一套」。

## 决定

- **一次原子切换**：入口改动（`electron.vite.config.ts` 去掉别名）、目录改名（`git mv src/renderer-next src/renderer`）、
  旧壳删除、`research-studio/` 删除放在**同一个提交**里，便于整体 revert。
- **不保留兼容层**：旧壳的 testid、旧视图 id、旧 URL 参数一律不做别名映射；旧壳的 smoke 套件直接删除，
  新壳的关键路径用新壳的 testid 重写。
- **后端零改动**：契约、schema、插件与数据库都不动，`pnpm check:ipc` 是「后端未变」的证明。
- 旧壳拥有的资产按需要搬迁：`declare module '*.css'`（旧的 `vite-env.d.ts`）移到新壳自己的
  `src/renderer/vite-env.d.ts`，因为新壳的三个 CSS 副作用导入原本是**借**旧壳的声明通过 typecheck 的。
- **旧前端目录（`research-studio/`）整体删除**：它是迁移的设计权威，不是运行时依赖（ADR-M08）。

## 理由

用户裁定「全面迁移过去，全部采用新前端」，并且「不向后兼容」。并行期的临时开关（`ROC_RENDERER`）
与旧资产长期留存会让仓库无法判断哪一套是真的，也会让后续每个任务多一次「这是哪一套」的判断成本。

## 代价

- 切换后 `pnpm typecheck` 会暴露所有对已删文件的残留引用（R14）——这是设计意图，不是意外。
- 旧壳的 smoke 断言（约 200KB）不能复用：新壳的验收改由七个阶段闸门（`pnpm verify:p3…p9`）与
  重写的 `pnpm test` / `pnpm smoke:electron` 承担。
- `git revert` 能回退这次切换，但回退后 `research-studio/` 也一并回来，设计参考目录的清理需要重新做。
