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

**Stage 6 Part 4 - Agent Integration Mode**

**Status:** complete (`Part 3 complete at 82164ab; Part 4 verified passing in current commit`)

- Review baseline：`82164ab feat(settings): add LangSmith observability controls`。
- 当前范围：新增独立 `test:agent:integration` mode；用真实 Deep Agents harness 与 Roc SQLite 验证最小 agent execution/state contract，并把可选真实 provider case 与默认 CI 隔离。
- 不在本 part 引入：deterministic eval dataset、LLM-as-judge/live eval、agent performance gate、Stage 7 cleanup。
- 已知事实：现有 `core-plugins.integration.test.ts` 使用 static executor，不执行 Deep Agents；`buildDeepAgent()` 是 Roc guardrails 与 native harness 的单一组装入口；默认测试不能依赖 provider key 或外网。

## Phase Status

| Stage | Status | Evidence |
|---|---|---|
| Stage 0 - Characterization Gate | complete | 并发、terminal projection、restart、scheduler crash、backpressure、abort 与 Windows child-tree 均有回归证据。 |
| Stage 1 - Immutable Run Contract | complete | `4d9e8a3` |
| Stage 2 - Durable Run State, Outbox, Bounded Timeline | complete | `1fbda30` |
| Stage 3 - Durable Background Occurrences | complete | `dfbbf00` |
| Stage 4 - Execution Safety, Budgets, Cancellation | complete | `4ced164`, `031baea`, `20c235d`, `e75a754`, `7e1ed9f` |
| Stage 5 - Context, Checkpoint, HITL Conformance | complete | `b223636`, `639c019`, `873df23`, `fcc9c8c`, `9942594` |
| Stage 6 - Observability, Integration Tests, Evals | in_progress | Part 1 `e538ba9`；Part 2 `abc3220`；Part 3 backend `012c870`；Part 3 UI `82164ab`；Part 4 为当前提交。 |
| Stage 7 - Native Convergence, Patch Upgrade, Cleanup | pending | Stage 6 完成后开始。 |

## Current Acceptance

- [x] `package.json` 提供独立 `test:agent:integration` 命令，默认 `pnpm test` 不运行该 suite。
- [x] 离线 integration 实际经过 Roc `buildDeepAgent()` / Deep Agents runnable 与 Roc SQLite owner，不用 static executor 伪造 agent loop。
- [x] 默认未 opt-in 时 live provider case 显式 skipped；opt-in 后缺 `ANTHROPIC_API_KEY` 明确失败；离线 case 不因 ambient tracing/key 发起外网请求。
- [x] integration 断言结构化结果、tool/trajectory、run/thread/state 或持久 side effect，不锁死模型文案。
- [x] 失败边界可定位为 build、provider、tool、state 或 timeout；测试有明确清理，不残留进程、数据库或临时 workspace。
- [x] Standards、Spec 与 Risk review 无未处理 finding；focused、typecheck、strict unused、build、default/full test、integration command 与 diff check 通过。
- [x] Part 4 形成独立提交。

## Current Step

**Close the dedicated integration mode**

**Status:** complete (`Verified passing; committed in current commit`)

- Observable contract：离线 case 必须执行真实 Deep Agents runnable 并产生可断言的结构化 agent/native-tool 结果；live case 只有 `ROC_AGENT_INTEGRATION_LIVE=1` 且显式提供 provider 凭据时才执行。
- Isolation contract：独立 config/include 与 script；默认 Vitest、开发环境和日志不读取或输出 provider secret，不把 skip 伪装成 pass。
- Verification：config 3/3、integration 1 passed / 1 skipped、missing-key expected failure、typecheck、strict unused、IPC check、build、default Vitest 315 files / 1724 tests 与 diff check 全部完成；最终双轴/Risk review 无 residual finding。

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

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| 两个只读 PowerShell 统计命令把 `foreach` 输出直接接入管道，触发 `An empty pipe element is not allowed` | 2 | 先赋值给 `$rows` 再输出；失败命令未修改文件。 |
| 并行恢复检查中的 `git check-ignore plan.md` 以退出码 1 表示文件未忽略，导致 `Promise.all` 提前失败 | 1 | 将 expected non-match 显式转换为成功输出；确认 `plan.md` 未跟踪且未忽略。 |
| Windows `rg` 参数使用 shell glob 路径，并包含可能无匹配的查询；产生路径错误/退出码 1 | 2 | 后续禁止把 glob 放在路径参数；只使用目录参数配合 `-g`，并把无匹配与命令错误分开处理；失败命令未修改文件。 |
| `pnpm test -- tests/main/infrastructure/database-migrations.test.ts` 将 `--` 传给 Vitest并运行全部 310 个文件，而非只跑目标文件 | 1 | 红灯仍精确落在新增 V1 test；后续 focused 验证改用 `pnpm exec vitest run <path>`。 |
| 首次生产修复把 telemetry `snapshotVersion` 写成数据库原始版本，V1 row 被 strict telemetry schema 判为 corrupt | 1 | 查明 telemetry contract 固定为 normalized V2；恢复常量 2，仅扩大 migration 的 V1/V2 row 选择。 |
| 并行读取 skill 与 memory 时，预期的 memory 无匹配退出码 1 使整组 `Promise.all` 提前失败 | 1 | 改用 `Promise.allSettled` 并将预期无匹配显式转换为成功；确认无相关 memory 证据。 |
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
