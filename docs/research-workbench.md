# 科研工作台

Roc 默认打开**项目门户**（`page=research`，未选项目）。进入某一个研究项目后才打开该项目的**三栏工作台**。
左栏的会话、文献、文件与画布上的服务都属于**当前项目**，不是全局导航。

术语边界见 [CONTEXT.md](../CONTEXT.md)。

## 入口

- 壳：`src/renderer/app/AppShell.tsx`（顶栏 + 左栏 + 助手 + 画布）
- 三栏弹性与窄窗抽屉：`src/renderer/app/WorkspaceLayout.tsx`
- 顶栏 `src/renderer/shell/WindowChrome.tsx`；左栏 `src/renderer/shell/LeftSidebar.tsx`；
  画布 `src/renderer/canvas/WorkspaceCanvas.tsx`；助手 `src/renderer/assistant/AssistantPanel.tsx`
- 路由：`src/renderer/app/routes.ts`（`page` / `project` / `view` / `tool` / `file` / `assistant`）
- **面表**：`src/shared/surfaces.ts`（「有哪些面、每个落在哪」的唯一真理源）
- 视图注册：`src/renderer/app/view-registry.ts`（懒加载 + 解析跟踪）
- 主进程：`src/main/plugins/research/`，`loadPhase: critical`
- 数据根：`~/.roc`；库、索引、实验、导出分别在 `research-library` / `research-index` /
  `research-experiments` / `research-exports`

无项目 id 时停在项目门户，不自动进入上次或第一个项目。门户用卡片网格（`portal-grid`）；空态只显示
「新建研究项目」（`portal-new-project`），点新建才出标题、研究目标、语言和工作目录（`project-form-*`）。
创建必须选择目录，一个目录同时只属于一个研究项目。创建后进入该项目的工作台，默认落 `view=latex`。
顶栏「所有项目」返回门户并卸掉当前项目。缺目录的旧项目可以进入，但打开文件与代码前必须先绑定工作目录——
绑定入口在左栏（`sidebar-files-binding`）。已归档项目只读（`project-readonly-banner`）：不能开新运行、
不能改产物、不能写文件。

## 面表：壳里有哪些面

一个面按**落点**分四种，全部声明在 `src/shared/surfaces.ts`（`resolveSurface` 是唯一的解释入口）。
渲染层、preload 与闸门脚本读同一张表；类型（`CanvasTabId` / `CanvasViewId` / `DrawerSectionId`）与集合都由它
派生，所以不可能互相漂移。

| 落点 | 面 | 说明 |
| --- | --- | --- |
| 画布一级 tab | 文献 / LaTeX / 终端 | `canvasTabIds`，顺序即 tab 条顺序 |
| 画布视图（`?view=`） | 记忆 / 技能 / MCP | `canvasViewIds`；与抽屉共用同一组面板（`management-shell-parts`） |
| 抽屉分区 | 记忆 / 技能 / MCP / 任务 | `drawerSectionIds`；**任务只有抽屉一个落点**（两份界面盯一个数据集是发散） |
| 浮层 | ⌘K 搜索 / 设置 | 不进 URL 的瞬时选择器另计 |

缺少画布视图是 `latex`（`defaultViewId`）。

**没有画布落点的东西**：文件由左栏文件树 + 预览浮层承载（`?tool=files` 只把左栏切到文件 tab）；
工作区 diff 由顶栏 Git 抽屉承载（`?tool=git`，`git-panel`）；后台任务只有管理抽屉。

每个面由三类东西共同定义，且只有一处声明：**分类**在面表，**URL 形状**在 `routes.ts`，**外观**（图标与
色相）在渲染层（`WorkspaceCanvas` 的 `TAB_APPEARANCE`，以 `CanvasTabId` 为键的 `Record`，漏一个 tab 编译不过）。

## URL 契约

`src/renderer/app/routes.ts` 是唯一读写入口：

```text
?page=research|settings          外层
  ?project=<id>                   有值即「在项目内」
  ?view=<canvas view>             画布视图
  ?tool=files|git                 抽屉 / 左栏的辅助面
  ?file=<workspace 相对路径>      左栏文件树里选中并预览的文件
  ?assistant=1                    助手列打开
```

`page=research-new`（菜单「新建研究项目」）规范化为 `page=research` + `newProject=1`，由门户展开创建表单。
`?stage=` 曾经是契约的一部分；阶段面删除后**不再读写**——来的值直接忽略，所以原生菜单与旧深链不会报错。
`page=chat` 规范化为 `page=research&assistant=1`（留在当前项目 + 打开助手）。

**重载后应当还在的面进 URL**（画布视图、Git 抽屉、设置、助手列）；**瞬时选择器不进**（⌘K 搜索、各类表单浮层）。

## 助手与阶段

