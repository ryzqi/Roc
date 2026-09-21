# Research workbench architecture

Roc 是 macOS 科研工作台。科研域建在现有 Electron/React、插件、类型安全 IPC 和 SQLite Kernel 上，不另起运行时。

产品入口是研究项目。Renderer 默认 `page=research`；对话、文件、任务、连接器、技能、记忆和诊断是挂在当前项目上的科研服务。工作台投影只含当前阶段、阶段运行、工件、人工闸门和索引状态。文献、证据、Idea Canvas、实验、文稿、图稿和知识库走阶段工作区。

持久化 11 阶段状态机、工件、Provenance 和人工闸门。检索用 SQLite FTS5 与 sqlite-vec 混合索引，RRF 合并排序。阶段 Agent 通过角色 Skill 白名单运行，生产写入绑定本次阶段运行。这样保留现有安全边界、备份恢复和 Agent 执行能力，同时让论文、知识库、实验和图稿具备统一的可恢复数据模型。

界面已接入：`ResearchAppShell`、阶段组工作区、实验/图稿/导出面板。合同见 [科研工作台](../research-workbench.md)。
