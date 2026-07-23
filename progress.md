# Roc Agent Harness 进度

## Current State

- Branch：`main`。
- HEAD：`639c019 feat(agent): converge context compaction across subagents`。
- Stage 0-4：完成并提交。
- Stage 5：in progress；Part 1、Part 2 已提交；Part 3A 已完成实现、双轴 review 与 focused verification，等待提交；Part 3B/3C pending。
- Stage 6-7：pending。
- 用户未跟踪的 `plan.md` 保留为当前验收源，不纳入本次文档整理范围。

## Completed Milestones

| Stage | Result | Commit(s) |
|---|---|---|
| Stage 0 | 完成核心故障 characterization；后续 stress/cancellation 缺口由 Stage 2/4 回归补齐。 | `ae0c95b`, `4543408`, `2b28ef1`, `9845543` |
| Stage 1 | Immutable run manifest/snapshot、持久 audit、trusted origin 和 explicit skill contract 完成。 | `4d9e8a3` |
| Stage 2 | Durable run CAS、terminal transaction、outbox projector、bounded queue/timeline 完成。 | `1fbda30` |
| Stage 3 | Durable background occurrences、crash/restart reconcile、projector ordering 完成。 | `dfbbf00` |
| Stage 4.1 | Main/subagent manifest safety 与 tool scope 收敛。 | `4ced164` |
| Stage 4.2 | Native model/tool call budgets 与结构化 budget failure 完成。 | `031baea` |
| Stage 4.3 | Host shell pre-authorization、cwd/env/output/abort 边界完成。 | `20c235d` |
| Stage 4.4 | Web/hook scope、deadline、abort、provenance 和 Windows child-tree 完成。 | `e75a754` |
| Stage 4.5 | Effect state、execution path 和 restart reconcile 完成。 | `7e1ed9f` |
| Stage 5.1 | Context hard budget、reducer compaction 与 scoped artifact recovery 完成。 | `b223636` |
| Stage 5.2 | Main/subagent context pipeline 收敛并完成 native A/B。 | `639c019` |

## 2026-07-19 - Stage 5 Part 1 WIP

- 当前 diff：3 files，238 insertions，34 deletions。
- 本轮已按 `task_plan.md`、`findings.md`、`progress.md`、`plan.md` 恢复上下文；CodeGraph 确认生产调用链与当前 token budget 输入边界。
- `context-compaction-pipeline.ts`：改为返回 reducer update；summary 仅消费待移除 segment；增加 deterministic hard trim。
- `error-mapping.ts`：增加不可重试的 `context_budget_exhausted` 映射。
- `context-compaction-pipeline.test.ts`：增加输入 state 不变、reducer apply、summary input 边界、summary failure hard trim 和 protected context exhaustion 回归。
- 新鲜验证：`pnpm test -- tests/main/services/deep-agent/context/context-compaction-pipeline.test.ts` 通过（8 tests）；`pnpm typecheck` 与 `git diff --check` 通过。
- `MessagesAnnotation` 声明检索批处理因 `rg` 无匹配返回码 1 失败；改走包导出探针，未修改代码。
- 首次双测试运行中 summary failure 断言失败：移除内层事件后安全 hard-trim 路径漏发；已定位并补回调用方发射，checkpoint integration 同批通过。
- 新增 `context-compaction-checkpoint.integration.test.ts`；`StateGraph(MessagesAnnotation)` 经 Roc SQLite checkpoint、连接重建、graph 重建后恢复 compacted messages。
- 新鲜验证：focused 2 files/9 tests、strict unused scan、`pnpm typecheck`、`pnpm check:ipc`、`git diff --check` 全部通过。
- 状态：**Changed, partially verified**。独立双轴 review 进行中，尚未提交。
- 独立 review 已完成：Standards 发现 broad catch 与 tool-pair test gap；Spec 发现 summary call hard-budget P0、context profile/token counter/estimated telemetry、artifact scope/pagination P1。状态保持 **Changed, partially verified**，不提交当前 partial 实现。
- 新增 `context-token-budget.ts`：显式拆分 context window、model input、reserved output、system/tool overhead、summary input、safety margin；优先 `model.getNumTokens()`，失败时保守估算并记录 estimated。
- 新鲜验证：`context-token-budget.test.ts` 3/3 通过。
- profile 接口首次 typecheck 失败，精确列出 10 个旧 `budgetTokens` 调用点；未发现其他类型错误，正在统一迁移且不保留别名。
- 下一步：先跑 focused context test，修复失败；再补 checkpoint integration、context profile/token counter、artifact tool、native A/B 和 HITL/saver conformance。

