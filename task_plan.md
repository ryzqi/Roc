# Roc Agent Harness 执行账本

## Goal

按 `plan.md` 的 Stage 0-7 顺序完成 Agent Harness 优化。每个 stage 独立实施、review、修复、验证和提交；最终只删除有直接证据证明无用的遗留代码。

## Source of Truth

- 产品与架构验收：`plan.md`。
- 实际状态：当前工作树、提交历史和新鲜验证结果。
- 本文件只记录当前阶段、剩余工作和仍有效决策，不保存已闭环的逐操作流水。

## Current Phase

Stage 5 Part 3C - Recovery-safe Retention

**Status:** in_progress

Stage 5 Part 1、Part 2、Part 3A 与 Part 3B 已完成实现、独立双轴 review 与全量验证；Part 3B 最终提交将在本次账本更新后创建。下一步仅处理 Part 3C retention。

## Phase Status

| Stage | Status | Current evidence |
|---|---|---|
| Stage 0 - Characterization Gate | complete | 同 thread 并发、terminal projection、checkpoint restart、scheduler crash、100k/10k backpressure、shell/web/hook abort 与 Windows child-tree 均已有稳定回归；相关修复已随 Stage 1-4 提交。 |
| Stage 1 - Immutable Run Contract | complete | `4d9e8a3 feat(agent): freeze immutable run execution contract` |
| Stage 2 - Durable Run State, Outbox, Bounded Timeline | complete | `1fbda30 feat(agent): harden durable run state and outbox` |
| Stage 3 - Durable Background Occurrences | complete | `dfbbf00 feat(task): make scheduled occurrences durable` |
| Stage 4 - Execution Safety, Budgets, Cancellation | complete | `4ced164`, `031baea`, `20c235d`, `e75a754`, `7e1ed9f` |
| Stage 5 - Context, Checkpoint, HITL Conformance | in_progress | Part 1 `b223636`、Part 2 `639c019`、Part 3A `873df23`、Part 3B final verification 已通过，待本次提交。 |
| Stage 6 - Observability, Integration Tests, Evals | pending | Stage 5 完成后开始。 |
| Stage 7 - Native Convergence, Patch Upgrade, Cleanup | pending | Stage 6 完成后开始；最终做 current-tree completion audit。 |

## Stage 5 Plan

### Part 1 - Immediate Context Correctness

- [x] middleware 返回 LangGraph reducer state update，不原地修改输入 state。
- [x] 只摘要将被移除的 segment，不重复 recent messages。
- [x] summary 失败后执行 deterministic hard trim；仍超限时在 model call 前返回不可重试的 `context_budget_exhausted`。
- [x] 拆分 model input、reserved output、system/tool overhead、summary budget 和 safety margin。
- [x] 优先使用 provider/model token counter；fallback 保守估算并记录 `estimated=true`。
- [x] `read_context_artifact` 按 thread/workspace/hash 授权并支持 offset/limit；移除虚假 retrieval hint。
- [x] summary model call 前先对 summary input 做硬预算裁剪；summary 预算包含 system/prompt overhead 与 safety margin，预算不足时不得发起 provider call。
- [x] summary fallback 只处理明确的 model/provider schema failure；未知编程或配置错误必须继续抛出。
- [x] hard trim 覆盖 AI tool-call 与 ToolMessage 成对保留/删除回归。
- [x] focused tests、typecheck、strict unused scan、IPC check、diff check、build 和 full Vitest 通过；独立 review 无未处理 finding。

### Part 2 - Native Convergence

- [x] 对 Deep Agents 1.10.7 native summarization 与 Roc pipeline 做固定 corpus A/B conformance。
- [x] 比较 completion、summary fidelity、input/output token、cache contract、artifact recovery、checkpoint size 和 subagent compatibility。
- [x] 只保留一个生产路径，不长期维护双栈。

结论：保留 Roc pipeline。harness profile 过滤 main 的 `SummarizationMiddleware`；Roc builder 将声明式 subagent 编译为 runnable，显式复用官方 todo/filesystem/skills/patch/cache middleware，仅保留 Roc context pipeline。真实 Anthropic `cache_read` 命中需外部 provider 请求，归 Stage 6 provider integration，不作为本地命中结论。

### Part 3 - Checkpoint And HITL

#### Part 3A - Saver Conformance

- [x] 用同一套上游 `BaseCheckpointSaver` 行为集覆盖 get/list/put/putWrites/delete。
- [x] 覆盖 metadata filter、before/limit ordering、parent config 和 special writes。
- [x] 独立 review、focused verification 与提交 `873df23` 完成。

