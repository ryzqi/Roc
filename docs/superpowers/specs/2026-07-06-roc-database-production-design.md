# Roc 数据库生产化设计

## 目标

把 Roc 的本地 SQLite 持久化层重构到单机生产可用状态。这里的生产可用指运行时可靠：数据写入边界清楚，schema 可演进，启动可自检，运行可备份恢复，历史可控清理，关键查询可验证性能。

本设计同时定义一次破坏性重建迁移。迁移阶段按当前需求不追求旧数据完整保留：旧库导出后重建新库，失败记录丢弃，旧工作数据清理，只使用新库。迁移前仍保留一次备份，作为最后恢复点。

## 当前事实

- Roc 当前使用 `better-sqlite3`，每个插件通过 `DatabasePool` 获得独立插件 DB，另有 `core.db`。
- `DatabasePool` 已为连接设置 `journal_mode = WAL` 和 `foreign_keys = ON`。
- `@roc/plugin-agent` 和 `@roc/plugin-task` 都有 `task_threads`、`task_runs`、`task_events` 表，事实源重复。
- `@roc/plugin-agent` 还保存 `session_messages`、`session_messages_fts`、`agent_pending_interrupts`、`agent_run_events`。
- DeepAgents/LangGraph 运行态目前部分放在 `core.db`：`langgraph_checkpoints`、`langgraph_checkpoint_writes`、`langgraph_store_items`、`agent_tool_effects`。
- `context_artifacts` 当前放在 agent 插件 DB。
- memory 插件自己的 audit/event 放在 memory 插件 DB，但长期 memory store 通过 `RocSqliteStore(context.database.getCoreConnection())` 放在 `core.db`。
- schema 主要由各插件 `apply*Schema()` 使用 `CREATE TABLE IF NOT EXISTS` 创建，部分新增列用 `PRAGMA table_info` 检查后 `ALTER TABLE` 补齐。
- 当前没有统一 migration ledger、数据库版本声明、schema checksum、DB health 元数据、备份恢复策略、retention 策略或 query plan 验证。

## 外部依据

- better-sqlite3 官方文档建议用 `db.pragma()` 执行 SQLite PRAGMA；性能文档示例启用 WAL，并说明 durability/performance 需要权衡。
- better-sqlite3 transaction 文档要求 `.transaction()` 中不能混用手写 `BEGIN/COMMIT/ROLLBACK`，也不支持 async transaction function。
- better-sqlite3 backup API 支持在线备份数据库文件。
- SQLite 官方文档将 WAL 用于提升读写并发，并要求考虑 checkpoint。
- SQLite 官方 PRAGMA 文档提供 `foreign_keys`、`quick_check`、`integrity_check`、`optimize`、`wal_checkpoint`、`user_version` 等运行维护能力。
- SQLite FTS5 官方文档支持 external content FTS 和同步 trigger，适合 Roc 当前 `session_messages_fts` 模式。

参考链接：

- better-sqlite3 performance: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md
- better-sqlite3 API: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
- SQLite WAL: https://www.sqlite.org/wal.html
- SQLite PRAGMA: https://www.sqlite.org/pragma.html
- SQLite FTS5: https://www.sqlite.org/fts5.html
- SQLite backup API: https://www.sqlite.org/backup.html

## 设计原则

- 单机本地优先。Roc 是 Electron 桌面应用，不把本地 SQLite 设计成多租户服务端数据库。
- 运行时生产可靠性优先。迁移阶段可破坏旧工作数据，但新运行态必须可恢复、可检查、可诊断。
- 一个事实源。会话、run、event、message 只能有一个 canonical 存储边界。
- 插件边界仍保留。不要把所有表合进一个 `roc.db`。
- `core.db` 只存平台态，业务数据迁出 core。
- 不新增兼容胶水。重建后只保留新结构和必要备份。
- 不依赖 prompt 或 UI 约定维护数据边界。归属、迁移、health、retention、性能约束都落在执行层。
- 关键合同失败显式报错。不能用默认值掩盖缺失字段、无效状态或失败导入。

## 目标数据库归属

### `core.db`

职责：平台态和跨插件基础设施。

保留：

- `plugin_config`
- `plugin_secrets`
- 数据库 registry，例如每个 DB 的 logical name、schema version、last health check
- backup metadata
- restore metadata

不再保存：

- LangGraph checkpointer
- LangGraph store items
- agent tool effects
- memory 文件内容
- agent/session/task 业务事件

### `@roc/plugin-agent.db`

职责：唯一 canonical 会话、运行和 agent runtime store。

