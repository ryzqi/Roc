# 阶段 9：死代码与零深度微文件清理

强度：快赢（负成本——源码与测试同时消失，导航噪音下降）。依赖：无，任意间隙执行。每项动手前先跑一次调用方核查（grep），以当时代码为准——其他阶段可能已改变引用关系。

## 清单与处置

### 9.1 database-rebuild.ts（1,057 行，占 infrastructure 26%）

- 事实：`rebuildRocDatabases` / `createMigrationBackup`（`src/main/infrastructure/database-rebuild.ts:84,117`）全仓仅被自身测试 `tests/main/infrastructure/database-rebuild.test.ts` 引用；maintenance CLI 只用 backup/restore（`database-maintenance-cli.ts:5`）；`tests/main/migration/` 目录为空。测试维持"存活"假象。
- 处置：**先核查是否为规划中的 restore-with-migrate 预备件**（查 docs/、近期计划文档、commit message `4e407d6 feat: add destructive database rebuild` 的上下文）。确认无规划 → 连同测试删除；确认有规划 → 接入 maintenance CLI 使其有真实调用方，并在文件头注明用途。二者必居其一，不允许维持现状。

### 9.2 query-plan.ts（仅测试消费）

- 事实：`assertUsesIndex`（`src/main/infrastructure/query-plan.ts:10-28`）唯一引用是自己的测试，没守护任何真实热查询。
- 处置：移入 `tests/` 测试工具目录，并对 task-repository 的 claim/list 热查询加真实索引断言（这才产生 leverage）。若阶段 6 已完成，断言加在聚合子模块的查询上。

### 9.3 微转发文件群（零深度，删除测验通过：复杂度不重现）

| 文件 | 事实 | 处置 |
|------|------|------|
| `src/main/services/deep-agent/schema.ts:5-7` | 7 行纯转发 `applyAgentDatabaseSchema` | 删除，调用点直接 import |
| `src/main/plugins/task/schema.ts:5-7` | 同上形态，转发 `applyTaskDatabaseSchema` | 删除，调用点直接 import（若阶段 8 已收口启动序列则随之消失） |
| `context/prompt-serialization.ts:3-5` | 5 行一个 join 单独成文件 | 并入唯一调用方 |
| `stream-tool-utils.ts`（17 行）+ `redact.ts`（9 行） | 同一概念拆两文件，文件名与内容不符 | 合并为一个文件，命名如实 |
| `deep-agent-final-output.ts:10-12, 73-75` | `readInterrupted(run)` ≡ `run.interrupted`；`readFinalAssistantText(o)` ≡ `o.finalAssistantText` | 删除包装函数；`normalizeChatInterruptPayload` 在阶段 1 已迁入 interrupt-projection，此文件应可整体消失 |
| `stream-consumers.ts:185-200` `consumeSubagentStream` | 15 行参数重排转发 `projectSubagentStream` | 内联到调用方（阶段 5 完成后此文件形态已变，以当时为准） |
| `tools.ts:13-28` | 名叫 tools，实际创建 subagents（`createRunSubagents`） | 改名如实（如 `subagents.ts`）或并入调用方 |
| capability preview 透传链 | `runtime.ts:150-168` 逐字段拷贝 → `buildAgentCapabilityPreview`（`capability-preview.ts:15-48`）又逐字段展开 manifest；`selectedCapabilities` 等全是 `manifest.*` 重复展开且 manifest 本身也在返回值里 | preview 只返回 manifest + 展示卡片字段，删除重复展开层 |
| `deep-agent-executor.ts:570-581` | `emitTodoEvent: () => {}` 永久空实现成员 | 从 callbacks interface 删除（阶段 5 已列，先到先做） |

### 9.4 测试后门

- `runContextCompactionForTest`（`context-compaction-pipeline.ts:149`）：内部编排以 ForTest 后缀导出给 629 行测试直调——middleware 外壳无法单测的信号。本阶段仅记录；根治需要给压缩管线一个可测 interface，纳入未来对 context 目录的评审（本轮未深入 context 子目录）。

## 实施步骤

1. 每项先 grep 核查当前调用方（引用关系可能已被前序阶段改变）。
2. 9.1 的规划核查先行——它是唯一需要判断"预备件 vs 死代码"的项。
3. 小步提交：一项一 commit，便于回滚。
4. 微文件删除后跑 `pnpm typecheck` 立即暴露遗漏 import。

## 验收

- 9.1 二选一落地（删除或接线），不存在"无调用方但保留"状态。
- 索引断言守护真实热查询（`EXPLAIN QUERY PLAN` 断言对 claim/list 生效）。
- 微转发文件清单全部处置；`services/deep-agent` 根目录文件数明显下降（现 33 个）。
- `pnpm typecheck` + `pnpm test` 全绿。
