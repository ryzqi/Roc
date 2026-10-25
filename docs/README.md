# 文档

产品口径以仓库根 [README.md](../README.md) 和 [CONTEXT.md](../CONTEXT.md) 为准。本目录收科研合同与壳层口径。

| 文档 | 内容 |
| --- | --- |
| [research-workbench.md](research-workbench.md) | 壳层、面表、URL 契约、助手工具、阶段角色、快捷键 |
| [research-ideas.md](research-ideas.md) | Idea Canvas 与项目语言 |
| [research-experiments.md](research-experiments.md) | Python / R / Julia 实验运行 |
| [research-figures.md](research-figures.md) | 可复现图稿渲染与审核 |
| [research-prose.md](research-prose.md) | 文稿检查（Vale）：投影、规则集与运行边界 |
| [research-exports.md](research-exports.md) | 批准正文与图稿的最终 ZIP |
| [rtk-integration.md](rtk-integration.md) | bundled RTK 压缩 shell 输出 |
| [awesome-scientific-writing-evaluation.md](awesome-scientific-writing-evaluation.md) | 外部开源清单对 Roc 的适用性评估（评估结论，非待办） |
| [轻量依赖调研](reports/2026-10-25-lightweight-dependency-review.md) | 当前依赖成本、GitHub 替代方案、迁移边界与验证顺序（评估结论，非待办） |

视觉、版式与动效没有单独的规范文档：真身是 [`src/renderer/styles/tokens.css`](../src/renderer/styles/tokens.css)
与 [`src/renderer/shared/motion.ts`](../src/renderer/shared/motion.ts)，取舍理由见
[ADR 0023](adr/0023-visual-and-motion-spec.md)。

## 测试 seam

产品代码里的 `ROC_SMOKE` 分支是**原生对话框的替身**：闸门与 smoke 用 Playwright 驱动打包应用，
点不到系统面板，也不该被系统面板拦住。它们保留是有意的——删掉会让全部闸门变红，换成测试注入则要同时改七个脚本。
逐处列在这里以便审计：

| 位置 | 行为 | 谁在用 |
| --- | --- | --- |
| `src/main/ipc/files-ipc.ts` | `files.selectFromDialog` 返回工作区里 seed 出来的 `assets/smoke-image.png` | `verify-p4-assistant`（图片附件）、`smoke-electron` |
| `src/main/ipc/shell-ipc.ts` | 原生确认框自动同意，并把请求先写进日志 | `verify-p3-workspace`（丢弃改动）、`verify-p9-management` |
| `src/main/chromium-runtime-flags.ts` | 打开远程调试端口（`0` = 让 Chromium 选） | 全部闸门与 smoke |
| `src/main/macos-environment.ts` | 跳过登录 shell 的 PATH 采集 | 全部闸门与 smoke |
| `src/main/main-kernel-bootstrap.ts` | `AppStatus.mode = 'smoke'` | 闸门断言启动态 |

数据根不在用户目录：闸门以 `ROC_DATA_ROOT=<临时目录>` 启动，所以 smoke 不会污染真实项目数据
（`tests/smoke/lib/fixtures.mjs`）。

## ADR

科研域与界面行为的决定记录在 [adr/](adr/)。改壳层或阶段行为前先读相关条目。
编号按时间递增，不连续处表示该条目已删除。

| ADR | 决定 |
| --- | --- |
| [0001](adr/0001-research-workbench-architecture.md) | 科研域架构 |
| [0002](adr/0002-project-list-entry.md) | 项目列表作为入口，科研服务只在项目内 |
| [0020](adr/0020-conversation-drives-stages.md) | 对话驱动阶段：研究助手是唯一执行入口 |
| [0021](adr/0021-three-column-workbench-ia.md) | 三栏工作台 IA、断点与配置的唯一可写位置 |
| [0022](adr/0022-single-frontend-after-cutover.md) | 切换后仓库里只有一套前端 |
| [0023](adr/0023-visual-and-motion-spec.md) | 视觉与动效口径、有意为之的取舍 |
| [0024](adr/0024-stage-surface-removed.md) | 阶段面已删除；七个域登记为「有契约、无界面」 |
| [0025](adr/0025-typst-report-engine.md) | 导出报告走 Typst；样式是数据 |
| [0026](adr/0026-async-secret-storage.md) | 密钥存储只有异步一条路；重写必须带守卫 |

工具链源与许可证：[resources/research-runtime/README.md](../resources/research-runtime/README.md)。阶段 Skill：[resources/research-skills](../resources/research-skills)。
