# 科研工作台

Roc 默认打开项目列表。未知 `page` 或从设置页返回时落到 `research`。进入某一个研究项目后才打开该项目的科研工作台。对话、文件、任务等是挂在当前项目上的科研服务。

术语边界见 [CONTEXT.md](../CONTEXT.md)。**研究项目工作台**是总览投影：当前阶段、阶段运行、工件、人工闸门和索引状态。文献、证据、Idea Canvas、实验、文稿、图稿和知识库在阶段工作区，不塞进总览。

## 入口

- 壳：`src/renderer/app/AppShell.tsx`（顶栏 + 左栏 + 画布 + 助手；`WorkspaceLayout.tsx` 管三栏弹性与窄窗抽屉）
- 窗口壳：`src/renderer/shell/WindowChrome.tsx`；左栏：`shell/LeftSidebar.tsx`；画布：`canvas/WorkspaceCanvas.tsx`
- 路由：`src/renderer/app/routes.ts`（`page` / `project` / `view` / `stage` / `tool` / `assistant`，ADR-M05）
- 视图注册：`src/renderer/app/view-registry.ts`（懒加载 + 解析跟踪；每个视图一个真实 `import()`）
- 阶段组：`src/renderer/canvas/workflow/stage-groups.ts`
- 主进程：`src/main/plugins/research/`，`loadPhase: critical`
- 数据根：`~/.roc`；库、索引、实验、导出分别在 `research-library` / `research-index` / `research-experiments` / `research-exports`

无项目 id 时停在**项目门户**，不自动进入上次或第一个项目。门户用卡片网格；空态只显示「新建研究项目」，
点新建才出标题、研究目标、语言和工作目录。创建必须选择目录，一个目录同时只属于一个研究项目。
创建后进入该项目的工作台，默认落总览（`view=overview`）。顶栏「所有项目」返回门户并卸掉当前项目。
缺目录的旧项目可以进入总览，但打开文件与代码前必须先绑定工作目录 —— 绑定入口在左栏（`sidebar-files-binding`），
设置里不再保留默认工作区。

当前下一步钉在总览与阶段工作区里（`workflow-next-strip`），和阶段条同一层。
细条在没有对象时只有主按钮；有工件时加一行标题；要重试时加一行原因的第一句。
运行中是状态句加次级「取消运行」。待审核时主按钮是「确认通过」或「接受稿件」，退回修改和要求修订在同一条上但为次级。
阶段工作区不再放流程按钮，只留编辑面板和可选的阶段指令；指令留空时用研究目标。
解析模型不出现在总览，只在打开「发现与阅读」且模型未就绪时提供下载。

快捷键：`⌘K` 搜索、`⌘,` 设置、`⌘J` 助手、`⌘B` 左栏；项目内 `1` 总览、`2` 活动、`3` 溯源。
`Escape` 关闭抽屉、浮层或错误条。

## 对话驱动阶段

研究助手是主入口，拿到的科研工具按当前项目绑定（`src/main/plugins/agent/research-tools.ts`）：`research_overview`、`research_list_artifacts`、`research_read_artifact`、`research_lint_manuscript`、`research_list_evidence`、`research_search_knowledge`、`research_search_literature`、`research_capture_evidence`、`research_stage_runs`、`research_run_stage`、`research_cancel_stage_run`、`research_approve_gate`。

`research_lint_manuscript` 是唯一的确定性检查入口（Vale，见 [research-prose.md](research-prose.md)）：它只读，不改正文，草稿也可以检查。

工具名与权限进入本轮能力清单（`researchProjectId` 写进运行快照），所以运行时的工具集和冻结的清单一致。阶段推进仍然是服务端的阶段角色运行（`research_run_stage` 启动，后台继续，不阻塞对话）；阶段角色运行降级为对话代理调用的内部工具。

人工闸门没有取消：`research_approve_gate` 用 LangGraph `interrupt` 在对话里发出批准/退回卡片，用户决定后才调用 `research.workflow.transition`，与界面阶段条按钮同一条路径（含图稿/导出校验）。

论文正文的真身是项目工作目录里的 LaTeX 文件，对话代理用文件工具改、用 shell 编译；右栏读工作区 git diff 显示改动。

## 壳层视图

画布一次只显示一个视图（`view` 参数，注册表在 `src/renderer/app/view-registry.ts`）：

