# 阶段 2：session-repository 跨 seam 裸 SQL 收口

强度：Strong。依赖：建议紧随阶段 1（interrupt 恢复路径与本阶段的 checkpointer 接口相邻）。

## 问题

`src/main/plugins/agent/session-repository.ts`（1,771 行）直接读写三张"别人拥有"的表，三处不变量被旁路：

1. **checkpoint 表直读**：裸 SQL 查 `langgraph_checkpoints` / `langgraph_checkpoint_writes`，硬编码 `channel = '__interrupt__'`（`session-repository.ts:1400-1417, 1514-1517`）。该字符串是 `RocSqliteCheckpointer` 的内部存储格式（`sqlite-checkpointer.ts:48-53` 第二处定义）；checkpointer 换序列化格式（`value_type !== 'json'` 分支）时 repository 静默返回 null（`:1418`）。
2. **tool-effect 旁路 UPDATE**：直接 UPDATE `agent_tool_effects`（`:1519-1534`，`markRestartedToolEffectsUnknown`），绕过 `AgentToolEffectStore`（`tool-effect-store.ts`）的状态机不变量（`finish()` 只允许从 in_progress 转移）。
3. **run-event 双写路径**：直接 INSERT `agent_run_events` 并自实现 cursor（`:330-341, 1168-1186`），与 `AgentRunEventLog`（`run-event-log.ts:48-66`）重复，且容量语义相反——repository 到容量时删末条重写（`:1175-1178`），event log 直接 throw（`:61-63`）。同一张表两套写路径两种行为。

## 目标形态

三个拥有者各暴露一个窄 interface，repository 停止跨界裸 SQL、只组合接口：

- `RocSqliteCheckpointer` 增加 `readPendingInterrupts(threadId)`（或等价语义查询）——`'__interrupt__'` 与序列化格式知识只存在于 checkpointer 内部。
- `AgentToolEffectStore` 增加 `markRestartedUnknown(runId)`——状态机转移规则由 store 自己执行。
- `AgentRunEventLog` 成为 `agent_run_events` 的唯一写路径——容量语义只定义一次。

## 实施步骤

1. **定容量语义**（见设计决策）——先定案，再动代码。
2. checkpointer 加语义查询方法，把 `session-repository.ts:1400-1417, 1514-1517` 的 SQL 原样搬入（含 `value_type` 分支），repository 改调方法。若阶段 1 已把该 SQL 封进 interrupt-projection，则改为 interrupt-projection 调 checkpointer。
3. effect store 加 `markRestartedUnknown`，实现走既有状态机路径（或显式声明该转移为合法特例），删除 repository 的旁路 UPDATE。
4. repository 的 event 写入全部改调 `AgentRunEventLog.append`，删除自实现 cursor 与 INSERT；统一后的容量行为落在 event log 一处。
5. 检查 `session-repository.test.ts`（1,737 行）：为跨界行为准备的夹具移到三个拥有者的窄接口测试；repository 测试改注入三个 fake。

## 设计决策（动工前定案）

- **容量语义二选一**：trim（删末条重写，现 repository 行为）还是 throw（现 event log 行为）？建议 trim——事件表是有界投影缓存，满了丢最旧符合用途；throw 会把存储细节变成运行时故障。定案后两处行为收敛为一种，并写一条容量边界直测。
- checkpointer 的新方法属于我方子类（`RocSqliteCheckpointer`），不改 LangChain 基类契约——确认方法命名不与基类未来版本冲突（加 `roc` 前缀亦可）。

## 验收

- 全仓 grep：`langgraph_checkpoints`、`'__interrupt__'`、`agent_tool_effects`、`agent_run_events` 的 SQL 各只出现在拥有者文件内。
- `agent_run_events` 只有一条写路径；容量语义有直测。
- repository 可注入三个 fake 完成单测；`session-repository.test.ts` 行数下降。
- `pnpm typecheck` + `pnpm test` 全绿。
