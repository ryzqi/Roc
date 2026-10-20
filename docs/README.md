# 文档

产品口径以仓库根 [README.md](../README.md) 和 [CONTEXT.md](../CONTEXT.md) 为准。本目录是科研合同与发布核对。

| 文档 | 内容 |
| --- | --- |
| [research-workbench.md](research-workbench.md) | 默认壳层、阶段组、科研服务、角色白名单 |
| [research-ideas.md](research-ideas.md) | Idea Canvas 与项目语言 |
| [research-experiments.md](research-experiments.md) | Python / R / Julia 实验运行 |
| [research-figures.md](research-figures.md) | 可复现图稿渲染与审核 |
| [research-exports.md](research-exports.md) | 批准正文与图稿的最终 ZIP |
| [rtk-integration.md](rtk-integration.md) | bundled RTK 压缩 shell 输出 |
| [release/release-candidate-checklist.md](release/release-candidate-checklist.md) | 发布前命令 |
| [adr/0025-alignment-audit-and-cleanup.md](adr/0025-alignment-audit-and-cleanup.md) | **视觉与版式的对齐标准**（token、半径、字号、间距、栏序）与测试数据清理 |

> 全局视觉与交互规范曾在 `design-system/MASTER.md`，该文件已在 `1da2e0e9` 删除；它的 §1.4（圆角 6/8/10）、
> §5（栏序「左栏 / 画布 / 助手」）由 ADR 0025 作废，§11（不做路由 fade）由 ADR 0023 作废。
> **今天的设计真身是**：`src/renderer/styles/tokens.css`（颜色与刻度）、`src/renderer/shared/motion.ts`（动效）、
> `research-studio/`（只读逐面参照，自述见它的 [README](../research-studio/README.md)）与 ADR 0025（哪些地方有意不照抄）。

## 测试 seam

产品代码里的 `ROC_SMOKE` 分支是**原生对话框的替身**：闸门与 smoke 用 Playwright 驱动打包应用，
点不到系统面板，也不该被系统面板拦住。它们保留是有意的（ADR 0025 §9），逐处列在这里以便审计：

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

| ADR | 决定 |
| --- | --- |
| [0001](adr/0001-research-workbench-architecture.md) | 科研域架构 |
| [0002](adr/0002-project-list-entry.md) | 项目列表作为入口，科研服务只在项目内 |
| [0003](adr/0003-overview-next-action.md) | 总览的主操作是当前下一步 |
| [0004](adr/0004-first-run-uses-research-goal.md) | 第一次启动用研究目标，人留在总览 |
| [0005](adr/0005-running-status-not-action.md) | 角色运行中，主信息是状态不是操作 |
| [0006](adr/0006-complete-discovery-shows-strategy.md) | 发现运行成功后，主操作是完成并进入检索 |
| [0007](adr/0007-same-next-action-every-stage.md) | 每个研究阶段用同一条当前下一步 |
| [0008](adr/0008-failure-retries-same-instruction.md) | 运行失败后只重试同一阶段指令 |
| [0009](adr/0009-create-form-keeps-language.md) | 创建研究项目仍收集文稿语言 |
| [0010](adr/0010-gate-forward-is-primary.md) | 待审核时主按钮只保留前进决定 |
| [0011](adr/0011-parser-models-not-on-first-screen.md) | 解析模型不占据新建项目的首屏 |
| [0012](adr/0012-parser-models-block-only-parse.md) | 解析模型只卡住这一次解析 |
| [0013](adr/0013-unstated-instruction-uses-goal.md) | 没写阶段指令时用研究目标 |
| [0014](adr/0014-stage-workspace-has-no-workflow-buttons.md) | 阶段工作区不放流程按钮 |
| [0015](adr/0015-cancel-is-secondary-no-pause.md) | 运行中只留次级取消，不提供暂停 |
| [0016](adr/0016-stop-retries-instead-of-resume.md) | 取消或中断之后重试，不恢复阶段 |
| [0017](adr/0017-reject-retries-before-resubmit.md) | 退回之后先重试，不立刻再提交 |
| [0018](adr/0018-next-action-stays-in-shell.md) | 当前下一步钉在科研工作台的壳上 |
| [0019](adr/0019-shell-strip-is-only-the-next-action.md) | 壳上只钉下一步细条 |
| [0020](adr/0020-conversation-drives-stages.md) | 对话驱动阶段 |
| [0021](adr/0021-new-frontend-ia-supersedes-no-sidebar-rule.md) | 新前端 IA 取代「无全局左栏」 |
| [0022](adr/0022-single-frontend-after-cutover.md) | 切换后仓库里只有一套前端 |
| [0023](adr/0023-motion-parity-with-research-studio.md) | 动效回到 `research-studio` 口径 |
| [0024](adr/0024-stage-surface-removed-for-parity.md) | 阶段面已删除 |
| [0025](adr/0025-alignment-audit-and-cleanup.md) | 对齐审查：视觉以参考为准 + 死类与脚手架清理 |

> ADR 0003–0020 描述的是**已被 ADR 0024 删除**的界面（总览、阶段条、阶段工作区、人工闸门、下一步细条）。
> 保留为历史记录，不代表当前产品。

工具链源与许可证：[resources/research-runtime/README.md](../resources/research-runtime/README.md)。阶段 Skill：[resources/research-skills](../resources/research-skills)。`archive/` 是历史快照（仅本地保留，未纳入 Git），不代表当前产品。
