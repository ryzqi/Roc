# ADR 0001：记忆系统重构

- 日期：2026-05-25
- 状态：Accepted
- Spec：`docs/superpowers/specs/2026-05-25-memory-system-rebuild-design.md`

## 上下文

Roc 原始记忆系统采用 5 层（hot/warm/cold/session/candidate）+ 人审 candidate + ReadOnly `/memory/` + 自研 `SqliteLangGraphStore` 单向投影模型。痛点：agent 无法主动写入；system prompt 不携带任何记忆；检索 FTS5 自报 degraded；未配置 vector；冲突检测过弱；与 deepagents 原生 backend 模型重复造轮子。

## 决策（D1-D10）

| # | 决策 |
|---|---|
| D1 | 完全废弃人审 candidate / conflict 工作流，agent 自由读写 |
| D2 | Hermes 式 frozen snapshot：USER.md + AGENTS.md + MEMORY.md 在 session boot 时冻结注入 system prompt |
| D3 | 检索仅用 SQLite FTS5，不引入向量 |
| D4 | 全量 user/assistant/tool/system 消息自动入库 `session_messages`，FTS5 索引；90 天 retention sweep |
| D5 | Filesystem 模型：`/memory/` 复用 deepagents 原生 `FilesystemBackend`，写入边界包装做安全扫描 + 容量拦截 |
| D6 | 三文件 × (global + workspace) 结构；USER 永远 global；AGENTS/MEMORY 由 workspace 文件覆盖 global |
| D7 | 容量溢出 → consolidator subagent 自动 LLM 压缩 |
| D8 | Hermes 4 项写入安全扫描全做：prompt injection / credential / SSH backdoor / 不可见 Unicode |
| D9 | 实现 OpenClaw 式 Pre-Compaction Memory Flush |
| D10 | 旧数据直接 DROP，不迁移、不导出、不备份 |

## 后果

- 删除旧候选、冲突、操作日志、session recall 与 `SqliteLangGraphStore` 投影链路。
- 新记忆文件是真理源，SQLite 只负责 session transcript 与 FTS5 检索。
- prompt cache 友好，frozen snapshot 稳定注入。
- 用户与 agent 写入路径共享同一拦截层。
- 旧候选/冲突 UI 删除，记忆中心从审核台改为浏览/编辑台。

## 参考

- Hermes Agent memory 设计（USER.md + MEMORY.md frozen snapshot + session_search FTS5）
- OpenClaw Pre-Compaction Memory Flush + AGENTS.md 惯例
- deepagents `FilesystemBackend(virtualMode)` + `CompositeBackend`
