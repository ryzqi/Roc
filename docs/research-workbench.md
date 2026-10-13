# 科研工作台

Roc 默认打开项目列表。未知 `page` 或从设置页返回时落到 `research`。进入某一个研究项目后才打开该项目的科研工作台。对话、文件、任务等是挂在当前项目上的科研服务。

术语边界见 [CONTEXT.md](../CONTEXT.md)。**研究项目工作台**是总览投影：当前阶段、阶段运行、工件、人工闸门和索引状态。文献、证据、Idea Canvas、实验、文稿、图稿和知识库在阶段工作区，不塞进总览。

## 入口

- Renderer：`src/renderer/views/research/ResearchAppShell.tsx`
- 路由：`research-route.ts`（`project` / `view` / `stage`）
- 阶段组：`research-stage-groups.ts`
- 主进程：`src/main/plugins/research/`，`loadPhase: critical`
- 数据根：`~/.roc`；库、索引、实验、导出分别在 `research-library` / `research-index` / `research-experiments` / `research-exports`

无项目 id 时停在项目列表，不自动进入上次或第一个项目。列表用卡片网格；空态只显示「新建研究项目」，点新建才出标题、研究目标、语言和工作目录。创建必须选择目录，一个目录同时只属于一个研究项目。创建后进入该项目科研工作台，默认总览。顶栏「所有项目」返回列表并卸掉当前项目。缺目录的旧项目可以进入总览，但打开文件与代码前必须先绑定工作目录。文件与代码打开的是该项目目录，不是全局计算目录。设置里不再保留默认工作区。

当前下一步钉在科研工作台壳上，和阶段条同一层，总览和阶段工作区都能看见。细条在没有对象时只有主按钮；有工件时加一行标题；要重试时加一行原因的第一句。运行中是状态句加次级「取消运行」。待审核时主按钮是「确认通过」或「接受稿件」，退回修改和要求修订在同一条上但为次级。阶段工作区不再放流程按钮，只留编辑面板和可选的阶段指令；指令留空时用研究目标。解析模型不出现在总览，只在打开「发现与阅读」且模型未就绪时提供下载。

项目内快捷键：`1` 总览，`2` 活动，`3` 溯源。`Escape` 关闭抽屉、活动栏或错误条。

## 对话驱动阶段

研究助手是主入口，拿到的科研工具按当前项目绑定（`src/main/plugins/agent/research-tools.ts`）：`research_overview`、`research_list_artifacts`、`research_read_artifact`、`research_list_evidence`、`research_search_knowledge`、`research_search_literature`、`research_capture_evidence`、`research_stage_runs`、`research_run_stage`、`research_cancel_stage_run`、`research_approve_gate`。

工具名与权限进入本轮能力清单（`researchProjectId` 写进运行快照），所以运行时的工具集和冻结的清单一致。阶段推进仍然是服务端的阶段角色运行（`research_run_stage` 启动，后台继续，不阻塞对话）；阶段角色运行降级为对话代理调用的内部工具。

人工闸门没有取消：`research_approve_gate` 用 LangGraph `interrupt` 在对话里发出批准/退回卡片，用户决定后才调用 `research.workflow.transition`，与界面阶段条按钮同一条路径（含图稿/导出校验）。

论文正文的真身是项目工作目录里的 LaTeX 文件，对话代理用文件工具改、用 shell 编译；右栏读工作区 git diff 显示改动。

## 壳层视图

| `view` | 界面 | 内容 |
| --- | --- | --- |
| `changes` | `ResearchChangesView` | 本次对话产生的文件改动（工作目录 diff）、阶段产物和阶段运行。默认视图。 |
| `overview` | `ResearchOverviewView` | 研究目标、当前阶段、闸门、索引、流水线、最近活动。只读。 |
| `activity` | `ResearchActivityView` | 流程事件与阶段运行。 |
| `provenance` | `ResearchProvenanceView` | 工件、证据、来源。 |
| `stage` | `ResearchStageWorkspace` | 当前阶段组的可编辑面板。二级视图。 |

非当前阶段组只读。设置组（嵌入配置、阶段模型）始终可写。

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

`research-services.ts` 把既有能力标成项目服务，不另起运行时：

| 服务 | 视图 | 说明 |
| --- | --- | --- |
| 研究助手 | `chat`（解析为 research + 助手叠层） | 绑定当前项目、驱动阶段的对话 |
| 活动与运行 | `tasks-board` | 任务、审批、后台运行 |
| 文件与代码 | `workspace` | 项目文件、Git、终端 |
| 连接器 | `mcp` | MCP 授权 |
| 技能 | `skills` | 按阶段可调用的 Skill |
| 项目记忆 | `memory` | 会话与自动记忆 |
| 运行诊断 | `diagnostics` | 失败运行与主机状态 |

窄屏下服务进抽屉。研究助手是改论文和推进阶段的主入口，开在助手叠层里。

## 研究助手入口与叠层

没有独立的「对话优先」主视图。`openMainPage('chat')` 不会切到独立对话页：AppShell 的导航处理把它解析成 `activeView = research` 加助手叠层（URL 写成 `?page=research&assistant=1`）。因此 `RailOverlay` 的导轨按钮（`.rail-button`）在当前产品里不渲染；打开右侧工作台走研究壳的画布工具（`research-shell-canvas-tools` 里的「文件 / Git / 终端」，对应 `research-shell-canvas-tool-<tool>`），它会设 `workbenchVisible` 而不改 `activeView`。

叠层打开时对话归叠层：研究壳自己不再渲染对话列（`research-cockpit-chat`），也不会挂第二个 `Chat`，所以全局只有一个 `chat-view` 与一个 composer；壳网格同步收成两列（`.research-cockpit--no-chat`）。`research-shell-assistant` 这个入口同时承担「新建对话」（`onOpenResearchAssistant` 接的是 `startNewConversation`）。

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