| `view` | 界面 | 内容 |
| --- | --- | --- |
| `overview` | `ProjectOverview` | 研究目标、当前阶段、闸门、索引、最近活动。默认视图。 |
| `stage` | `StageWorkspace` | 当前阶段组的可编辑面板（非当前组只读）。 |
| `activity` | `ActivityView` | 流程事件、阶段运行与任务。 |
| `provenance` | `ProvenanceView` | 工件、证据、来源。 |
| `changes` | `ChangesView` | 工作目录 diff、阶段产物与阶段运行。 |
| `literature` | `LiteratureHubView` | 文献库 / 知识库 / Wiki / 图谱 / RAG Studio。 |
| `latex` | `LatexPanel` | 文稿与模板编译。 |
| `terminal` | `TerminalView` | 真实 pty 会话。 |
| `files` | `FilesView` | 文件树 + 预览/编辑（PDF 走 `files.preview` 的协议 URL）。 |
| `tasks` | `TasksView` | 任务看板、审批、后台任务。 |
| `diagnostics` | `DiagnosticsView` | 失败运行、指标、打包诊断。 |
| `mcp` / `skills` / `memory` | `ManagementView` | 管理面板的三个分区（与抽屉共用同一组组件）。 |

抽屉（`ModalShell`）给 Git 与管理面板；浮层给 ⌘K 搜索与设置。两者都不卸载当前项目。
窗口 ≤1099px 时左栏与助手改成抽屉（ADR-M12）。

## 阶段组

| 组 | 流程阶段 | 面板 |
| --- | --- | --- |
| 发现与阅读 | discovery / retrieval / reading | 文献库、知识库 |
| 构思与计划 | ideation / planning | 构思（Idea Canvas） |
| 实验与检查 | experiment / figure | 实验、图稿 |
| 写作与审阅 | writing / review / revision | 正文、文稿 |
| 发布与复现 | export | 图稿导出 |
| 项目设置 | （无流程阶段） | 嵌入配置、阶段模型 |

当前阶段可开始 / 暂停 / 完成、提交审核、批准或退回。审稿待批时还需选择接受或要求修订。角色运行绑定当前项目与阶段；`ownerRunId` 由服务写入。

## 科研服务

科研服务不再有独立的导轨或壳层：它们就是画布视图、抽屉和助手。
对话绑定当前项目、驱动阶段（`research_*` 工具在运行快照里），其余服务按视图落位：

| 服务 | 落点 | 说明 |
| --- | --- | --- |
| 研究助手 | 助手列 / 窄窗抽屉（`⌘J`） | 绑定当前项目、驱动阶段的对话 |
| 活动与运行 | `view=activity` + `view=tasks` | 流程事件、阶段运行、任务与审批 |
| 文件与代码 | `view=files` / `view=changes` / `view=terminal` + Git 抽屉 | 项目文件、diff、真实 pty |
| 连接器 | `view=mcp`（或管理抽屉） | MCP 授权；审批模式在设置中心 |
| 技能 | `view=skills` | 导入 / 启停 / 文件预览 |
| 项目记忆 | `view=memory` | 5 个槽位、容量、会话检索、注入预览 |
| 运行诊断 | `view=diagnostics` | 失败运行与主机状态 |

研究助手是改论文和推进阶段的主入口，开在右侧助手列；`titlebar-toggle-assistant` 与 `⌘J` 都可开关。

## 研究助手入口

没有独立的「对话优先」主视图。`page=chat` 会被路由规范化成 `page=research&assistant=1`
（`src/renderer/app/routes.ts`），也就是「留在当前项目 + 打开助手」。

助手是布局的一部分而不是浮层：宽窗占右列（`assistant-panel`），≤1099px 变抽屉
（`WorkspaceLayout`，`assistant-drawer`）。转录与输入区只有一个实例，切项目会清空当前 thread。
会话历史在左栏的会话 tab（`sidebar-tab-sessions`），行是 `session-row-<threadId>`。

## 阶段角色

`role-profiles.ts` 为每个阶段固定 role、Skill 和能力白名单。Skill 正文在 `resources/research-skills/`。

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

## 相关文档

- [Idea Canvas](research-ideas.md)
- [实验运行](research-experiments.md)
- [图稿](research-figures.md)
- [最终导出](research-exports.md)
- [架构 ADR](adr/0001-research-workbench-architecture.md)