研究助手是**唯一执行入口**（[ADR 0020](adr/0020-conversation-drives-stages.md)）。它在助手列
（`assistant-panel`；≤1099px 是抽屉 `assistant-drawer`，⌘J / `titlebar-toggle-assistant` 开关），
拿到的科研工具按当前项目绑定（`src/main/plugins/agent/research-tools.ts`；工具名与权限的唯一来源是
`RESEARCH_TOOL_DESCRIPTORS`）：

`research_overview`、`research_list_artifacts`、`research_read_artifact`、`research_lint_manuscript`、
`research_list_evidence`、`research_capture_evidence`、`research_search_knowledge`、
`research_search_literature`、`research_stage_runs`、`research_run_stage`、`research_cancel_stage_run`、
`research_approve_gate`。

- 工具名与权限进入本轮能力清单（`researchProjectId` 写进运行快照），所以运行时的工具集和冻结的清单一致。
- `research_lint_manuscript` 是唯一的确定性文稿检查入口（Vale，见 [research-prose.md](research-prose.md)）：
  只读，不改正文，草稿也可以检查。
- 阶段推进仍是服务端的阶段角色运行（`research_run_stage` 启动，后台继续，不阻塞对话）。阶段角色运行是
  **对话代理调用的内部工具**，不是并列的第二种执行入口。
- 人工闸门没有取消：`research_approve_gate` 用 LangGraph `interrupt` 在对话里发出批准 / 退回卡片，
  用户决定后才调用 `research.workflow.transition`（含图稿 / 导出校验）。
- 论文正文的真身是项目工作目录里的 `.tex` / `.bib` 文件；对话代理用文件工具改、用 shell 编译。
  LaTeX 画布 tab 编辑的是同一批工作区文件（保存走 `files.writeText`，留 recovery point）。

历史会话属于当前项目，列在左栏的会话 tab（`sidebar-tab-sessions`），行是 `session-row-<threadId>`。
切项目会清空当前 thread；项目门户不显示任何会话。

## 阶段角色

`src/main/plugins/research/role-profiles.ts` 为每个阶段固定 role、Skill 与能力白名单。Skill 正文在
`resources/research-skills/`。

| 阶段 | Skill | 结构化产出 |
| --- | --- | --- |
| discovery | `roc-research-discovery` | 检索策略 |
| retrieval | `roc-literature-retrieval` | 文献集 |
| reading | `roc-paper-reading` | 阅读笔记 |
| ideation | `roc-research-ideation` | Idea Canvas |
| planning | `roc-research-planning` | 研究方案 |
| experiment | `roc-experiment-provenance` | 实验运行 |
| figure | `roc-scientific-figure` | 图稿 |
| writing | `roc-academic-writing` | 正文 |
| review | `roc-peer-review` | 审稿意见 |
| revision | `roc-revision-coach` | 修订正文 |
| export | `roc-manuscript-export` | 导出包 |

模型不能指定项目身份，也不能跳过人工批准或直接写最终 ZIP。未发布的真实工件不会被空产物顶替。

## 今天没有界面的域

七个域**有契约、有数据库、没有界面**（[ADR 0024](adr/0024-stage-surface-removed.md) 有意保留），
声明在 `src/shared/surfaces.ts` 的 `PARKED_CAPABILITIES`：**构思、实验、图稿、正文、导出、模板包、阶段策略**。
深链到它们的 `?view=` 会明确失败（`resolveSurface` 返回 `parked`），而不是静默落回默认视图。
能力本身仍可从对话代理调用；契约口径由这几份文档记：

- [Idea Canvas](research-ideas.md)
- [实验运行](research-experiments.md)
- [图稿](research-figures.md)
- [最终导出](research-exports.md)

## 快捷键

| 键 | 作用 | 归谁 |
| --- | --- | --- |
| ⌘, | 设置 | 原生菜单 |
| ⌘N | 新建研究项目 | 原生菜单 |
| ⌘B | 折叠 / 展开左栏 | 渲染层 |
| ⌘J | 折叠 / 展开助手 | 渲染层 |
| ⌘K | 搜索（浮层打开后仍是它） | 渲染层 |
| ⌘D | 切换主题 | 渲染层 |
| Esc | 关闭当前层 | `useOverlayBehavior`（不在快捷键表里） |

原生菜单注册 ⌘, 与 ⌘N，Electron 先消费，所以渲染层不重复实现。浮层打开时面板与导航键被抑制，⌘K 保持可用。
渲染层快捷键由 `src/renderer/app/shortcuts.ts` 注册；浮层的 Esc 行为由 `useOverlayBehavior` 管理。

## 相关文档

- [术语（CONTEXT.md）](../CONTEXT.md)
- [文稿检查（Vale）](research-prose.md)
- [RTK 集成](rtk-integration.md)
- [架构 ADR](adr/0001-research-workbench-architecture.md)
