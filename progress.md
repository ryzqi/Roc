# Roc Agent Harness 进度

## Current State

- Branch：`main`。
- HEAD：`873df23 fix(agent): align sqlite saver with upstream contracts`。
- Stage 0-4：完成并提交。
- Stage 5：in progress；Part 1、Part 2、Part 3A 已提交；Part 3B changed, partially verified；Part 3C pending。
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
| Stage 5.3A | SQLite saver 对齐 upstream contract。 | `873df23` |

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
- 状态：**Verified passing; committed**。提交：`873df23`。下一步 Part 3B interrupt projection/restart。

## 2026-07-24 - Stage 5 Part 3B Resume

- 从四份计划文件、Git 历史、工作树与 CodeGraph 恢复上下文；实际 HEAD 为 `873df23`，旧账本中的 Part 3A pending 状态已纠正。
- 当前未提交 diff：pending interrupt collection schema/migration/rebuild、runtime/repository/renderer collection projection、interrupt-id resume map、真实 restart tests 和 multiple-interrupt tests。
- 新鲜 focused verification：8 files / 52 tests 通过。
- Review 发现 plan 5.3 阻断：projection 在 executor dispatch 前删除；现有 executor-missing test 不是 dispatch rejection test。
- 下一步：新增稳定红灯覆盖 executor dispatch rejection；实现两阶段 resume claim/commit/rollback；复跑 focused tests 后做 Part 3B 完整 review。
- 状态：**Changed, partially verified**。

## 2026-07-24 - Stage 5 Part 3B Review Continuation

- session catchup 检出 61 条未同步上下文；已用当前 diff、计划文件和 reviewer 消息恢复，不重复已完成工作。
- dispatch rejection 红灯与两阶段 claim/prime/commit/rollback 已实现；runtime multiple-interrupt、repository、typecheck、strict unused 与 diff check 曾通过，但代码仍在变动，最终需重跑。
- Preliminary review 新增阻断：resume audit 不在 commit transaction；部分 resume commit 后崩溃会丢剩余可恢复状态；interrupt event 可能早于 pending collection 持久化；projection 仍复制 immutable run 配置；legacy rebuild fallback 缺直接断言；生产 multiple-interrupt partial-map 语义未证明。
- 下一步：先用 CodeGraph 核对 runtime/repository/executor 调用链，补稳定回归，再做最小事务与时序修复；diff 稳定后请求 Standards/Spec 最终复核并执行 risk review。
- CodeGraph 已确认 `resumeRun()` 在 `commitResumeDispatch()` 后才写 approval/question audit，且 `executeDeepAgentRun()` 逐事件先 publish、流结束后才批量 `handleRunInterrupted()`；首事件 prime 还可能只是 agent stream 前的 hook event。
- Spec reviewer 又确认 obsolete projection columns 与 rebuild source/target 查询必须联动修改；不能让旧列删除后的读取失败静默变成空 collection。
- 无写入 LangGraph probe 已证明 pinned 版本支持 sequential partial resume map：第一次回答一个并行 interrupt 后只保留另一项，第二次回答后得到两个具体业务结果。
- 状态：**Changed, partially verified; preliminary review findings unresolved**。
- 第一轮 `pnpm typecheck` 失败：仅有 `session-repository.test.ts` 两处旧调用未适配新事务返回/required audit；已按新合同更新测试，生产类型未放宽。

## 2026-07-24 - Stage 5 Part 3B Current Resume

- 按用户要求从 `findings.md`、`task_plan.md`、`progress.md`、`plan.md`、当前 diff 与 CodeGraph 调用链继续；session catchup 无新增未同步输出。
- 当前权威状态仍为 Part 3B changed, partially verified；preliminary review 阻断未闭环，不提交。
- 本轮边界：只完成 Part 3B review finding、验证、独立 review 与提交；完成后再进入 Part 3C。

## 2026-07-25 - Stage 5 Part 3B Review Fixes

- 双轴首轮 review 发现两项 P1：prime 在 durable audit 前消费真实 executor，及 startup 只信 projection 未核对 current checkpoint；均未提交。
- 移除 resume pre-consume。`execute()` 返回 stream 作为 dispatch acceptance；commit 之后才消费 stream，避免 SessionStart、`Command(resume)`、模型与工具在 audit/projection durable 前运行。executor promise rejection 仍 rollback waiting；已提交 stream 的失败按 run failure 处理。
- startup reconcile 现在要求合法 collection 与最新 main checkpoint 的 `__interrupt__` write 同时存在；新增 stale projection regression。真实 Deep Agents + Roc saver partial restart、repository、runtime multiple 共 27 tests 与 `pnpm typecheck` 通过。
- 下一步：完整 Part 3B focused/quality gates，重跑 Standards/Spec review；无 finding 后 broad verification 与独立提交。

## 2026-07-25 - Stage 5 Part 3B Continuation

