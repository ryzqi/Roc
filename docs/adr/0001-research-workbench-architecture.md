# Research workbench architecture

Roc 科研助手在现有 Electron/React、插件、类型安全 IPC 和 SQLite Kernel 之上增加科研域，而不是另起一套运行时。科研域采用项目中心 + 全局文献库，持久化 11 阶段状态机、工件、Provenance 和人工闸门；检索使用 SQLite FTS5 与 sqlite-vec 的混合索引，RRF 合并排序；阶段 Agent 通过角色 Skill 白名单运行。这样保留现有安全边界、备份恢复和 Agent 执行能力，同时让论文、知识库、实验和图稿具备统一的可恢复数据模型。