保存：

- `agent_threads`
- `agent_runs`
- `agent_events`
- `session_messages`
- `session_messages_fts`
- `agent_pending_interrupts`
- `agent_run_events`
- `langgraph_checkpoints`
- `langgraph_checkpoint_writes`
- `agent_tool_effects`
- `context_artifacts`

规则：

- 正常 chat、plan、background task run 都使用这里的 `thread_id` 和 `run_id`。
- FTS 只服务 session/message recall，不作为长期 memory。
- checkpoint、tool effect、context artifact 归 agent，因为它们是 agent runtime 的恢复和幂等状态。

### `@roc/plugin-memory.db`

职责：长期记忆和 memory 审计。

保存：

- `langgraph_store_items`
- `memory_events`
- `memory_auto_audit`

规则：

- `RocSqliteStore` 的长期 memory store 迁到 memory DB。
- agent 通过注入 store facade 访问 memory DB，不直接依赖 core DB。
- memory file route 仍保持 `/memory/global/` 和 `/memory/workspaces/current/` 语义。

### `@roc/plugin-task.db`

职责：背景任务定义、调度和运行投影。

保存：

- `background_tasks`
- `scheduled_task_runs`

规则：

- 不再保存 `task_threads`、`task_runs`、`task_events`。
- `background_tasks.thread_id` 和 `background_tasks.run_id` 引用 agent canonical ID，但 SQLite 外键不跨 DB 强制执行。
- task detail 的 thread/run/event 历史从 agent canonical 查询。
- task DB 只保留任务定义、调度状态、调度投影、运行统计。

## Canonical 模型

`agent_threads` 替代重复的 `task_threads`：

- `id`
- `kind`: `chat`、`plan`、`background`
- `title`
- `goal`
- `status`
- `created_at`
- `updated_at`
- `archived_at`

`agent_runs` 替代重复的 `task_runs`：

- `id`
- `thread_id`
- `run_number`
- `user_input`
- `status`
- `started_at`
- `ended_at`
- `provider_id`
- `model_id`
- `enabled_capabilities_json`
- `workspace_path`
- `task_source`
- `workflow_hint`

`agent_events` 替代重复的 `task_events`：

- `id`
- `thread_id`
- `run_id`
- `type`
- `payload_json`
- `created_at`
- `sequence`

`agent_run_events` 继续用于 streaming/replay，但应与 `agent_runs` 同库同边界。

## 破坏性重建迁移

### 迁移策略

迁移执行顺序：

1. 关闭运行时写入入口。
2. 对旧 `core.db` 和所有旧 plugin DB 创建一次迁移前备份。
3. 导出旧数据到内存或临时 staging。
4. 删除或隔离旧工作 DB。
5. 创建新 DB 文件。
6. 应用目标 schema。
7. best-effort 导入可接受数据。
8. 丢弃无法导入的记录。
9. 不保存迁移报告、迁移摘要、失败记录审计或失败原始数据。
10. 清理旧工作数据，只保留新 DB 和一次迁移前备份。
11. 启动新库。

### 数据保留规则

保留：

- agent 侧 chat/session/thread/run/event
- `session_messages`
- `session_messages_fts` 可重建
- `agent_pending_interrupts`
- `agent_run_events`
- LangGraph checkpoints/writes
- tool effects
- context artifacts
- memory store items
- memory events/audit
- background tasks
- scheduled task runs
- config and secrets

不迁：

- task 插件旧 `task_threads`
- task 插件旧 `task_runs`
- task 插件旧 `task_events`

部分迁：

- `background_tasks` 保留定义和调度字段。
- `background_tasks.thread_id`、`run_id` 如果引用旧 task-only rows 且 agent canonical 中不存在对应 row，importer 必须在 agent DB 创建最小 thread/run stub，保留任务详情可打开，但不迁旧 task 事件历史。
- `scheduled_task_runs.task_run_id` 如果目标 agent run 不存在，导入为 `null`，不保留 dangling run reference。

### 失败处理

- 记录级失败：丢弃该记录，继续导入其他记录。
- 表级结构不匹配：跳过无法导入字段，能导入的字段继续。
- DB 文件无法读取：使用空 staging 继续创建新库。
- schema 创建失败：迁移失败，仍以新库目标为准，但不能启动半创建连接；下一次启动重新尝试创建新库。
- 迁移不保存失败明细、失败计数、表级摘要或记录内容。
- 迁移前备份保留一次，不参与运行时查询。

## Versioned Migrations

新增统一 migration framework，替代散落 schema 自行演进。