- 已从 `task_plan.md`、`findings.md`、`progress.md`、`plan.md`、当前提交与 CodeGraph 恢复上下文。
- 当前 HEAD：`a810b8f`；工作树只含未跟踪验收源 `plan.md`，保持不变。
- 当前处理：按最终 review 阻断补 transcript collection、dispatch crash recovery 与快速并发 resume 回归；完成后进入独立 review、全量验证和提交。
- 已确认 schema migration v11 已移除复制的 run 配置；本轮不再扩展该 migration，只补对应 regression。
- 已确认 restart 恢复当前依赖 projection 与 checkpoint 双证据；开始实现缺 projection 时的 checkpoint 重建，避免 commit 后、stream 消费前崩溃终止可恢复 run。
- Transcript collection production code 已改；renderer fixtures 正在迁移为 `interrupts` 数组，首次多区块 patch 未匹配，改用局部机械替换。
- Focused renderer 首跑：4 files、47 tests，1 个旧单值断言失败；生产 collection 路径已执行，待更新断言和追加多 interrupt UI 回归后重跑。
- Transcript diff review 后首轮 `pnpm typecheck` 仅报 `editedAction` 变量名错误；已修复，待重跑 typecheck 与 focused renderer。
- Transcript collection review：未发现剩余实现风险。复跑 focused renderer 4 files / 48 tests、`pnpm typecheck`、`git diff --check` 通过；准备独立提交。
- Transcript collection 已提交 `24db71d`。开始 checkpoint-only interrupt recovery：当前 repository 仅检查 `__interrupt__` 行存在，尚未解码并重建 projection。
- Serializer 静态检索连续三次无结果，停止重复检索；下一步用真实 saver 产生的 checkpoint write 校验 payload 编码，保持 recovery decoder 的格式边界显式。
- 已定位 saver read path：`this.serde.loadsTyped(value_type, value_blob)`；现有 fixture 的 default interrupt write 是 `json`/UTF-8 JSON。下一步实现只接受该持久格式的 strict decoder 和 projection rebuild。
- 设计确定：用 latest checkpoint interrupt collection 覆盖 stale/missing projection，恢复 `dispatch_pending`/`running`/`waiting_user`，不从 event history 复制 pending requested event。
- Checkpoint recovery 首跑：4 files / 31 tests，3 failed。两个 repository fixture 的 `__interrupt__=[]` 已不满足新真相语义；真实 saver integration 显示 decoder 未匹配 production serialization，下一步先采样 payload，不重复当前实现。
- Decoder 已对齐真实 write：每个 `__interrupt__` row 是单 `{id,value}` JSON，多个 task row 构成 collection。partial restart 首测显示 latest checkpoint 仍含已回答 id；将以 projection remaining subset 作为合法状态，避免重建回旧 interrupt。
- Checkpoint recovery 已修：latest main `json` rows 严格 decode，缺 projection 时重建，已有 projection 是 checkpoint id subset 时保持。focused 4 files / 31 tests 通过。下一步补快速双 resume 并发回归。
- Crash/concurrency subpart review 首轮 typecheck 发现测试闭包 gate 的 TypeScript 收窄错误；已改为对象属性 gate，待重新验证和提交。
- Crash recovery/concurrency subpart review 完成：focused 4 files / 32 tests、`pnpm typecheck`、`git diff --check` 通过，无未处理 finding；准备独立提交。
- Stage 5 Part 3B final review：Standards 2 个 finding、Spec 1 个 finding。当前不关闭 Part 3B；按 checkpoint + durable audit、projection payload validation、observer failure 不阻断 execution 三项最小修复后重跑全门。
- Review fixes 首轮：projection validation 将已持久化 approval wrapper 误判 invalid，导致 5 个 focused failure；已将该既有合同加入 normalizer，待重跑。
- Review fixes 第二轮：repository/runtime/production restart/final-output focused 4 files / 29 tests、`pnpm typecheck`、`git diff --check` 通过。继续补 incomplete projection 与 corrupt payload 直接回归。
- Review fixes 第三轮：新增 incomplete projection 与 corrupt payload regression；focused 5 files / 35 tests、`pnpm typecheck`、`git diff --check` 通过。独立复核进行中，随后重跑 strict/IPC/build/full Vitest。
- Spec re-review 发现 corrupt projection 阻断 checkpoint rebuild；已让 reconcile 仅对该持久化格式错误执行覆盖重建，新增 startup recovery 断言，待重跑。
- Standards re-review 发现 audit-to-resume map 缺失；当前不关闭 Part 3B。下一步从 canonical audit 读取 approval decisions/question answer，与当前 request 合并后再调 executor。
- Audit resume-map 首轮验证：typecheck 暴露 readonly decisions 与 LangGraph response 不兼容；focused fake executor 需区分完整 map。已最小修复，待重跑。
- Audit resume-map 第二轮：focused 5 files / 35 tests、`pnpm typecheck`、`git diff --check` 通过。请求独立复核；通过后重跑 strict/IPC/build/full Vitest 并提交 Part 3B final review fixes。
- Part 3B final：Standards/Spec 复核无 residual finding；strict unused、IPC、build、full Vitest、diff check 退出码 0。准备提交并转入 Part 3C retention。