#### Part 3B - Interrupt Projection And Restart

- [x] pending interrupt 改为 collection projection；checkpoint 保持执行真相。
- [x] resume 使用 `interruptId -> value` map，dispatch 失败时保留 waiting projection。
- [x] 用真实 Deep Agents + Roc saver 覆盖 approval、ask_user、multiple interrupts 和跨进程 restart/resume。
- [x] focused tests、typecheck、strict unused、IPC check、build、full Vitest、diff check 与独立 review 通过后提交。

#### Part 3C - Recovery-safe Retention

- [ ] retention 以 terminal state 和 recovery safety window 为边界，覆盖 checkpoint/writes/artifacts/events。

## Acceptance Criteria

- 任意 model call 前满足 context hard budget；失败不得携带超限 context 继续请求。
- compaction 结果通过 reducer 写入，并在 restart 后的 checkpoint 中可见。
- artifact 可按当前 run scope 精确恢复，越权读取明确失败。
- approval、question 和 multiple interrupts 跨进程恢复通过真实框架测试。
- Stage 5 独立 review 无未处理 finding，全部项目门通过，并形成独立提交。

## Decisions

| Decision | Rationale |
|---|---|
| 严格按 Stage 0-7 顺序 | `plan.md` 是当前验收源，避免跨 stage 混合事实源。 |
| 每个 stage 独立提交 | 保持 review、验证和回滚边界。 |
| Scheduler misfire 使用 latest-only coalesce | 已确认同 task 不重叠，错过多次只保留最新 occurrence。 |
| Interactive shell 不审批 | 已确认；仍明确标为 host code execution。Background shell 必须使用任务创建时冻结的 pre-authorization。 |
| Cleanup 只做 evidence-first deletion | 无调用、测试、unused scan 或重复证据时不删除。 |

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| `rg` 查询 `MessagesAnnotation` 无匹配时返回 1，导致并行批处理整体失败 | 1 | 改用包导出运行探针与更窄的声明文件定位；未修改项目文件。 |
| summary failure focused test 缺少 `context_compaction_failed` 事件 | 1 | 将失败事件移到 hard-trim 成功后的调用方；hard-trim 失败由外层 catch 单次发射。 |
| profile 接口切换后 typecheck 报 10 个旧 `budgetTokens` 调用点 | 1 | 作为显式迁移清单；更新 agent-builder/executor 与测试为 `budgetProfile`，不保留兼容别名。 |
| PowerShell `rg` 查询 native middleware 时双引号插值解析失败 | 1 | 改用单引号查询并拆分并行命令；仓库未修改。 |
| compiled subagent 首次 typecheck 未传播声明式校验收窄 | 1 | `requireDeclarativeSubagents` 显式返回 `SubAgent[]`，不放宽 opaque subagent 拒绝合同。 |
| 真实 route integration 首次调用缺少 `forge_error_tracker`，summary flush 随后因 thread fixture 缺失触发外键失败 | 2 | 按现有 state contract 初始化 tracker，并先持久化 `agent_threads`；未放宽生产 schema 或外键。 |
| 恢复会话时两次 `functions.exec` 并行读取脚本因 JavaScript 括号/语句结构错误未执行 | 2 | 改为更简单的 `Promise.all` 调用结构；仓库未被修改，后续读取成功。 |
| 读取四个测试片段的并行 PowerShell 命令因一段字符串未闭合退出 1 | 1 | 改用各自 `Get-Content | Select-Object` 命令并行读取；未修改仓库。 |
| Part 3B 第一轮 typecheck 报 repository 新返回结构与 required resume audit 的两个旧测试调用未迁移 | 1 | 更新测试为 `interruptedRun.run.status`，并传入具体 approval audit；不放宽生产类型。 |
| 2026-07-21 focused context 命令经 `pnpm test -- ...` 实际执行全套 301 files，4 tests 失败 | 1 | 3 个 pipeline 用例触发 `context_budget_exhausted`，1 个质量门发现 `context-token-budget.ts` 空 `catch`；先按失败边界修复，再改用 `pnpm exec vitest run <files>` 跑窄测试。 |
| 新增 summary budget 测试后 10-file focused run 有 6 个 pipeline 失败 | 1 | 测试计数器匹配了不存在的 `You summarize old runtime context.`，真实 system message 为 `... for Roc.`；修正测试锚点，不放宽生产预算。 |
| 使用 PowerShell 通配路径检索 pnpm 声明时，`rg` 将 `node_modules/.pnpm/langchain@*` 当作字面路径并返回 os error 123 | 1 | 改用 `.pnpm` 根目录检索；未修改仓库。 |
| Part 3B 当前 focused/typecheck 并行验证被测试类型错误阻断：`session-repository.test.ts:468` 的 `payload.content` 未收窄 | 1 | 已对 unknown payload 做 object/null 收窄并通过 `Reflect.get` 精确断言；生产类型未放宽。 |
| Part 3B runtime red test：resume audit 事务失败后 run 停在 `dispatch_pending` | 1 | 增加 primed stream 显式 close；commit 异常时 abort、rollback 到 `waiting_user` 后关闭 stream，再抛出原错误。 |
| Part 3B 双轴 review worker 失败 | 1 | Standards worker SSE idle timeout，Spec worker 429；无 review 结论，修复后重试。 |
| Part 3B 查询 LangGraph serializer 时 PowerShell 将 pnpm 通配目录当作字面路径，返回 os error 123 | 1 | 改用 `node_modules/.pnpm` 根目录配合 `rg --glob`；不重试通配路径。 |
| Part 3B transcript UI 首次读取使用了错误的 `chat-message-row.tsx` 路径 | 1 | 先用 `rg --files` 定位实际组件路径，再读取目标；未修改代码。 |
| Part 3B transcript fixture 批量 patch 因重复 `interrupt` 区块无法匹配 | 1 | 改用局部文件段落的结构化机械替换，再以 focused renderer tests 验证。 |
| Part 3B focused renderer test 仍断言废弃单值 `message.interrupt` | 1 | 改为 collection `message.interrupts` 断言，并补多项 interrupt 可见性回归。 |
| Part 3B transcript collection 首轮 typecheck 的 edit decision 变量名错误 | 1 | 使用已收窄的 `editableAction` 显式赋给 `editedAction` 字段。 |
| Part 3B checkpoint serializer 查询再次将 pnpm 通配目录作为字面路径 | 1 | 直接检索 `node_modules/.pnpm` 根目录并用 `--glob` 过滤包路径；不重复通配目录命令。 |
| Part 3B serializer 检索受默认 node_modules ignore 影响无结果 | 1 | 对已确认的 `node_modules/@langchain/*` 目录使用 `rg -uuu`；未修改生产代码。 |
| Part 3B serializer symbol 三次静态检索均无结果 | 3 | 停止重复源码检索；改以真实 Roc saver integration 产生的 `value_type`/`value_blob` 为唯一解码依据，再实现受限 decoder。 |
| Part 3B checkpoint recovery 首轮 focused tests 3 failed | 1 | 旧 repository fixtures 使用空 interrupt write；真实 saver payload 未匹配 plain `{id,value}` 假设。先读取真实 serialized value，更新 decoder 与 fixture 后重跑。 |
| Part 3B projection validation 首轮 focused tests 5 failed | 1 | 已持久化 approval payload 是 `{kind:'approval',request}`，原 normalizer 只接受 bare HITL request；新增该已存合同分支后重跑。 |
| Part 3B final spec re-review：corrupt projection 阻断 checkpoint recovery | 1 | reconcile 覆盖路径仅识别并替换 `agent_pending_interrupt_payload_invalid`；普通读取保持显式失败。 |
| Part 3B audit resume-map focused command 发送时 JavaScript 参数缺少 JSON 引号 | 1 | 重发同一未执行的 PowerShell 命令；仓库未受影响。 |
| Part 3B audit resume-map 首轮 focused：readonly decisions 不兼容 LangGraph mutable response，旧 fake executor 将含 approval 的完整 map 误判为首轮 resume | 1 | durable payload 使用 mutable decision array；fake executor 仅在缺 question 时模拟首轮 approval。 |
| Part 3B final broad gate 首次发送时 JavaScript 参数缺少 JSON 引号 | 1 | 重发同一未执行的 PowerShell 命令；仓库未受影响。 |
| Part 3B final status patch 未匹配已提前勾选的 checklist 行 | 1 | 读取当前 Stage 5 段落后按实际状态做局部更新；未修改代码。 |
| Part 3B concurrency regression review 的 typecheck 将闭包赋值变量收窄为 `never` | 1 | 使用对象属性保存 gate release，等待后显式非空检查；不改变并发行为。 |