每个 DB 都有：

- `schema_migrations`
  - `id`
  - `db_name`
  - `version`
  - `name`
  - `checksum`
  - `applied_at`
- `schema_metadata`
  - `db_name`
  - `current_version`
  - `schema_checksum`
  - `created_at`
  - `updated_at`

规则：

- migration 必须按版本顺序执行。
- migration 应在 transaction 中执行；需要 SQLite 特殊操作时明确标注。
- `.transaction()` 不包 async function。
- migration 失败不得吞掉错误。
- `CREATE TABLE IF NOT EXISTS` 可用于初始建表，但版本推进必须由 migration ledger 证明。
- 禁止业务 repository 在运行时偷偷 `ALTER TABLE`。
- 测试必须覆盖新库初始化和从旧结构重建。

## Runtime Health

启动阶段：

- 打开所有目标 DB。
- 设置连接 PRAGMA：
  - `journal_mode = WAL`
  - `foreign_keys = ON`
  - `busy_timeout`
  - 明确 `synchronous` 策略
- 校验 schema version。
- 运行 `PRAGMA quick_check`。
- 校验关键表存在、关键索引存在、FTS trigger 存在。
- health 结果写入 core metadata。

诊断阶段：

- 提供 DB health capability 或内部 service。
- 手动触发 `integrity_check`。
- 手动触发 `wal_checkpoint`.
- 手动触发 `PRAGMA optimize`.
- DB 打不开、schema drift、FTS 缺失、foreign key 关闭都要生成明确错误码。

## Backup And Restore

备份范围：

- `core.db`
- `@roc/plugin-agent.db`
- `@roc/plugin-memory.db`
- `@roc/plugin-task.db`

备份规则：

- 使用 SQLite backup API 或等价在线一致性机制，不能只复制主 db 文件而漏掉 WAL/SHM。
- 每次备份保存 manifest：
  - DB logical name
  - file name
  - schema version
  - checksum
  - created_at
- 定期备份默认保留有限份数。
- 手动备份可显式触发。
- 恢复前必须关闭写入入口。
- 恢复后运行 quick check 和 schema check。

迁移前备份：

- 破坏性重建迁移开始前保留一次。
- 迁移完成后旧工作 DB 删除，迁移前备份保留。
- 不保存迁移摘要。

## Retention And Compaction

目标：控制本地 DB 体积，避免长期运行后卡顿，同时不破坏 active run 和恢复语义。

策略：

- 不清理 active run、recovering run、waiting_user interrupt。
- `agent_events` 可按 thread archive 状态和时间清理。
- `agent_run_events` 可按 run terminal 状态和 retention 天数清理。
- `session_messages` 只清理已归档 thread 或超过明确 retention 的 pre-compaction rows。
- `langgraph_checkpoints` 保留每个 active thread 的最近 N 个 checkpoint。
- `langgraph_checkpoint_writes` 跟随 checkpoint 删除。
- `agent_tool_effects` 保留到 run terminal 后指定天数。
- `context_artifacts` 按 thread/run retention 清理；被当前 context reference 引用的 artifact 不删。
- `memory_auto_audit` 继续按设置保留天数清理。
- 清理后可触发 `PRAGMA optimize`，VACUUM 只作为手动维护或低频任务。

## Performance

关键查询必须有索引或明确规模边界：

- thread list by updated_at
- run list by thread_id/run_number
- event list by thread_id/run_id/created_at/sequence
- session message list by thread_id/created_at
- session search by FTS + workspace_hash/thread_id
- background task list by updated_at/status
- scheduled task list by background_task_id/status/scheduled_at
- checkpoint latest by thread_id/checkpoint_ns/checkpoint_id
- memory store get by namespace_key/key

新增验证：

- repository query tests 覆盖排序和 limit。
- `EXPLAIN QUERY PLAN` 测试覆盖核心查询，禁止明显 full table scan 的热路径。
- FTS rebuild 测试覆盖旧数据导入后可搜索。
- 大样本 smoke 覆盖关键页面 snapshot 查询。

## Error Handling

- DB open failure：明确错误码，提示数据目录、DB 名称、底层错误。
- schema drift：阻止启动对应插件，提示需要重建或恢复。
- migration failure：显式失败，不静默 fallback 到旧 schema。
- backup failure：运行继续，但 health 标记 degraded。
- restore failure：不切换到失败 restore 结果。
- retention failure：记录错误并停止当前清理批次，不影响主运行。
- query failure：保持原错误码或包装成边界错误，不吞掉。

