# Roc Agent Harness 执行账本

> 职责：记录当前阶段、剩余工作、有效决策和阻断项。长期规格见 `plan.md`，技术结论见 `findings.md`，执行与验证历史见 `progress.md`。

## Goal

按 `plan.md` 的 Stage 0-7 顺序完成 Agent Harness 优化。每个 stage 独立实施、review、修复、验证和提交；最终只删除有直接证据证明无用的遗留代码。

## Source of Truth

| 内容 | 权威来源 |
|---|---|
| 产品目标、架构边界、Stage 0-7 验收 | `plan.md` |
| 当前阶段、待办、阻断项 | `task_plan.md` |
| 已确认技术事实、风险 | `findings.md` |
| 已完成操作、提交、验证结果 | `progress.md` |
| 实际实现状态 | 当前工作树、Git 历史、新鲜验证结果 |

来源冲突时，以当前工作树和新鲜验证为准；旧记录只作历史证据。

## Current Phase

**Stage 7 Part 4 - Evidence-Gated Performance Tuning**

**Status:** complete (`evidence-backed no-change; verified, reviewed and staged as an independent part`)

- Review baseline：`e94a7fc fix(agent): centralize Deep Agents stream shape`。
- 当前范围：对 `plan.md:670-678` 的五个性能候选读取现有 metrics、artifact、真实调用链与 owner tests；只实现能由稳定基线证明收益且不破坏隔离合同的最小优化。
- 保留现有产品语义：per-run snapshot/config/secret 隔离、prompt/tool/capability 语义、event 顺序/backpressure、UI transcript 完整性与 restart/HITL 行为不变。
- 不在本 part 引入：无指标支持的缓存/复用、依赖升级、全局可变 singleton、prompt 内容改写、UI 功能或无证据 cleanup。
- `plan.md` 继续作为未跟踪规格源，不进入提交。

## Phase Status

| Stage | Status | Evidence |
|---|---|---|
| Stage 0 - Characterization Gate | complete | 并发、terminal projection、restart、scheduler crash、backpressure、abort 与 Windows child-tree 均有回归证据。 |
| Stage 1 - Immutable Run Contract | complete | `4d9e8a3` |
| Stage 2 - Durable Run State, Outbox, Bounded Timeline | complete | `1fbda30` |
| Stage 3 - Durable Background Occurrences | complete | `dfbbf00` |
| Stage 4 - Execution Safety, Budgets, Cancellation | complete | `4ced164`, `031baea`, `20c235d`, `e75a754`, `7e1ed9f` |
| Stage 5 - Context, Checkpoint, HITL Conformance | complete | `b223636`, `639c019`, `873df23`, `fcc9c8c`, `9942594` |
| Stage 6 - Observability, Integration Tests, Evals | complete | Part 1 `e538ba9`；Part 2 `abc3220`；Part 3 backend `012c870`；Part 3 UI `82164ab`；Part 4 `da0eb8d`；Part 5 `298b2da`；稳定性 `332048d`；Part 6 `2ea75fe`；Part 7 `dd5af40`。 |
| Stage 7 - Native Convergence, Patch Upgrade, Cleanup | complete | Part 1 `4f37f17`；Part 2 `475b4d2`；Part 3 `e94a7fc`；Part 4 五项均为 evidence-backed no-change，performance/broad gates 与 review 已通过。 |

## Current Acceptance

- [x] 五个候选均已审计现有指标或明确测量缺口、真实调用链、ownership 与隔离约束；无指标授权修改的候选明确不改。
- [x] 没有候选通过实施门槛，因此未增加 performance/behavior regression 或 production 优化；现有 metrics/artifact 作为 no-change 证据。
- [x] provider/config/secret、prompt/hash/order、event 顺序/terminal/backpressure 边界已审计并因 no-change 保持不变。
- [x] production/tests 无改动，因此无新增 focused/eval gate；agent/UI performance、typecheck、strict unused、IPC check、build、full Vitest 与 diff check 均通过。
- [x] Standards、Spec 与 Risk review 无未处理 finding；Part 4 staged exact-set 仅三份账本，不包含 `plan.md`，形成独立 docs-only 提交。

## Stage 7.3 Closure Evidence

**Migrate consumers and projections to the adapter DTO**

**Status:** complete (`reviewed, verified and committed as e94a7fc`)