## 2026-07-19 - Planning Docs Cleanup

- 将 189 行 `task_plan.md` 压缩为当前阶段账本，删除已解决错误表和过时 review blocker。
- 将 205 行 `findings.md` 改为当前事实、closed-stage evidence、verification anchors 和 open risks。
- 将 423 行 `progress.md` 改为里程碑、当前 WIP 和下一步，不再保存逐命令流水。
- 纠正旧状态：Stage 0 已由 Stage 2 backpressure 与 Stage 4 cancellation 回归补齐；Stage 1-4 的提交状态以当前 Git 历史为准。
- 两次文档读取批处理因复用错误的 PowerShell `foreach` 管道结构而解析失败；改为显式 `$rows` 收集后成功，未修改代码或其他文件。
- 验证：三份文档完整回读通过；均为 UTF-8 without BOM；限定三文件的 `git diff --check` 通过；旧 pending/review/error 模式扫描无残留。
- 未运行代码测试：本次只修改规划文档，不改变生产或测试代码。

## 2026-07-21 - Stage 5 Part 1 Resume

- 从 `task_plan.md`、`findings.md`、`progress.md`、`plan.md`、Git 历史与工作树恢复上下文；session catchup 无未同步输出。
- 当时 HEAD 为 `7e1ed9f`，`main` 比 `origin/main` ahead 12；Stage 5 WIP 未提交。
- 实际现场为 12 个 tracked 修改文件、3 个新增代码/测试文件，另有未跟踪验收源 `plan.md`；已纠正旧账本中的“3 个文件”。
- 两次只读并行脚本因 JavaScript 语法错误未执行；简化调用结构后读取成功，未修改仓库。
- 下一步：审查 Stage 5 Part 1 全量 diff，运行 focused context tests，按失败与 review finding 修复后完成本 part 提交。
- 首轮 `pnpm test -- <4 files>` 实际执行全套 301 files：299 files 通过，pipeline 3 tests 与 empty-catch 质量门 1 test 失败。根因边界已定位到 summary-input 预算不足后的 hard-cap 路径，以及 token counter fallback 的空 `catch`；状态仍为 **Changed, unverified**。
- 生产 artifact scope/tool/manifest、summary failure 分类和 token fallback 已实现；首次 10-file focused run 为 9 files 通过、pipeline 6 tests 失败。共同根因是测试计数器漏匹配 summary system message 中的 `for Roc`，已修正测试锚点。
- 修正 summary test counter 与 SQLite thread fixture 后，focused 10 files / 67 tests 全部通过；`pnpm typecheck` 无错误。Stage 5 Part 1 进入双轴 review，尚未提交。
- 双轴 review：Standards 2 个 P0；Spec 2 个 P0 + 1 个 P1。阻断点为完整 tool-call/schema 计数、最新 Human 保护、subagent hard-budget stack、recent constraints 重复。状态回到 **Changed, partially verified**；不提交。

## 2026-07-23 - Stage 5 Part 1 Review And Verification