## 测试策略

最小测试集：

- `DatabasePool` 打开目标 DB，设置 WAL、foreign keys、busy timeout。
- migration framework 顺序执行、重复执行幂等、checksum drift 报错。
- 新库初始化生成 `core/agent/memory/task` 目标表。
- destructive rebuild 从旧结构导出、重建、导入、删除旧工作 DB、保留备份。
- 导入失败记录被丢弃且不会阻断新库启动。
- `task` 旧 `task_threads/task_runs/task_events` 不迁。
- `background_tasks` 和 `scheduled_task_runs` 迁入新 task DB。
- agent session/run/event/message/checkpoint/tool-effect/context-artifact 全部迁入 agent DB。
- memory store items 迁入 memory DB。
- FTS trigger 和 search 正常。
- backup manifest 和 restore quick check 正常。
- retention 不删除 active/recovering/waiting_user 数据。
- query plan tests 覆盖热路径。

验证命令按阶段选择：

1. 目标 Vitest 文件。
2. `pnpm typecheck`
3. 涉及 shared IPC/schema 时运行 `pnpm check:ipc`
4. 阶段完成时运行 `git diff --check`
5. 全部完成时运行 strict unused scan、`pnpm test`、`pnpm build`

## 实施阶段

### Phase 1: Schema And Migration Foundation

- 新增 DB migration framework。
- 定义目标 schema。
- 移除 repository 内隐式 schema 演进。
- 保持现有运行路径暂不切换。

验收：

- 新库可初始化。
- migration ledger 可证明当前版本。
- schema drift 可检测。

### Phase 2: Destructive Rebuild Importer

- 实现旧 DB 导出。
- 创建迁移前备份。
- 创建新 DB。
- best-effort 导入。
- 丢弃失败记录。
- 清理旧工作 DB。
- 不保存迁移报告或摘要。

验收：

- 旧结构样本可转换成新结构。
- 失败记录不阻断新库。
- 旧工作 DB 被清理。
- 迁移前备份存在。

### Phase 3: Runtime Wiring

- agent runtime 改用 agent DB 存 checkpoints/tool effects/context artifacts。
- memory plugin 改用 memory DB 存 long-term store。
- task plugin 改为引用 agent canonical。
- UI/API 查询从新边界读取。

验收：

- chat/history/session_search 正常。
- background task 创建、运行、详情正常。
- DeepAgents 恢复和幂等不回退。

### Phase 4: Health Backup Restore

- 启动 health check。
- backup service。
- restore service。
- health metadata。
- 明确错误码。

验收：

- quick check 和 schema check 可运行。
- 备份覆盖四个 DB。
- restore 后可启动并搜索历史。

### Phase 5: Retention And Compaction

- retention policy。
- checkpoint/tool effect/context artifact 清理。
- audit/event 清理。
- 手动 optimize/checkpoint。

验收：

- active/recovering/waiting_user 数据不删。
- terminal old data 按策略清理。
- 清理可重复执行。

### Phase 6: Performance And Cleanup

- 补索引。
- query plan tests。
- FTS rebuild/optimize。
- 删除旧 schema、旧 tests、旧 helpers。
- 全仓验证。

验收：

- 热路径 query plan 有索引支撑。
- 不存在旧 `task_threads/task_runs/task_events` task repository 写入路径。
- strict unused scan、typecheck、test、build、diff check 通过。

## 不做事项

- 不设计云端同步。
- 不设计多用户并发协作。
- 不把所有数据合并到一个 `roc.db`。
- 不迁移旧 task 插件历史事件。
- 不保存迁移失败记录、迁移摘要或迁移报告。
- 不新增旧 schema 兼容运行路径。
- 不把 `/workspace/` 当 shell cwd。
- 不只靠 prompt 约束数据边界。

## 验收标准

- 运行时只有一个 canonical session/run/event 模型。
- core DB 不再承载 agent runtime 或 memory store 业务数据。
- agent DB 承载 agent runtime 所需恢复、幂等、artifact、session/search 数据。
- memory DB 承载长期 memory store。
- task DB 只承载 background task 定义和调度投影。
- 破坏性重建迁移按约定清理旧工作数据并保留一次迁移前备份。
- 每个 DB 都有 versioned migration ledger。
- 启动 health、backup/restore、retention、performance 验证都有自动测试。
- 阶段实现均完成 review/fix/commit。
- 最终验证覆盖 focused tests、`pnpm typecheck`、`pnpm check:ipc`、strict unused scan、`pnpm test`、`pnpm build`、`git diff --check`。