- Observable contract：同一 Deep Agents run stream 输入产生与基线相同的 message/tool/subagent projection、usage accumulation 和 final output。
- Characterization：用可控 model/tool/subagent 驱动当前安装包生成 fixture；先证明现有 projection 对上游 shape 的分散依赖，再建立 adapter contract。
- Implementation boundary：只新增 1.10.x/v3 adapter 和直接测试，并把 shape 读取迁入该 owner；不构建未要求的多版本兼容框架。
- Verification：真实 package conformance 为 1 file / 2 tests，typecheck 与 diff check 通过；characterization 自查无待处理 finding。
- Red contract：直接把真实 run 交给 adapter，固定 message/usage/tool/named-subagent/cause/terminal/output DTO；破坏必填字段、Promise 或 AsyncIterable 合同时显式失败。
- Red verification：1 file / 8 tests 为原始 shape 2 passed、adapter 6 expected failures；typecheck 与 diff check 通过；测试自查补齐递归和全部 tool Promise 边界后无剩余 finding。
- Adapter verification：package-declared undefined cause finding 已红绿闭环；最终 1 file / 9 tests、typecheck 与 diff check 通过，adapter 小段 review 无剩余 finding。
- Consumer migration verification：上一会话 8 files / 57 tests 为 56 passed、1 failed；唯一失败是 bounded queue overflow fixture 不再制造稳定 burst。`pnpm typecheck` 仅剩 `deep-agent-executor.ts:576` 的 `recordTaskEvent` 不属于新 `StreamConsumerCallbacks`。
- Direct closure verification：overflow fixture 以真实 1000-event queue 连续 5 次通过；两个直接 owner files / 13 tests、`pnpm typecheck` 与 `git diff --check` 全部通过。当前剩余工作是恢复完整 focused gate、残余扫描和 consumer migration review。
- Full focused verification：adapter、consumers、usage、subagent 与 executor/final-output 8 files / 57 tests 全部通过；进入当前未提交 diff 的 Standards / Spec 分段 review。
- High review-fix red verification：root text/output 同时失败时稳定捕获 1 个 `unhandledRejection`；1 file / 10 tests 为 9 passed、1 expected failure。
- High review-fix implementation：把 `message.trailingReasoning` 加入 root message 初始 `Promise.all`，确保所有派生 Promise 同步安装 rejection handler；最窄 owner gate 1 file / 10 tests passed。
- Direct review-fix verification：adapter conformance、root consumer 与 subagent projection 3 files / 28 tests、`pnpm typecheck`、`git diff --check` 全部通过；三条 review finding 均有直接绿灯。
- Restored focused verification：adapter、consumers、usage、subagent 与 executor/final-output 8 files / 63 tests passed；consumer/projection raw-reflection、旧 callback/helper/cast 残余扫描均为 0。
- Local Risk High：`run.output` 与 `subagent.output` 均由 adapter 立即派生，但 consumer 在对应 streams 全部完成后才 await；2 files / 15 tests 为 13 passed、2 expected failures，分别捕获对应 output rejection。
- Adapter validation red：adapter 在派生 `run.output` 后才同步校验 terminal fields；invalid `interrupted` + rejected output 稳定捕获第三个 `unhandledRejection`，owner file 12 tests 为 11 passed、1 expected failure。
- Output observation green：root/subagent 用早期 settlement 保留 stream-first 错误优先级，adapter 先完成同步 validation 再派生 output；3 files / 27 tests passed。
- Terminal contract branch coverage：missing error、non-terminal status、unexpected error 三案例直接通过；adapter owner 1 file / 15 tests passed。
- Spec rereview finding：tool output/status/error 依次派生；rejected output + non-Promise status 稳定产生 adapter 派生 `unhandledRejection`，adapter gate 16 tests 为 15 passed、1 expected failure。
- Tool ordering green：adapter 在派生前同步验证全部三项 Promise-like 边界；同一 owner gate 16/16 passed。
- Combined review-fix gate：adapter、root message、subagent、executor streaming 4 files / 41 tests、`pnpm typecheck` 与 `git diff --check` 全部通过。
- Final Spec / Local Risk High：root/subagent tool consumers 在 start/todo callbacks 后才 await `call.outcome`；同步 projection failure 与 rejected outcome 并发时，reviewer probe 已捕获 `unhandledRejection`，需两路 owner red tests。
- Tool outcome red：root/subagent owner 2 files / 20 tests 为 18 passed、2 expected failures，分别捕获 rejected outcome。
- Tool outcome green：两路 consumer 在任何 callback 前建立 settlement、原 await 点读取；同一 2 files / 20 tests 全部通过。
- Standards adapter owner finding：run/message/tool/subagent raw Promise 一旦被 adapter 读取就应立即 observation；四类“rejected Promise + later sync drift”均有只读复现，现有 test 预 catch 掩盖 run/tool 原始 owner 缺口。
- Adapter four-owner red：run/tool tests 删除预 catch，并新增 message/subagent sibling drift；owner gate 18 tests 为 14 passed、4 expected failures，四条均捕获对应 raw rejection。
- Adapter four-owner green：Promise-like 字段 capture 时立即 observation，原校验位置仍决定 contract code，投影 Promise/outcome 同样立即 observation；owner gate 18/18 passed。
- Final combined review-fix gate：adapter、root consumer、subagent projection、executor streaming 4 files / 45 tests、`pnpm typecheck` 与 `git diff --check` 全部通过。
- Restored full focused gate：adapter、consumers、usage、subagent、executor/final-output 8 files / 74 tests passed。
- Final Spec rereview：`No findings`；真实 package fixture、单一 adapter、typed projection 边界与 scope 均符合 `plan.md:666-668`。
- Rejection stability：4-file / 45-test review-fix gate 连续三轮全部通过，未出现 Vitest unhandled rejection 报告。
- Strict unused：`tsc --noEmit -p tsconfig.json --noUnusedLocals --noUnusedParameters` exit 0。
- Final review：Standards / Spec / Local Risk 均为 `No findings`；进入 broad verification。
- Broad gate partial：`pnpm check:ipc` 与 `pnpm build` 通过；首次 full Vitest 为 321 files / 1802 tests passed、`runtime-production-multiple-interrupts.integration.test.ts` 1 failed，未计为通过。
- HITL regression root cause：LangGraph 1.4.7 的 `run.interrupted` / `run.interrupts` 是 stream pump 完成后更新的动态 getter；adapter 在消费前快照为 `false` / `[]`，executor 因而误等 interrupt run 的 pending output。
- Dynamic terminal red-green：adapter owner 目标 case 先以消费后仍为 `false` 稳定失败；改为 adapter-owned validated getters 后目标 case 1/1、真实 production multiple-interrupts 1/1 通过。
- Expanded review-fix gate：原 8-file focused gate加 production multiple-interrupts 共 9 files / 76 tests，`pnpm typecheck` 与 strict unused 全部通过；增量 Standards / Spec / Risk review 进行中。
- Dynamic terminal incremental review：Standards / Spec 均为 `No findings`，Local Risk 为 `No issues found`；当前固定包在 mux finalize 后终态稳定，`run.output` rejection 已由早期 settlement 观察。
- Final broad gate：`pnpm check:ipc`、最终 `pnpm build`、full Vitest 322 files / 1804 tests、独占 agent performance smoke 1/1、typecheck、strict unused 与 `git diff --check 475b4d2` 全部通过。full Vitest 后 4 条既有 `node-pty AttachConsole failed` helper stderr 不改变 exit 0。

## Current Step

**Review no-change decision and run verification**

**Status:** complete (`verified, reviewed and exact staged boundary confirmed`)

- Observable contract：同一 frozen run snapshot 与 provider/config version 产生相同 agent behavior、prompt/tool ordering、event transcript、usage 与 terminal result。
- Measurement boundary：优先复用现有 agent/UI performance artifacts、metrics 和 deterministic fixtures；新增 measurement 只在现有证据无法区分候选时进行。
- Decision rule：候选必须同时证明可复现成本、明确 owner、可隔离复用条件和直接等价验证；否则记录为 no-change。
- Verification：candidate matrix 先经过 Standards / Spec / Risk review；本 part 没有 production 实施候选，review 关闭后直接进入 performance/broad gate。
- Review closure：首轮 Standards 的 1 个 Medium 验收措辞 finding 已修正；增量 Standards / Spec 均为 `No findings`，Local Risk 为 `No issues found`。
- Final rereview：新鲜 agent/UI artifact 与 broad-gate 记录更新后，Standards / Spec 仍为 `No findings`，Local Risk 仍为 `No issues found`。

## Next Steps