- 修复 hard trim 的 ToolMessage 反向删除：现在递归移除对应 AI tool-call 及其全部 ToolMessage 结果；补充 provider model-call gate 回归。
- middleware 未显式传入 counter 时，将本地 provider counter 传入 summary input budget 计算；summary schema overhead 不再漏计。
- review：按 LangGraph reducer、artifact scope、summary fallback、main/subagent middleware、tool-call pairing、cross-process checkpoint 逐项检查；未发现未处理 Critical/High/Medium finding。
- focused：11 files / 95 tests 通过。
- broad：`pnpm typecheck`、strict unused scan、`pnpm check:ipc`、`pnpm build`、`pnpm test`（302 files / 1631 tests）、`git diff --check` 通过。
- 全量测试末尾 node-pty `AttachConsole failed` 为子进程诊断噪声，Vitest 退出码 0；记录残余风险，不扩大本 part 范围。
- 状态：**Verified passing; committed**。下一步进入 Part 2 Native Convergence。

## 2026-07-23 - Stage 5 Part 2 Native Convergence

- 本机 Deep Agents 1.10.7 的 provider profile 只过滤 main middleware；declarative inline subagent 会固定前置 native `SummarizationMiddleware`，与 Roc pipeline 形成双 producer。
- Roc builder 现在把通过安全合同校验的声明式 subagent 编译为 runnable，显式保留官方 todo/filesystem/skills/patch/prompt-cache 基础栈、subagent permissions 与 static response format，只移除 native summary。
- 固定 corpus A/B 覆盖 completion、data-derived fidelity、input/output token、native backend offload、Roc scoped artifact recovery，以及经 `RocSqliteCheckpointer` 序列化后的 checkpoint blob 体积。
- 真实 integration 未 mock Deep Agents：Anthropic harness profile 后 main 仅有 Roc compaction；compiled research subagent 完成 `task -> write_todos -> return`，触发 Roc summary，并由 Roc saver 写入 checkpoint。
- 双轴 review 首轮 finding：关键数组静默兜底、测试 helper 重复、main mock vacuity、Anthropic model 识别缺口与本地 conformance 证据不足；均已修复。Standards 与 Spec 最终复核均无本地未处理 finding。
- focused 6 files / 26 tests、真实 route、`pnpm typecheck`、strict unused scan、`pnpm check:ipc`、`pnpm build`、full Vitest（304 files / 1634 tests）和 `git diff --check` 全部通过。
- 全量测试结束后仍输出 node-pty `AttachConsole failed` 子进程诊断，但 Vitest 退出码为 0；作为既有 Windows 环境残余风险记录。
- 真实 Anthropic `cache_read` provider usage 未运行，需外部 provider 凭据，归 Stage 6 provider integration。
- 状态：**Verified passing; committed**。提交：`639c019`。

## 2026-07-23 - Stage 5 Part 3A Saver Conformance

- 用同一套行为集对照 pinned LangGraph 1.4.7 `MemorySaver` 与 `RocSqliteCheckpointer`，覆盖 put/get/getTuple/list/deleteThread、parent config、metadata filter、before/limit 顺序和四类 special writes。
- 红灯证明 Roc 原实现忽略 metadata filter，`before + filter + limit` 错误返回 `checkpoint_002`；修复后返回与 upstream 一致的 `checkpoint_001`。
- filtered list 使用 64-row keyset metadata page；只有命中行读取 checkpoint BLOB 与 pending writes，130-row fixture 验证 3 页 metadata、1 次完整 tuple 读取。
- pending writes 对齐 upstream insertion order；两个 task 的完整三元组在 getTuple/list 双路径精确一致，deleteThread 后重建同 checkpoint id 证明 writes 无残留。
- 双轴 review 首轮发现 filtered list O(N) BLOB/N+1 查询、无效 timestamp fixture、delete writes 覆盖缺口和 pendingWrites Map 弱断言；全部修复。最终 Standards/Spec 复核均无 finding。
- 新鲜验证：focused 3 files / 11 tests、`pnpm typecheck`、strict unused scan、`git diff --check` 通过。
- 状态：**Verified passing; pending commit**。下一步 Part 3B interrupt projection/restart。
