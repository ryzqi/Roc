# 阶段 8：插件 DB 隔离 seam 修复

强度：Speculative（摩擦是"将来会咬"而非"正在咬"——journal 补偿机制目前工作正常）。依赖：阶段 6（task 侧聚合接口稳定后再动跨库结构）。

## 问题

per-plugin 独立 db 文件是刻意设计的隔离 seam，但实施上名存实亡：

- **facade 全量发放**：`src/main/infrastructure/database-pool.ts:78-93` 把所有插件的连接发给每个插件；task 插件在 `src/main/plugins/task/index.ts:96-99` 同时拿 `getTaskConnection()` 和 `getAgentConnection()`。
- **Reader 会写库**：`src/main/plugins/task/agent-task-history.ts:26-109` 的 `ensureBackgroundTaskThread` / `recordBackgroundTaskEvent` INSERT 进 agent 插件的库——类名掩盖写入事实。
- **infrastructure 越权**：`src/main/infrastructure/agent-history-deletion.ts:3-58` 把 agent + task 两个域的删表 SQL 放在 infrastructure 层。
- **连接获取 4 种姿势**：pool、facade、裸 db（`database-maintenance.ts:20-27` 收裸 coreDb 并 inline 写 SQL `:100-120`）、自取+自建 schema（`config-store.ts:38-61`、`secret-manager.ts:40-74` 各自 `applyCoreDatabaseSchema`）。
- **跨库删除分散**：thread 删除的 journal 状态机（pending → agent_deleted → complete，`task-repository.ts:132-176`）、`thread-deletion-journal.ts`、恢复循环（`index.ts:111-123`）、失败广播（`:299-321`）散在 4 处约 250 行——补偿机制正确但无 locality。

## 目标形态

1. facade 只暴露本插件连接：每个插件 `register()` 收到的是自己的连接（或按声明发放），拿不到别家的。
2. 跨插件数据访问二选一（见设计决策）：capability 调用，或显式命名的跨库 contract 模块（如 `agent-task-history-contract`——名字如实说明"task 写 agent 历史"）。
3. "删一个 thread"封进 journal 拥有的单一操作：`deleteThread(threadId)` 内部走状态机 + 恢复；repository 与 index.ts 只调一个入口。
4. 连接获取统一为一种姿势：pool 发连接、插件收自己的 facade、模块收已建好 schema 的连接；schema application 收口到启动序列（`kernel-runtime.ts:71-95` 已有雏形），`config-store` / `secret-manager` 不再自建。
5. `agent-history-deletion.ts` 的 SQL 按域回迁到各自插件，infrastructure 只留通用引擎。

## 实施步骤

1. 全仓盘点跨库访问点（grep `getAgentConnection` / `getTaskConnection` / `applyCoreDatabaseSchema` 等），列清单确认无遗漏暗写入方。
2. 定跨库访问机制（设计决策 1），把 `agent-task-history.ts` 的写入迁过去并改名如实。
3. journal 单一入口：delete + recover + 广播收进 journal 模块；4 处调用点改为一个。
4. facade 改为按插件发放；`database-pool.ts` 的全量 facade 删除。
5. schema application 收口启动序列；删除各模块自建 schema 调用。
6. `agent-history-deletion.ts` 按域拆迁。

## 设计决策（动工前定案）

- **跨库机制**：capability 调用（走 kernel，进程内 RPC，语义清晰但多一跳）vs 显式 contract 模块（直接函数调用，命名如实即可）。建议 contract 模块——同进程内 capability 化收益有限，显式命名已恢复 seam 的真实性；若未来插件要出进程再升级为 capability。
- **maintenance / health / backup 服务**收 pool 还是收连接列表？建议保持收 pool（它们是真正需要跨全库的基础设施角色），但在 pool 上区分"运维视角接口"（遍历所有库）与"插件视角接口"（只发本库）。

## 验收

- 全仓 grep：除 contract 模块与运维服务外，无插件持有他家连接；`Reader` 类名不再掩盖写入。
- "删一个 thread"从 4 文件收敛为 journal 一个入口；对应集成测试改为测该入口。
- schema application 只发生在启动序列。
- `pnpm typecheck` + `pnpm test` 全绿；`pnpm smoke:electron` 通过（连接发放方式变更涉及启动路径）。