1. [complete] 增加 disabled ambient env 与同 run multi-invocation red tests，并记录稳定失败。
2. [complete] 修复 backend tracing lifecycle，重跑 focused backend gate、typecheck 与 diff check。
3. [complete] 为 restart root continuity、manual root runtime redaction、root exporter failure 与 cancel/shutdown lifecycle 增加稳定红测。
4. [complete] 修复 durable root identity、export boundary 与 tracing lifecycle owner，重跑 backend gate。
5. [complete] 删除 Standards 复审确认的 unused import；用红测复现终态事务后崩溃遗留 trace session，并实现只处理四类 terminal session 的最小 startup reconciliation。
6. [complete] 最终 Standards / Spec / Risk 无 residual finding；15-file direct gate、strict unused、typecheck、IPC check 与 diff check 通过；backend 已提交为 `012c870`。
7. [complete] 定位 shared IPC / generator / preload / renderer settings 路径，固定 observable contract；5 files / 24 tests 红灯为 17 passed、7 expected failures。
8. [complete] 实现独立“可观测性”section，生成 IPC，完成 review、focused/响应式与 broad verification。
9. [complete] 定位 package/Vitest、真实 Deep Agents builder、Roc SQLite fixture 与 provider boundary，冻结 integration contract。
10. [complete] 先增加独立命令/default exclusion/offline execution/live opt-in no-key failure 的稳定红测。
11. [complete] 实现最小 integration config 与 harness，完成 focused verification。
12. [complete] 完成 Standards / Spec / Risk review、修复、broad gate 与独立提交。
13. [complete] 定位 eval script/config、真实 builder/checkpointer、trajectory 与 Plan Mode guard 复用边界，冻结 Part 5 contract。
14. [complete] 增加 CLI/config/dataset 与两个 deterministic scenario 的稳定红测。
15. [complete] 实现最小 runner、专用 config、strict dataset 与真实 eval harness，完成 focused verification。
16. [complete] 完成 Standards / Spec / Risk review、修复、broad gate 与独立提交。
17. [complete] 定位 live provider、structured judge、runner/config 与 dataset 边界，冻结 Part 6 contract。
18. [complete] 增加 live CLI/config、dataset/judge 与真实 harness case 红测。
19. [complete] 实现最小 live eval mode，并完成 focused verification。
20. [complete] 完成 Standards / Spec / Risk review、修复、broad gate 与 Part 6 独立提交。
21. [complete] 定位现有 performance smoke/artifact、真实 agent loop、checkpoint/restart、subagent 与 event/outbox measurement owner，冻结 Part 7 contract。
22. [complete] 增加独立命令、strict artifact schema、deterministic scenarios 与 threshold failure 红测。
23. [complete] 实现最小 agent performance runner；为三路 subagent fan-out 增加 budget state isolation 红测与最小修复，完成 focused verification、五轮同机采样和有限 baseline 校准。
24. [complete] 完成 Standards / Spec / Risk review、修复、独占 agent smoke、broad gate 与 Part 7 独立提交 `dd5af40`。
25. [complete] 用 CodeGraph 定位 middleware、tool protocol、rescue parsing、resolution、error mapping、retry/effect 和 event 的真实生产调用链及 owner tests。
26. [complete] 读取安装包 1.10.7 `PatchToolCallsMiddleware`，冻结 overlap matrix、真实 event fixture 与 deterministic trajectory contract。
27. [complete] 修复真实 execution identity、wrapper 顺序与 pre-effect resolution 状态；补齐真实 unknown-tool/subagent trajectory 和六维矩阵，8 files / 56 tests focused verified；无等价删除候选。
28. [complete] 完成 Standards / Spec / Risk review、修复、broad gate 与 Stage 7 Part 1 独立提交。
29. [complete] 审计 1.10.7 / 1.10.8 core package diff，定位 Windows glob、root containment、现有 tests 与过期版本事实。
30. [complete] 用当前 1.10.7 增加 Windows junction/symlink loop 与 root containment 稳定回归。
31. [complete] 精确升级 Deep Agents 1.10.8，更新必要事实并完成 focused verification。
32. [complete] 完成 Standards / Spec / Risk review、修复、package/Electron broad gate 与 Stage 7 Part 2 独立 staged commit boundary。
33. [complete] 重新读取安装包 stream v3 类型/运行 shape、生产调用链和 owner tests，冻结 Stage 7.3 adapter 输入/输出合同。
34. [complete] 增加真实安装包 fixture并完成稳定 characterization；真实 package gate、typecheck 与 diff check 通过。
35. [complete] 增加 adapter 红合同，实现单一 Deep Agents 1.10.x/v3 adapter，并迁移 consumer/projection 的 shape 读取。
36. [complete] 分段 review、修复并完成 focused/static/broad verification。
37. [complete] 完成 Standards / Spec / Risk 最终 review、staged-boundary 审计与 Stage 7 Part 3 独立提交 `e94a7fc`。
38. [complete] 定位五个 performance 候选的现有指标、artifact、真实调用链、隔离合同与 owner tests。
39. [complete] 五个候选均无稳定指标支持 production 优化；明确保持现有 owner、隔离与行为合同不变。
40. [complete] 完成 Standards / Spec / Risk review、broad/performance gate 与 Stage 7 Part 4 独立 staged boundary。

## Decisions

| Decision | Rationale |
|---|---|
| 严格按 Stage 0-7 顺序 | `plan.md` 是当前验收源，避免跨 stage 混合事实源。 |
| 每个 stage/part 独立提交 | 保持 review、验证和回滚边界。 |
| Telemetry 是 per-run durable row，不是无限 metrics label | 保留诊断关联，限制 cardinality。 |
| Corrupt 或 missing telemetry 显式失败 | 不用空值或重建覆盖损坏证据。 |
| Terminal telemetry 与 run 终态同事务 | 防止 lifecycle 与诊断事实漂移。 |
| LangSmith tracing 默认关闭且显式 opt-in | 外部 trace 不能由隐式产品行为开启；导出必须经过 allowlist/redaction boundary。 |
| LangSmith 配置与密钥归 Agent plugin config/secrets | 保持单一 owner；不升级全局 AppSettings，不复用 provider secret 语义。 |
| Cleanup 只做 evidence-first deletion | 无调用、测试、unused scan 或重复证据时不删除。 |
| Stage 7.1 与 1.10.8 升级分开提交 | 避免把 native overlap 行为变化与 framework patch 混成一个事实源。 |
| Stage 7.3 adapter 只支持当前 1.10.x / stream v3 合同 | 规格要求集中 shape owner，不要求提前建立多版本兼容或迁移机制。 |
| Stage 7.4 不修改 production/tests | 五个候选均无稳定指标证明收益；缓存/重排/合并会扩大 config-secret、snapshot 或 event 语义风险。 |

## Review Closure Checks

| Severity | Finding | Current closure state |
|---|---|---|
| High | LangSmith root 仅存于进程内 `Map`；`waiting_user` 跨进程 resume 会为同一 Roc run 创建第二个 root。 | 已增加 durable trace-session identity 与 restart regression；最新 direct gate 通过，待最终复审。 |
| Medium | `RunTree.postRun()` 写入的 `extra.runtime` 未被 `omitTracedRuntimeInfo` 清除。 | 已在 manual root export boundary 删除 runtime info 并断言 POST/PATCH payload；最新 direct gate 通过，待最终复审。 |
| Medium | Exporter failure regression 只覆盖 child tracer，未覆盖 manual root POST/PATCH 与 terminal 业务结果。 | 已补 root start/end exporter failure regression；最新 direct gate 通过，待最终复审。 |
| Medium | Trace finish 混入 `SessionEnd` notification hook；cancel fire-and-forget、shutdown 不追踪，失败时内存 Client/API key 不释放。 | 已拆分 tracing lifecycle owner，并恢复 `SessionEnd` fire-and-forget 语义；最新 direct gate 通过，待最终复审。 |
| High | Client redaction 只覆盖 inputs/outputs/metadata/error/runtime，LangChain serialized payload 可能保留 model default headers、secret 与本地路径。 | 已在 export boundary 删除 serialized；red-green 与 typecheck 通过，待最终复审。 |
| Medium | Startup reconciliation 会生成 terminal `interrupted` run，但 initialize 丢弃返回值，远端 root 不结束且本地 session 残留。 | 已 best-effort 结束 interrupted root 并删除 session；red-green 与 typecheck 通过，待最终复审。 |
| Medium | `finishRun()` 在读取 persisted session 失败时尚未进入 cleanup `finally`，可能遗留内存 Client/API key。 | 已把 read 纳入 cleanup finally 并先 drain/cleanup client；red-green 与 typecheck 通过，待最终复审。 |
| Medium | `shutdown()` 清空 manager Map 前未等待 LangSmith auto-batch queue。 | 已用 SDK `awaitPendingTraceBatches()` 等待并调用 `cleanup()`；red-green 与 typecheck 通过，待最终复审。 |
| Medium | 同一 run 已持有 client 时关闭 tracing，下一次 provider lookup 直接删除 Map entry，未调用 client cleanup。 | 已增加 idempotent dispose 与配置关闭回归；2 files / 34 tests、typecheck 通过，待最终复审。 |
| Low | `src/main/plugins/agent/index.ts` 的 `AgentLangSmithConfigV1` type import 未使用，strict unused 报 TS6196。 | import 已删除；strict unused 新鲜通过。 |
| Medium | terminal DB transaction 提交后、`finishTracingBestEffort()` 前若进程崩溃，重启时现有 reconciliation 不扫描此前已终态 run，会遗留 durable trace session。 | 红绿修复；all-terminal/enabled PATCH regression、最终双轴/Risk review 与 15 files / 124 tests 全部通过。 |
| Medium | 持久 tracing 已关闭但本地启用草稿未保存时仍可清 key，随后留下 enabled/no-key 无效草稿。 | Standards / Spec 共同发现；约束 clear 与 enabled save 后 review-fix gate 2 files / 5 tests 通过，最终双轴复审无 residual finding。 |
| Medium | 切换到独立“可观测性”section 会隐藏其他 settings section 已存在的 dirty 计数和全局保存入口。 | Local Risk review 发现；恢复原有全局 header，跨 section regression 与最终 Risk/UI review 通过。 |
| Low | 响应式 smoke 的可观测性 header fixture 使用了实际 UI 不存在的单 pill，未覆盖更宽的 dirty count 与全局操作按钮。 | fixture 已对齐真实 header，并把 page actions 纳入 overflow 断言；320/1280px smoke 与增量双轴复审通过。 |
| Medium | Live provider case 仅依赖 disabled tracing context，已知 direct `agent.invoke` 在 ambient LangSmith env/key 下仍可能额外外发。 | offline/live 共用显式 env/key isolation；offline regression 先模拟 ambient tracing/key 再证明零 fetch，专用命令通过。 |
| Low | Part 4 账本仍写 discovery，并把 live 缺 key 分支误写为 skipped。 | 已同步为 verified passing，并明确区分默认未 opt-in skipped 与 opt-in 缺 key failure；最终 Standards 复审无 residual finding。 |
| Medium | Part 6 live egress guard 仅校验 hostname，会接受非默认端口，且 provider fetch 可能自动跨域 redirect。 | 两条稳定红测后收紧为 Anthropic HTTPS default port，并强制 `redirect: 'error'`；live contract 8 passed / 1 skipped。 |
| Medium | Part 6 broad suite 中既有 multiple-interrupt integration 再次越过 10s 内部 deadline。 | 单文件复现后仅调整测试等待预算，双轴 review 无 finding；独立提交为 `332048d`，随后 full Vitest 316 files / 1731 tests 通过。 |
| Medium | Threshold failure artifact 可缺失其余 required metrics；execution error 的 partial 语义与 threshold completion 未区分。 | 红绿修复；contract 13/13 passed，最终 Standards/Spec/Risk 复审无 finding。 |
| Medium | Restart fixture 在临时目录 cleanup `try/finally` 外构造首个 file-backed SQLite connection。 | nested cleanup、agent smoke 与两类临时目录 0 残留已验证；最终复审无 finding。 |
| Hard | Performance smoke 有 `expect` 与 `agentPerformanceMetricIds` 两个 unused import。 | 已删除；typecheck、strict unused 与最终 Standards 复审通过。 |
| Hard | Artifact builder 缺 clean-pass 与 threshold-breach 两个确定性分支测试。 | 三分支测试已补，contract 13/13 passed；最终 Standards/Spec 复审无 finding。 |
| Medium | Effectful `RocToolResolutionError` 明确发生在副作用前，却先被 effect middleware 记为 `unknown`。 | 已红绿改为 `failed_final` 后由 resolution 返回 soft result；direct + real schedule regression 与最终三轴复审通过。 |
| Medium | Unknown-tool、真实 subagent effect identity 与 CompiledSubAgent patch wiring 缺直接 trajectory/wiring 证据。 | 已补 real unknown-tool hard boundary 与 real `task` subagent effect/checkpoint trajectory；既有 compiled wiring owner 纳入 focused gate，最终三轴复审通过。 |
| Medium | Stage 7.1 尚未逐层形成 input/output/error/retry/effect/event 六维责任矩阵。 | `findings.md` 已逐层引用 production owner 与 owner tests，最终 Standards / Spec / Risk review 无 finding。 |
| Low | `progress.md` 顶部仍写 Stage 6 Part 7 进行中、Stage 7 pending。 | 已同步为 Stage 7.1 review-fix 状态。 |
| Low | overlap conformance fixture 的 `effectStore?` 多缩进 2 空格。 | 已修正；typecheck 与 diff check 通过。 |
| Medium | Native retry 位于 protocol/cancellation 外侧且使用默认 all-error predicate；`web_read` / `web_search` 的 scope denial 或 abort 会重试三次并被转换为 error `ToolMessage`。 | 多轮红灯固定 order/predicate、hard onFailure 与 soft exhaustion；conditional handler 保留两类合同，真实 agent exhaustion/effect trajectory 与最终三轴复审通过。 |
| Medium | `unwrapMiddlewareError()` 未检测 branded `cause` 环，自环/双环可同步无限循环并冻结 main process。 | 已加入 visited-set 终止条件及自环/双环回归；最终 Risk/Standards 复审无 finding。 |
| Medium | `onFailure: error` 虽保住 hard boundary，却把已证明的 retry exhaustion error ToolMessage 改成 agent hard failure。 | Standards 增量红灯后改为 conditional onFailure；abort/non-retryable 外抛，真实 exhaustion 返回脱敏 error ToolMessage 且 ledger 为 `failed_retryable`，最终复审闭环。 |
| Medium | 两处 middleware 顺序测试未先证明参与节点存在，`indexOf() === -1` 可能让安全顺序断言假通过。 | 已显式拒绝缺失 middleware 配置，并对全部参与节点做 concrete membership assertion 后再比较顺序；3 files / 31 tests、完整 9 files / 63 tests、typecheck 与 Standards 增量复审通过。 |
| Low | `progress.md` 顶部 Current State 仍写首轮 findings 正在闭环。 | 已同步为 broad gate 通过、最终 review-fix 闭环与独立提交待完成；Standards 增量复审无 finding。 |
| Low | overlap conformance 新增英文代码注释不符合仓库默认简体中文约定。 | 已改为简体中文；3-file direct gate、9-file focused gate 与 Standards 增量复审通过。 |
| Medium | Stage 7.2 grep fallback 回归只断言空结果，未证明 fallback 确实执行或 root 内合法匹配仍可返回。 | 已断言 `ripgrepSearch()` spy 调用，并用同一 marker 具体断言只返回 root 内文件；direct 1 file / 3 tests 与 focused 4 files / 41 tests 通过。 |
| Low | Stage 7.2 活动账本仍写 package discovery，与 focused/static 已通过的事实冲突。 | Current Phase 与 Stage 7 状态已同步到 review-fix/broad gate 边界。 |
| Low | `package.json` 升级 diff 额外删除基线 EOF 空行。 | 已恢复基线 EOF；cached diff 只保留 `deepagents` 精确版本行变化，Standards 增量复审为 `No findings`。 |
| Medium | Prescribed Electron smoke 的两个合成 provider 未声明 context window，完整 system/tool/schema 下分别在 task 与 chat 边界失败。 | 只在 smoke fixtures 显式设置并回读 128000；同一 `pnpm smoke:electron` 已转绿，production budget/default 未改变，增量三轴 review 无 finding。 |
| Low | Stage 7.2 required-gate 边界只写 `smoke-provider`，与实际同时修复 `smoke-ui-openai` 的两处 fixture 不一致。 | 已同步为“两个合成 provider”，Standards closure 复审为 `No findings`。 |

| Medium | Tool consumers 等待但忽略 terminal status/error，合法 error 可能误投影 end 或被悬挂 output 阻塞。 | 已红绿改为 adapter-owned outcome；3 files / 25 tests、typecheck、残余扫描与 diff check 通过，待最终复审。 |
| Medium | Adapter 仍把 message output/final messages 暴露为 unknown，consumer/final-output 继续解析 reasoning 与 role/type/content。 | 已红绿改为 adapter-owned `trailingReasoning` / `finalAssistantText`；3 files / 27 tests、typecheck、shape 残余扫描与 diff check 通过，待最终复审。 |
| High | Adapter 立即派生 `trailingReasoning`，root consumer 却在 text/reasoning/usage 完成后才 await；并发双失败可留下 unhandled rejection。 | Standards reviewer 定位并实测；当前为 **Located**，待并发观察红测与最小 Promise.all 修复。 |

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| 本轮首次并行恢复读取包含预期可能返回退出码 1 的 memory 搜索，编排器提前失败且未保留同组输出 | 1 | 失败组只读且未修改文件；改用 `Promise.allSettled` 并在 shell 内把 expected non-match 转为成功状态。 |
| 启动 Standards 子审查时两次传入空 `reasoning_effort`，工具参数校验拒绝调用 | 2 | 未创建 agent、未修改文件；改用有效 model/reasoning 参数后成功启动。 |
| Risk 扫描再次把 Windows shell glob 当作 `rg` 路径，并把 `foreach` 输出直接接管道，分别触发路径错误和 `An empty pipe element is not allowed` | 1 | 两个命令均只读且未修改文件；后续改用目录 + `-g`，并先赋值 `$rows` 再输出。 |
| Part 7 review inventory 的 untracked 文件统计把 `foreach` 输出直接接到管道，再次触发 `An empty pipe element is not allowed` | 1 | 命令只读且未修改文件；改为先赋值 `$rows` 再输出，并将该已知 PowerShell 规则用于后续清单。 |
| 本轮安装包定向检索再次把可能无匹配的 `rg` 放入 fail-fast 并行组，单条退出码 1 丢弃其余只读输出 | 1 | 失败组未修改文件；后续安装包检索逐项捕获退出结果，禁止把 expected non-match 放入 `Promise.all`。 |
| 本轮向 `findings.md` 追加结论时误用了 `progress.md` 的尾行作为 patch context | 1 | 补丁校验失败且未修改文件；读取真实尾部后按已存在的 LangChain `wrapToolCall` 结论追加。 |
| 两个只读 PowerShell 统计命令把 `foreach` 输出直接接入管道，触发 `An empty pipe element is not allowed` | 2 | 先赋值给 `$rows` 再输出；失败命令未修改文件。 |
| 并行恢复检查中的 `git check-ignore plan.md` 以退出码 1 表示文件未忽略，导致 `Promise.all` 提前失败 | 1 | 将 expected non-match 显式转换为成功输出；确认 `plan.md` 未跟踪且未忽略。 |
| Windows `rg` 参数使用 shell glob 路径，并包含可能无匹配的查询；产生路径错误/退出码 1 | 2 | 后续禁止把 glob 放在路径参数；只使用目录参数配合 `-g`，并把无匹配与命令错误分开处理；失败命令未修改文件。 |
| `pnpm test -- tests/main/infrastructure/database-migrations.test.ts` 将 `--` 传给 Vitest并运行全部 310 个文件，而非只跑目标文件 | 1 | 红灯仍精确落在新增 V1 test；后续 focused 验证改用 `pnpm exec vitest run <path>`。 |
| Stage 7.1 owner 检索重复使用 Windows 路径 glob，并两次假设不存在的 protocol/cleanup test 路径 | 3 | 调用均只读；后续先用 `rg --files` 固定真实路径，目录检索只配合 `-g`，禁止再猜文件名。 |
| 首轮 review 账本 patch 使用了仅存在于 `findings.md` 的旧表格行作为 `task_plan.md` context | 1 | `apply_patch` 原子拒绝且未修改文件；读取真实 review table 后拆成精确 patch。 |
| 首次生产修复把 telemetry `snapshotVersion` 写成数据库原始版本，V1 row 被 strict telemetry schema 判为 corrupt | 1 | 查明 telemetry contract 固定为 normalized V2；恢复常量 2，仅扩大 migration 的 V1/V2 row 选择。 |
| 并行读取 skill 与 memory 时，预期的 memory 无匹配退出码 1 使整组 `Promise.all` 提前失败 | 2 | 本次续接再次触发后，所有可预期 non-match 均在 shell 内转换为成功输出，不再放入 fail-fast 并行组；确认无相关 memory 证据。 |
| Windows `rg` 把 `electron.vite.config.*` 当字面路径，返回路径语法错误并使并行读取提前失败 | 1 | 改为目录参数配合 `-g 'electron.vite.config.*'`，并使用 `Promise.allSettled` 保留其他读取结果。 |
| 首次补写 LangSmith discovery 时把 `task_plan.md` error ledger 的定位行误放进 `findings.md` patch context | 1 | 拆分文件职责并使用各自真实上下文；失败 patch 未修改文件。 |
| 搜索 renderer settings 时假设了不存在的 `src/renderer/settings-view.tsx`，使并行读取提前失败 | 1 | 从 `rg` 实际结果确认入口为 `src/renderer/settings/index.tsx`，后续只使用已定位路径并用 `allSettled`。 |
| 首次检索本机 LangChain runnable / tracer 实现时包含不存在的候选文件，且多个入口文件只是 re-export，导致并行组退出码 1 | 1 | 改用 `allSettled` 保留成功结果，先解析 package exports / 实际实现文件后再做定向检索；失败命令未修改文件。 |
| Backend review-fix red gate 按预期失败：trace-session repository 不存在、schema 尚为 v12、runtime 未调用 tracing lifecycle | 1 | 4 files 中既有 15 tests 通过；失败边界与 review finding 一致，进入生产修复。 |
| 首次扩展 gate 的 typecheck 发现 fake tracing 缺新增 `session`，测试 resolver 被收窄为 `never` | 1 | 只补 durable session fixture，并把 resolver 改为明确可调用的初始函数；生产代码未因此改向。 |
| 只读覆盖扫描再次用 `Promise.all` 包含预期无匹配的 `rg`，整组提前返回 | 1 | 立即改回 `Promise.allSettled`；确认无残留 agent schema v12 期望，失败命令未修改文件。 |
| 读取 `plan.md` 相关段落时把 PowerShell 脚本直接传给 JavaScript 工具编排层，触发 `SyntaxError: Unexpected token ':'` | 1 | 改为通过 `tools.shell_command` 执行同一只读 PowerShell；成功读取 Stage 6 验收，失败调用未修改文件。 |
| Risk review 的三个只读核对再次用 `Promise.all` 包含可能 non-match/越界的命令，单个退出码 1 中断整组 | 1 | 改用 `Promise.allSettled` 并分别报告结果；这是已记录错误模式的重复，后续 review 检索禁止再用会 fail-fast 的并行组。 |
| Final-review fix 首次 green 并行 gate 的 typecheck 报 5 个测试类型错误：fake tracing 缺 `shutdown()`，tracer client 窄接口不暴露 drain/cleanup | 1 | 只补 fake lifecycle 方法，并在测试 spy 边界使用实际 `Client` 类型；生产实现方向不变。 |
| Enabled startup PATCH 测试在 `Client.prototype.updateRun` spy 边界预期 `[REDACTED]`，实际为内部安全错误码 | 1 | 该 spy 位于 Client anonymizer 之前；改为断言 startup mapping 原始错误码，最终出站 `[REDACTED]` 继续由既有 fake-fetch regression 证明。 |
| UI phase 账本更新把不存在的 findings 决策表行作为 patch context | 1 | 整体 patch 未应用；改为逐文件使用实际上下文更新。 |
| 恢复阶段的首组只读并行检查包含预期可能失败的探测，单条非零使编排器未保留其余输出 | 1 | 改为逐项捕获并报告结果；确认失败调用未修改文件。 |
| LangSmith surface 搜索包含不存在的 `tests\\preload` 路径，`rg` 在返回有效匹配后仍以路径错误退出 | 1 | 后续只对 `rg --files` 已确认存在的目录检索；失败命令未修改文件。 |
| UI 首轮 green 的 checkbox updater 延迟读取 React synthetic event，`currentTarget` 已为 `null`；静态扫描同时发现两个新增状态背景 token 未定义 | 1 | 在 handler 内先复制 primitive 值再更新 state，并改用现有 `--surface-strong`；其余 23 tests、typecheck、IPC check、diff check 已通过。 |
| UI expanded gate 的 strict unused 发现新 renderer test 在 automatic JSX runtime 下仍导入默认 `React` | 1 | 删除该单个 unused import；15 files / 60 settings tests 已通过，待重跑 strict unused。 |
| UI broad gate 首次 full Vitest 发现 kernel integration 仍期望 Agent schema v12，而 Part 3 backend 已新增 canonical v13 migration | 1 | focused 1 file / 2 tests 稳定复现后只把显式版本锚点更新为 13；focused 2/2、双轴增量 review 与 full Vitest 314 files / 1721 tests 通过。 |
| Part 4 恢复阶段首组并行读取包含预期无匹配的 memory 搜索，单条退出码 1 使整组提前失败 | 1 | 改为逐项捕获并把预期无匹配转为成功；确认没有 Roc 相关 memory，失败调用未修改文件。 |
| 统计 `agent-development` reference 行数时把 PowerShell 数组语法直接传入 JavaScript 编排层 | 1 | 改为 JavaScript 数组并逐项调用 PowerShell；成功取得行数，失败调用未修改文件。 |
| Offline integration 的 ambient tracing 诊断多次触发 LangSmith fetch；builder 移动、ALS 初始化与官方 disabled wrapper 均未消除 direct-invoke probe | 6 | URL/stack 确认为 `/info` capability probe；撤回生产试改，专用 test process 显式关闭四个 tracing env、清空 key 并拒绝全部 fetch。 |
| 撤回 tracing 试改与更新账本的合并 patch 包含空 hunk，`apply_patch` 拒绝解析 | 1 | 拆成有明确上下文的 hunk 重试；失败 patch 未修改文件。 |
| Part 4 focused 首轮 typecheck 报 integration fixture 缺少必填 `contextBudgetTokens` | 1 | 对齐 `DeepAgentBuildInput`，显式传入 `undefined`；随后行为测试与 typecheck 均通过。 |
| 归一化 `package.json` 混合换行时，整文件转录把 `better-sqlite3` 误写为 `better-sql3` | 1 | readback 前即发现并恢复原值；随后用 baseline diff、JSON/config test 与 EOL 检查确认只有目标脚本变更。 |
| Part 5 runner 首次执行时，pnpm 把脚本分隔符作为字面 `--` 传入，parser 报 `agent_eval_unknown_arg:--` | 1 | 增加含分隔符的 CLI 红测，只剥离一个前导 `--`；实际计划命令随后通过。 |
| 核对固定 LangChain ToolMessage 实现时再次把 wildcard 放进 Windows 路径参数，`rg` 返回路径语法错误 | 1 | 改用已解析的 `node_modules/@langchain/core/dist/messages` 路径；确认 success status 可省略、error 显式。 |
| Part 5 broad gate 将 full Vitest 与 build 并行运行，两个未改动测试分别在 10s/20s 超时；314 files / 1727 tests 通过，主命令退出码 1 | 1 | 先分别单跑两个失败文件判断是否为资源竞争或既有波动，再让 full suite 独占重跑；不沿用该次失败结果宣称 broad passing。 |
| 记录 Part 5 broad 失败的首个账本 patch 使用了与实际错误表不一致的上下文，`apply_patch` 整体拒绝 | 1 | 读取当前尾部后拆分为精确上下文 patch；失败 patch 未修改任何文件。 |
| Part 6 独占 full Vitest 时，未改动的 production multiple-interrupts test 再次越过内部 10s deadline；315 files / 1730 tests 通过，主命令退出码 1 | 1 | 单文件确认行为后仅调整测试等待预算，双轴 review、focused、typecheck 与 full suite 通过；以独立 `332048d` 提交，不把首次失败写成 broad passing。 |
| 稳定性提交的 staged-boundary 断言把单行 `git diff --cached --name-only` 当作字符串，`$staged[0]` 读取首字符而误报 | 1 | 用 `@(...)` 强制数组后复核；cached name-status 已显示仅目标测试文件，错误命令未修改文件或 index。 |
| 稳定性提交后的并行只读审计在调用 shell 前引用未定义 JavaScript `result`，四项均返回 `ReferenceError` | 1 | 改回逐项 `await tools[name](args)` 并捕获结果；失败脚本未执行任何命令或修改状态。 |
| Part 6 最终 missing-key 边界包装器虽验证到预期 exit 1 与错误码，但未重置 PowerShell native exit code，导致后续串行检查未启动 | 1 | 在验证分支末尾显式 `exit 0` 后单独重跑；首次调用未修改代码，typecheck/unused/diff check 尚未执行。 |
| Part 7 检索 LangGraph stream 类型时再次把 `.pnpm/@langchain+langgraph*` wildcard 放入 Windows 路径参数，`rg` 在返回有效匹配后以路径错误退出 | 1 | 使用已解析的 `node_modules/@langchain/langgraph/dist/stream/types.d.ts` 精确路径继续；失败调用只读且未修改代码。 |
| Part 7 搜索测试内 `BaseChatModel` 子类时，正常无匹配的 `rg` exit 1 未转换为成功 | 1 | 确认仓库无可复用子类；后续无匹配查询统一显式处理 exit 1，失败调用只读且未修改代码。 |
| Part 7 并行读取 LangChain transformer 类型时假设存在 `message.d.ts`，使已启动的成功读取输出未保留 | 1 | 先用 `rg --files` 固定真实文件集合，再读取 `types.d.ts`、`tool-call.d.ts` 与 `subagent.d.ts`；失败调用只读且未修改代码。 |
| Part 7 首次合并 restart 修复与账本更新的 patch 误把 `@@` 当作 hunk 结束符，`apply_patch` 拒绝解析 | 1 | 删除多余 hunk 标记后用精确上下文重试；失败 patch 未修改任何文件。 |
| Part 7 对 pnpm package junction 使用 `rg -L` 仍未得到 middleware 匹配，随后把字符串型 `Target` 当数组取 `[0]`，错误解析为盘符 `F` | 2 | 直接读取 junction 的完整字符串 `Target` 后对真实 `dist` 路径检索；两次失败均只读且未修改文件。 |
| Part 7 按 Deep Agents 声明 bundle hash `agent-DgVtHOV7.js` 查实现，但该 hash 仅存在 `.d.ts`，运行实现位于 `langsmith-DjCMSywL.js` | 1 | 先列出实际 `dist` 文件，再从导出与 symbol 匹配定位实现 bundle；失败检索只读且未修改文件。 |
| 本轮恢复时统计 agent-development references 的 JavaScript 模板字符串嵌入 PowerShell 制表符表达式，编排层报 `SyntaxError: Unexpected identifier 't$c'` | 1 | 命令未进入 shell、未修改文件；改用 PowerShell 字符串拼接后成功，并完成所有必需参考全文读取。 |
| 本轮首次写上述错误账本时把 unified diff 直接传给 JavaScript 编排层，报 `SyntaxError: Unexpected token '**'` | 1 | 失败发生在解析阶段、未修改文件；改用 `apply_patch` 工具写入。 |
| 本轮恢复首批技能/memory 并行读取再次把预期无匹配的 memory `rg` 放入 fail-fast `Promise.all`，导致其余成功结果未保留 | 1 | 调用只读且未修改文件；立即改用 `Promise.allSettled`，后续无匹配搜索继续显式按非错误处理。 |
| Threshold exact-set 首次 green 后，旧 summary-mismatch case 仍使用 partial fixture，因新校验顺序先抛 metric-set error | 1 | 生产行为符合新合同；把 summary mismatch 改为完整 11 metrics，partial fixture 专门断言 metric-set。 |
| 记录上述 test refinement 的合并 patch 漏写文件切换标记，错误把 `task_plan.md` 表格上下文应用到 contract test | 1 | `apply_patch` 原子拒绝且未修改文件；拆成目标文件明确的两个 patch。 |
| Review closure 账本 patch 使用了恢复前的 Current Step status 文本，`apply_patch` 无法匹配 | 1 | 整体 patch 原子拒绝；先用 `rg` 读取当前状态，再按实际文本更新。 |
| Broad gate 首轮 `pnpm smoke:performance` 超过既有 profile-1k 750ms 门，实际 `2474.7138ms` | 1 | seed/native rebuild 成功，artifact 明确失败；先核对测量路径与系统负载，再独占复验，不修改既有 UI 门槛。 |
| Windows 本地化环境找不到 `\Processor(_Total)\% Processor Time` 性能计数器 | 1 | 只读探针未修改状态；改用 `Win32_Processor.LoadPercentage` 与可用内存判断复验环境。 |
| `Win32_PerfFormattedData_PerfOS_Processor` 在本机同样返回 `Invalid class` | 1 | 只读探针未修改状态；停止继续依赖 unavailable perf counters，使用无遗留 Electron、可用内存与连续独占 smoke 作为环境证据。 |
| Stage 7.1 review-fix 检索两次猜测不存在的源码路径（`middleware/index.ts`、`capability-catalog.ts`） | 2 | 调用均只读且未修改文件；第二次 `allSettled` 已保留其他结果，后续命令只使用 `rg --files` 实际返回的路径。 |
| Stage 7.1 最终 Spec reviewer 两路均被服务端 `429 Too Many Requests` 终止 | 2 | 不把失败任务视为通过；复用既有 reviewer 重试一次，同时继续本地 Spec / Risk 审查。 |
| Retry review-fix 首轮 expanded focused 行为通过后，`pnpm typecheck` 报新增 mock 为零参数 tuple 的 TS2493/TS2339/TS7006 | 1 | 生产文件无类型错误；为 `createDeepAgent` mock 增加最小配置参数类型后重跑 focused/typecheck。 |
| 本轮本地 Spec inventory 的首个并行只读组因单条非零退出而未保留同组输出 | 1 | 命令均只读；改用 `Promise.allSettled` 后逐项保留结果并完成规格行、工作树与 subagent 断言核对。 |
| Subagent namespace 收紧断言首次错误假设包含 declarative name `effect-worker` | 1 | 真实 fixture 显示 Deep Agents 以父 `task` 的 `tools:<uuid>` 作为 subagent namespace；测试改为直接断言该真实 shape，生产 identity 与 DB 交叉验证不变。 |
| 自定义 retry exhaustion handler 首轮 green 的测试误期望 raw `fetch failed` | 1 | 既有 `toRunFailure` 正确分类为 network 并返回脱敏产品文案；断言同步为 `Provider 网络请求失败：fetch failed`，生产逻辑不变。 |
| 最终本地补充扫描再次把允许无匹配的 `rg` 放入 fail-fast `Promise.all` | 1 | 三条调用均只读且未修改文件；改用显式吸收 exit 1 的 `Promise.allSettled` 后完成扫描。 |
| GitHub commit search 请求了 `gh search commits --json` 不支持的 `message` 字段 | 1 | 调用只读且未修改文件；改用已知 tag compare、release 与 PR files API 获取准确 commit/file diff。 |
| 恢复 `package.json` EOF 空行的宽上下文 patch 误匹配嵌套 `onlyBuiltDependencies` 数组结尾，短暂破坏 JSON 尾部结构 | 1 | 修改未测试、未暂存；立即按 HEAD 尾部精确恢复，`ConvertFrom-Json` 确认结构正确；Standards review 后再按基线恢复双 LF，并以 cached diff 审计。 |
| Stage 7.2 broad gate 首轮 Electron smoke 创建任务时返回 `context_budget_profile_invalid` | 1 | 打包/native 已通过；定位到 5 月沿用至今的合成 provider 未声明 context window，落到 8192 默认后无法容纳当前完整 system/tool/schema。seed fixture 显式声明 128000 后同一路径越过该错误。 |
| Electron smoke 第二轮在 settings 新建的 `smoke-ui-openai` chat 等待超时 | 1 | 默认模型已切到该 provider、提交后没有新 provider request；其 UI draft 同样未声明 context window。完成 settings UI 验收后经现有 IPC 写入并回读 128000，待同命令复验。 |
| smoke schema/renderer 调研把预期可无匹配的 `rg` 放入 fail-fast `Promise.all`，导致同组成功输出未保留 | 2 | 调用均只读且未修改文件；均立即改用 `Promise.allSettled` 获取证据，后续 optional 搜索继续逐项捕获 exit 1。 |
| Smoke-fixture Risk reviewer 已发回完整 `No issues found` 分析，但 final 状态被上游 `400 Bad Request` 标记失败 | 1 | 不把失败任务计为通过；复用同一 reviewer 极简重试，最终有效返回 `No issues found`。 |
| Stage 7.3 调研把 `node_modules/.pnpm/@langchain+langgraph*` 作为 Windows 路径 glob，触发路径语法错误 | 1 | 调用只读且其他 `allSettled` 输出已保留；后续先解析精确 package 路径，目录搜索只用 `-g`。 |
| 安装包类型核对假设存在顶层 `node_modules/@langchain/protocol`，读取路径失败并让版本输出出现空 package 行 | 1 | 调用只读且其余结果已保留；不再猜 hoisted 路径，后续从 pnpm 目录或 package exports 解析精确位置。 |
| Stage 7.3 真实 shape fixture 首轮把 message namespace/node 与 output content 假设为 root/string | 1 | 2 tests 稳定失败并给出真实 `model_request:<UUID>`、`model_request` 和 content-block shape；按实际运行规范化动态 UUID，并继续采样 message `.toolCalls`。 |
| Characterization behavior 2/2 通过后，typecheck 发现 LangGraph 根入口不导出 `ChatModelStreamHandle`，且测试把 subagent output 错收窄为 record | 1 | 改从 Deep Agents 公开 `DeepAgentRunStream['messages']` 推导 handle，并让 subagent output 保持 `unknown`；production 未受影响。 |
| 定位 `LifecycleCause` 时对 `.pnpm` 的限定 `rg` 无匹配并返回 exit 1 | 1 | 调用只读且其余 `allSettled` 结果保留；真实 runtime fixture 已固定当前唯一所需的 tool-call cause，不再扩大搜索范围。 |
| Adapter 设计阶段再次把可无匹配的安装包 `rg` 放入 fail-fast `Promise.all` | 1 | 两条调用均只读且未修改文件；改用已解析 junction 目标，并逐项吸收 exit 1 后继续。 |
| Adapter 红合同首次 typecheck 报递归 observation helper 隐式 `any` | 1 | 红灯行为已稳定；为测试观察 DTO 增加显式递归返回类型，不修改 production contract。 |
| Typed consumer migration 首轮 green 后 bounded queue overflow owner test 未再触发 `chat_run_event_queue_overflow`，而是完整返回约 4860 个事件 | 1 | 新 tool consumer 等待 output/status/error 后降低 producer burst；产品 queue 合同未改。保留原业务断言，重新构造确定性填满队列的 fixture。 |
| Typed consumer migration 后 `pnpm typecheck` 报 `deep-agent-executor.ts:576` 的 `recordTaskEvent` 不存在于 `StreamConsumerCallbacks` | 1 | 旧 guardrail stream 分支已删除；先用调用关系证明该 callback 是否仅服务旧路径，再做本次迁移导致的最小 unused cleanup。 |
| 重写 overflow fixture 时把 `startExecutorExecution(...)` 调用结尾误写成 `})();` | 1 | 在运行任何测试或 typecheck 前从刚写入的 patch 发现并改为 `});`；错误版本未进入验证或暂存。 |
| Review 基线校验使用未加引号的 `475b4d2^{commit}`，PowerShell/RTK 返回 `fatal: Needed a single revision`，并使 fail-fast 只读组未保留其他输出 | 1 | 改用 `git rev-parse --verify 475b4d2` 得到完整 SHA，并用 `Promise.allSettled` 重新取得 diff、commit list 与 spec；失败调用只读且未修改工作树。 |
| LangGraph `ToolCallStream.output` 的 reject/hang 语义取决于 runner，但 root/subagent consumers 用 `Promise.all([output,status,error])` 后只读取 output | 1 | 红灯 13/15 后已把三 Promise 配对集中为 adapter-owned outcome；3 files / 25 tests、typecheck、残余扫描和 diff check 通过。 |
| Spec review-fix 检索把 `tests/main/plugins/agent/deep-agent-*` 作为 Windows 路径 glob，`rg` 返回有效前半结果后以路径语法错误退出 | 1 | 调用只读且未修改文件；后续只传真实目录并用 `-g 'deep-agent-*'` 限定文件。 |
| Nested DTO 测试同步 patch 假设 `stream-consumers.test.ts` helper 使用 `empty()`，实际为 `empty<string>()`，导致 apply_patch context 校验失败 | 1 | 原子 patch 未修改任何文件；读取三个 helper 精确段后拆分并成功应用。 |
| Output observation 首轮 green 的 adapter test 仍捕获 fixture 自己创建的 raw rejected Promise | 1 | production 已不派生该 Promise；fixture 先观察 raw rejection，只检测旧实现额外派生的泄漏，随后 3 files / 27 tests 通过。 |
| Standards 最终增量复审被服务端 `429 Too Many Requests` 终止 | 1 | 不把失败任务视为通过；待当前 review-fix 最终树稳定后复用同一 reviewer 重试。 |
| Typed tool outcome 修复首次 patch 的函数签名上下文多了一个字符 | 1 | `apply_patch` 原子拒绝且未修改文件；读取两段当前源码后用更窄上下文成功应用。 |
| Adapter observe-on-capture 首轮 combined typecheck 报 thenable flattening 与 test mock 返回类型 2 errors | 1 | helper 接受 `T | PromiseLike<T>`，mock 保留 `Array.push` 返回值；同一 45 tests、typecheck、diff check 随后通过。 |
| 本轮恢复首个规划文件/memory 并行读取使用 fail-fast `Promise.all`，预期无匹配的 memory 搜索使成功结果未保留 | 1 | 调用只读且未修改文件；拆为规模探测并改用 `Promise.allSettled`，完成 session catch-up 与账本恢复。 |
| Stage 7.3 首次 broad full Vitest 的 production multiple-interrupts 在 20 秒内未产生两个 interrupt event | 1 | 单文件有效复现后定位为 adapter 快照 LangGraph 动态 terminal getter；直接合同红绿、真实 production 1/1 与扩展 focused 9 files / 76 tests 已通过，待 full Vitest 重跑。 |
| 诊断时使用 `pnpm test -- <file>` 被当前 pnpm/Vitest 组合转成字面 `vitest run "--" <file>`，实际再次运行全套 | 1 | 该次结果未当作单文件证据；改用 `pnpm exec vitest run <file>`，输出确认 `Test Files 1` 后完成稳定复现与验证。 |
| Stage 7.4 首轮检索猜测不存在的 `tests/config/agent-performance-command.test.ts`，`rg` 在已有有效结果后仍以 exit 1 结束 | 1 | 调用只读且未修改文件；后续只使用 `rg --files` 或 runner 已引用的真实路径，不再猜测试文件名。 |
| Stage 7.4 对 `.artifacts` / `test-results` 做递归 `Get-ChildItem` 超时 | 1 | 调用只读且未修改文件；停止宽扫描，改为精确读取已定位的 `.artifacts/wave1/agent-performance-smoke.json` 与 baseline。 |
| 本次续接首组技能/memory 并行读取将预期无匹配的 memory `rg` 放入 fail-fast `Promise.all`，导致同组结果未回传 | 1 | 调用只读且未修改文件；改为逐项捕获并把 expected non-match 转为成功状态，确认无相关 memory 记录。 |
| 本次续接仓库状态命令把 PowerShell 换行写成字面 `` `n ``，使 `Select-Object` 把后续 `git` 解析为参数 | 1 | 调用只读且未修改文件；改用独立 RTK Git 命令，确认 HEAD、工作树和 diff boundary。 |
| Stage 7.4 candidate closure 合并 patch 使用了与当前 `Current Step` 不一致的状态上下文 | 1 | `apply_patch` 原子拒绝且未修改任何文件；读取三个文件的真实尾部后拆分为精确 patch。 |
| Stage 7.4 Standards reviewer 的只读 PowerShell inventory 把 `foreach` 输出直接接入管道，触发 ParserError | 1 | reviewer 明确确认未修改文件；不沿用该命令结果，主审以已通过的 diff/status/check 和 reviewer 最终报告为准。 |
| Stage 7.4 exact-set 首轮使用 filtered `rtk git diff --name-only`，输出混入 RTK 的 `Changes:` 摘要行 | 1 | 未使用污染结果；改用 `rtk proxy git` 取得 raw exact-set，确认 tracked 仅三份账本、untracked 仅 `plan.md`。 |
