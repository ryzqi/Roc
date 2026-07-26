# Roc Agent Harness 进度

> 职责：记录已完成里程碑、提交和验证结果。当前待办见 `task_plan.md`，技术结论见 `findings.md`，长期规格见 `plan.md`。

## Current State

- Branch：`main`。
- Part 5 review baseline：`da0eb8d test(agent): add dedicated integration mode`。
- Stage 0-5：完成并提交。
- Stage 6：Part 1-5 已完成并分别提交；Part 5 位于当前 commit。
- Stage 7：pending。
- `plan.md` 当前未跟踪，作为 Stage 0-7 长期规格源；Part 5 提交明确排除该文件。

## Completed Milestones

| Stage | Result | Commit(s) |
|---|---|---|
| Stage 0 | 核心故障 characterization；后续 stress/cancellation 缺口由 Stage 2/4 回归补齐。 | `ae0c95b`, `4543408`, `2b28ef1`, `9845543` |
| Stage 1 | Immutable run manifest/snapshot、持久 audit、trusted origin、explicit skill contract。 | `4d9e8a3` |
| Stage 2 | Durable run CAS、terminal transaction、outbox projector、bounded queue/timeline。 | `1fbda30` |
| Stage 3 | Durable background occurrences、crash/restart reconcile、projector ordering。 | `dfbbf00` |
| Stage 4.1 | Main/subagent manifest safety 与 tool scope。 | `4ced164` |
| Stage 4.2 | Native model/tool call budgets 与结构化 budget failure。 | `031baea` |
| Stage 4.3 | Host shell pre-authorization、cwd/env/output/abort 边界。 | `20c235d` |
| Stage 4.4 | Web/hook scope、deadline、abort、provenance、Windows child-tree。 | `e75a754` |
| Stage 4.5 | Effect state、execution path、restart reconcile。 | `7e1ed9f` |
| Stage 5.1 | Context hard budget、reducer compaction、scoped artifact recovery。 | `b223636` |
| Stage 5.2 | Main/subagent context pipeline 收敛与 native A/B。 | `639c019` |
| Stage 5.3A | SQLite saver 对齐 upstream contract。 | `873df23` |
| Stage 5.3B | Interrupt collection、resume audit、checkpoint restart recovery。 | `a810b8f`, `24db71d`, `1e79a9e`, `fcc9c8c` |
| Stage 5.3C | Recovery-safe retention 覆盖 events、outbox、artifacts、checkpoint/writes。 | `9942594` |
| Stage 6.1 | Model usage 按 call 合并，跨 main/summary/subagent/retry/cache 累加。 | `e538ba9` |
| Stage 6.2 | Durable per-run telemetry、runtime lifecycle、migration/retention/health 与 metrics cardinality。 | `abc3220` |
| Stage 6.3 | 默认关闭的 LangSmith native tracing、durable lifecycle 与独立可观测性 settings UI。 | `012c870`、`82164ab` |
| Stage 6.4 | 独立 agent integration mode、真实 Deep Agents/Roc SQLite offline trajectory 与可选 Anthropic live boundary。 | `da0eb8d` |

## Verification Ledger

| Date | Scope | Result |
|---|---|---|
| 2026-07-23 | Stage 5.1 | Focused 11 files / 95 tests；typecheck、strict unused、IPC check、build、full Vitest 302 files / 1631 tests、diff check 通过；独立 review 无未处理 Critical/High/Medium。 |
| 2026-07-23 | Stage 5.2 | Focused 6 files / 26 tests、真实 Deep Agents route、typecheck、strict unused、IPC check、build、full Vitest 304 files / 1634 tests、diff check 通过；双轴 review 闭环。 |
| 2026-07-23 | Stage 5.3A | Focused 3 files / 11 tests、typecheck、strict unused、diff check 通过；双轴 review 闭环。 |
| 2026-07-25 | Stage 5.3B | Focused、strict unused、IPC check、build、full Vitest、diff check 通过；Standards/Spec 最终复核无 residual finding。 |
| 2026-07-25 | Stage 5.3C | Focused 4 files / 14 tests、strict unused、typecheck、IPC check、build、full Vitest 308 files / 1658 tests、diff check 通过；双轴 review 闭环。 |
| 2026-07-25 | Stage 6.1 | Focused 3 files / 26 tests、strict unused、typecheck、IPC check、build、full Vitest 309 files / 1662 tests、diff check 通过；最终 review 无 residual finding。 |

Windows full Vitest 偶发输出 node-pty `AttachConsole failed`；上述运行退出码均为 0。若以后变成非零退出，再单独定位环境边界。

## 2026-07-26 - Stage 6 Part 2 Durable Per-run Telemetry

### Review Resume

- Review baseline：`e538ba9`；HEAD 未变化，当前审查对象为其上的未提交工作树。
- V1/V2 migration focused gate 已记录通过；本轮先完成 Standards、Spec、Risk review，再运行 broad gates。
- `plan.md` 继续作为未跟踪长期规格源；本轮提交边界暂不包含该文件。
- Standards review：1 个 Medium 硬性合同问题、1 个 Low judgement-call smell；Low helper 抽取不采纳，避免为一次使用扩大 API。
- Spec review：1 个 High；session telemetry read 未校验完整 frozen identity，和当前验收冲突。
- Risk review：High identity fail-open 与 Medium nullable terminal contract 有效；其余迁移、删除、retention、health、metrics、cancel/interrupt 顺序暂未发现新增确定问题。
- Identity red：`session-repository.test.ts` 1 file / 28 tests，27 passed、1 failed；篡改 frozen correlation 后读取未失败。
- Review fixes：session read 加载 run/snapshot 并校验完整 identity；公开 interrupt terminal API 改为非空 telemetry，null 只留给私有 invalid-snapshot quarantine。
- Review-fix green：`session-repository.test.ts` 28/28、`pnpm typecheck`、`git diff --check` 通过。
- Final Standards/Spec/Risk 复审均无 residual finding。
- Review closure focused gate：15 files / 113 tests passed。

### Contract And Red Tests

- 固定范围：versioned、redacted per-run telemetry；repository round-trip；runtime lifecycle；schema/rebuild/retention；metrics cardinality。LangSmith、integration/eval、agent performance gate 延后。
- 首轮红灯证明：repository/table 不存在；`MetricsService` 接受四类高基数 label；cancel/interrupt/terminal telemetry 时序不满足 durable contract。
- 新增 strict telemetry schema、repository、accumulator、v12 table、metrics label 拒绝和 focused regressions。

### Review Closure Work

- Standards/Risk review 发现 corrupt telemetry 被覆盖、history deletion FK、schema health probe、cancel final usage、interrupt transaction、startup interrupted telemetry、missing row、recovery count、frozen identity 和 clock/retry 边界。
- DB 复核纠正错误方向：canonical v11 通过 migration 升级；legacy rebuild 不扩展为 hybrid source。已删除无效 compatibility path，保留已发布 migration checksum。
- Runtime 修复后，terminal/cancel/interrupt/restart telemetry 均使用明确 owner、事务和失败语义；missing/corrupt row fail closed。

### Last Recorded Verification

- Runtime durability red set：初始 3 files / 47 tests 为 43 passed、4 failed；修复后全绿。
- Boundary regressions：interrupt transaction rollback、restart missing row、corrupt terminal row、cancel retry 全绿。
- Runtime focused：4 files / 58 tests 与 `pnpm typecheck` 通过。
- Part 2 focused gate：25 files / 173 tests 通过，覆盖 telemetry repository、runtime/executor、interrupt/recovery/cancel、metrics、schema/migration/rebuild/retention/health/kernel、outbox history。
- 状态仍为 **Changed, partially verified**：focused gate 后发现 v12 只 backfill V2 snapshot。

### Remaining

- 复核提交边界并明确排除未跟踪的 `plan.md`。
- 独立提交 Stage 6 Part 2，记录 commit SHA 后拆分下一 part。

## 2026-07-26 - Planning Docs Cleanup

- 将 `plan.md` 固定为长期规格，`task_plan.md` 固定为活动计划，`findings.md` 固定为技术事实，`progress.md` 固定为里程碑和验证账本。
- 删除已闭环 WIP、逐命令流水、重复 review 过程和过期 Stage 5 blocker；保留 commit evidence、最后验证、当前 High blocker 和 deferred scope。
- 修正 `plan.md` 的过期实施状态和产品 Gate：interactive shell 不审批但明确为 host execution；background shell 仅使用冻结预授权；scheduler misfire 使用 latest-only coalesce。
- 未修改生产代码或测试代码。
- 验证：四份文档完整回读；引用文件全部存在；21 个里程碑 commit 可解析；过期状态扫描无冲突；四文件均为 LF、UTF-8 without BOM；尾随空白扫描与全工作树 `git diff --check` 通过。
- 状态：**Verified passing**。未运行代码测试，因为本轮只修改 Markdown。

## 2026-07-26 - Stage 6 Part 2 Resume

- 从 `task_plan.md`、`findings.md`、`progress.md`、`plan.md` 恢复上下文；`session-catchup.py` 未报告未同步内容。
- 确认 review baseline/HEAD 为 `e538ba9`，工作树仍是 Stage 6 Part 2 telemetry 改动；`.codegraph/` 可用并已用于定位 migration、V1 parser 和调用边界。
- 复现条件固定：v11 数据库包含当前 parser 支持的真实 V1 execution snapshot，升级 v12 后 telemetry row 缺失。
- 当前状态：**Located**。下一步只增加 V1 migration regression 并验证红灯，不先改生产 SQL。
- V1 regression 已加入：fixture 使用生产 manifest compiler 生成有效 hash，并先通过当前 `parseRunExecutionSnapshot`。
- 红灯：migration 后 `AgentRunTelemetryRepository.get(runId)` 收到 `null`；expected 为 `snapshotVersion: 1` 的 telemetry。失败位置 `database-migrations.test.ts:265`。
- 误触发的 full Vitest 结果：309 files / 1678 tests 通过，新增 V1 test 单独失败；退出码 1。伴随既有 Windows node-pty `AttachConsole failed` 输出。
- 首次 green 尝试将 telemetry `snapshotVersion` 写成原始 row 版本，focused 1 file / 11 tests 中 V1 case 以 `agent_run_telemetry_corrupt` 失败。
- Contract 复核确认 telemetry schema 固定接受 normalized V2；修复收敛为 `WHERE snapshot_version IN (1, 2)`，telemetry `snapshotVersion` 保持 2。
- V1 migration green：`pnpm exec vitest run tests/main/infrastructure/database-migrations.test.ts`，1 file / 11 tests passed，退出码 0。
- Part 2 direct focused gate：15 files / 112 tests passed，覆盖全部本 Part 修改的自动测试文件和新增 telemetry repository test。
- Review identity red：`session-repository.test.ts` 1 file / 28 tests，27 passed、1 failed；篡改 frozen correlation 后读取未失败。
- Review fix：session telemetry read 校验完整 frozen identity；公开 interrupt terminal API 要求非空 telemetry，`null` 仅保留给私有 invalid-snapshot quarantine。
- Review green：`session-repository.test.ts` 28/28 passed；最终 Standards、Spec、Risk 复审均无 residual finding。
- Final focused gate：15 directly affected files / 113 tests passed。
- Broad gate：strict unused、IPC check、full Vitest 310 files / 1680 tests、build（含 typecheck）与 `git diff --check e538ba9` 全部通过。
- Full Vitest 仍输出既有 Windows `node-pty AttachConsole failed`，但退出码为 0。
- 当前状态：**Verified passing**，待独立提交。

## 2026-07-26 - Stage 6 Part 2 Commit Resume

- `session-catchup.py` 检出上一会话 17 条未同步消息；与工作树、四份账本和 review 子任务结果交叉核对后，确认内容仅为已完成的最终 review 与 broad gate。
- 已把最终 review、focused 与 broad verification 结果同步到 `task_plan.md`、`findings.md`、`progress.md`；未修改长期规格 `plan.md`。
- 独立提交：`abc3220 feat(agent): persist durable per-run telemetry`；提交后工作树仅剩未跟踪的 `plan.md`。

## 2026-07-26 - Stage 6 Part 3 LangSmith Opt-in Tracing

- Review baseline：`abc3220`。
- 范围固定为默认关闭、显式 opt-in、原生 nested trace、Roc correlation metadata allowlist 与导出前 redaction；真实 provider integration、eval、agent performance gate 延后。
- 已用 CodeGraph 开始定位 `createDeepAgent`、runtime invocation、settings/secret 与 app version owner；当前状态：**Located**，root cause 与单一实现路径待本机 SDK 类型核对后冻结。
- Backend 初版已实现 strict config/secret store、原生 `LangChainTracer`、metadata allowlist/redaction、executor callback 注入和四个 plugin capabilities；focused 5 files / 61 tests、`pnpm typecheck`、`git diff --check` 曾通过，最后 Standards 修复后尚未重新验证。
- Backend Spec review：2 个 High、1 个 Medium。High 分别为 ambient env 可绕过默认关闭，以及 HITL resume / recovery retry 会让同一 Roc run 产生多个 root；Medium 为 exporter/disabled regression 覆盖不足。
- Backend Standards review确认 ambient bypass 为硬性 High；先前指出的 exporter 弱断言和 app version fallback 已修改，但当前补丁仍为 **Changed, unverified**。
- 当前关闭顺序：先补 ambient 与 multi-invocation 红测，再修复 tracing lifecycle，完成 backend 双轴复审与 focused gate 后提交；随后进入 IPC/preload/renderer 部分。
- Backend review red gate：2 files / 27 tests，22 passed、5 failed。四个 ambient env case 均收到 `['langchain_tracer']`；同 run manager case 以 `AgentLangSmithRunTracingManager is not a constructor` 失败。失败形态稳定且只覆盖 review finding。
- Backend review green：disabled AsyncLocalStorage context 压制四个 ambient env；run-scoped manager 复用 SDK root，并由 terminal lifecycle PATCH。层级 fake fetch 证明 1 root + 2 invocation children 共用 root `trace_id`。
- Latest backend focused gate：5 files / 66 tests passed；`pnpm typecheck` 与 `git diff --check` passed。状态为 **Changed, focused verified; final review pending**。
- Backend 第二轮 Spec review：1 个 High、2 个 Medium。High 为跨进程 `waiting_user` resume 会丢失进程内 root 并创建第二个 trace；Medium 为 manual root 仍发送 `extra.runtime`，以及 exporter failure test 未覆盖 root POST/PATCH 和 terminal 业务结果。
- 四种 ambient env 压制、同进程 resume/retry root 复用、hierarchy/correlation 与其余 redaction 已确认正确；未发现 scope creep。
- 当前状态：**Located**。下一步先写 restart continuity、manual root runtime redaction 与 root exporter failure 红测，再修改生产代码。
- Backend 第二轮 Standards review：共同 High 为跨进程 root identity；另有 Medium lifecycle finding，trace finish 混入 `SessionEnd` hook，cancel/shutdown 不追踪且失败不释放 Client/API key。`resolveLifecycleHooks` 的 Divergent Change 作为同一修复边界处理。
- 实现方向固定为专用 Agent DB trace-session persistence，加独立 tracing lifecycle owner；不复用用户 settings，不扩展兼容路径。
- Backend review-fix red gate：4 files；既有 15 tests passed。2 个 suite 因 trace-session repository 尚不存在而 import 失败；migration 精确缺 v13；cancel lifecycle 精确 timeout。失败形态与 review finding 一致。
- Backend review-fix green：原红集 4 files / 27 tests passed。已证明同一 root identity 跨 manager 重建、manual root POST/PATCH 无 runtime、root exporter 失败不改变业务/terminal 返回、cancel 等待 tracing cleanup、shutdown 释放，以及 v13 migration。
- Backend review closure direct gate：15 directly affected files / 115 tests passed；`pnpm typecheck` 与 `git diff --check` passed。状态为 **Changed, focused verified; final dual-axis review pending**。

## 2026-07-26 - Stage 6 Part 3 Backend Review Resume

- `session-catchup.py` 检出上一会话 13 条未同步消息；与交接摘要、当前账本和工作树核对后，确认它们描述的是 backend review-fix 后的复审启动与交接状态。
- HEAD / review baseline 仍为 `abc3220`；`plan.md` 仍未跟踪并继续排除。当前 backend diff 另含两个未跟踪实现/测试文件，不能只依赖 `git diff --stat` 判断提交边界。
- 上一轮 15 files / 115 tests、typecheck、diff check 后又修改了 cancel 与 `SessionEnd` 等待语义、trace-session identity 校验、restart fixture、history deletion regression 和 import 顺序，因此旧 gate 不能作为最终结论。
- 当前状态：**Changed, unverified since latest edits**。Standards / Spec reviewer 正在复核；下一步重跑 15-file direct gate、typecheck 与 diff check，再完成 Risk review。
- 最新 backend direct gate：15 files / 115 tests passed；`pnpm typecheck` 与 `git diff --check` 均退出码 0。
- 当前状态提升为 **Changed, focused verified; final reviews pending**；未在 Standards / Spec / Risk review 闭环前宣称 backend complete。
- 最终 Spec review：1 个 Medium，startup reconciliation 的 terminal `interrupted` run 未进入 tracing cleanup。
- 最终 Standards review：1 个 High、2 个 Medium，分别为 serialized payload redaction、session read failure cleanup、shutdown auto-batch flush。
- 当前状态回到 **Changed, review findings open**；上一条 direct gate 仍是修改前证据，不能支持后续修复完成结论。
- Final-review red gate：2 files / 27 tests，22 passed、5 failed；失败精确对应 startup session 残留、session-read cleanup、shutdown batch drain、serialized 泄露与 `interrupted` terminal rejection。
- 首次 green 并行 gate 的 typecheck 未通过：5 个错误均为测试 fixture/spy 未对齐新增 tracing shutdown 合同；状态为 **Changed, unverified**，尚无 green 结论。
- Final-review fix green：3 files / 49 tests passed，`pnpm typecheck` passed；覆盖四项 review finding 及 executor fixture 合同。
- 当前状态：**Changed, review-fix focused verified; final re-review pending**。
- Risk review 新增配置关闭 cleanup 红灯：1 file / 12 tests，11 passed、1 failed，旧 client `cleanup()` 调用数为 0。
- 配置关闭 cleanup green：2 files / 34 tests passed，`pnpm typecheck` passed；idempotent dispose 不删除 durable session，terminal cleanup 后 session 为 0。
- 最新 Standards 复审：除 `src/main/plugins/agent/index.ts` 的未使用 `AgentLangSmithConfigV1` import 外无 residual finding；4 files / 37 tests、普通 typecheck、diff check 通过，strict unused 以单个 TS6196 失败。
- 最终 Risk closure 的 Medium 已 `Located`：CodeGraph 确认 `reconcileStartupRuns()` 只扫描五类非终态 run，terminal transaction 后、tracing cleanup 前崩溃留下的终态 trace session 不会在下一次启动被发现。下一步先加稳定跨重启红测，不先改 reconciliation。
- 修复边界已冻结：trace-session repository 增加终态 session 枚举，Agent plugin initialize 合并本次 startup-interrupted 与既有 terminal sessions 后交给 tracing manager best-effort finish；waiting/recovery session 必须保留。
- Terminal crash-window red：`rtk pnpm exec vitest run tests/main/plugins/agent/plugin.test.ts`，1 file / 17 tests，16 passed、1 failed；`run_terminal_trace` 初始化后仍返回完整 session，稳定复现已终态 run 不被 startup cleanup 扫描。
- Terminal crash-window green：repository 枚举四类 terminal trace sessions，plugin 在 run reconciliation 后统一 best-effort finish；同一 `plugin.test.ts` 17/17 passed，terminal session 删除且 waiting session 保留。
- Review-fix focused gate：trace-session repository、plugin、LangSmith tracing 3 files / 32 tests passed；`pnpm typecheck` 与 strict unused 均退出码 0。当前状态：**Changed, focused verified; final reviews pending**。
- Backend final direct gate：15 directly affected files / 120 tests passed。
- 最终 Spec 复审：backend 无行为错误、无 scope creep；`plan.md` 的 UI 外发/retention 提示明确留给下一独立 part，不阻断 backend commit。
- 最终本地 Risk review：无 residual finding；仅保留非阻断风险，多个异常残留 session 串行 drain 可能拉长 critical plugin 启动。
- Standards 复审发现 Medium 测试证据缺口：startup 新分支未具体覆盖 enabled PATCH/error mapping 与 cancelled/failed 枚举；实现本身未发现错误，已补 all-terminal repository matrix 和 enabled failed PATCH assertion。
- 新测试首跑 2 files / 24 tests 为 23 passed、1 failed：spy 位于 Client anonymizer 之前，正确收到内部错误码而非最终 `[REDACTED]`；断言边界已修正，待重跑。
- Standards test-fix green：trace-session repository、plugin、LangSmith tracing 3 files / 36 tests passed；`pnpm typecheck` 与 strict unused 均退出码 0。当前状态：**Changed, test-fix focused verified; final re-review pending**。
- 最终 Standards 复审：无 residual finding，上一轮 Medium 测试证据缺口已关闭。
- 最终 Spec 复审：backend 无 residual finding；UI 数据外发/retention 提示仍属于下一独立 part。
- 最终 backend direct gate：15 files / 124 tests passed；`pnpm typecheck`、strict unused、`pnpm check:ipc` 与 `git diff --check abc3220` 全部通过。
- 当前状态：**Verified passing; backend independent commit pending**。

## 2026-07-26 - Stage 6 Part 3 UI Resume

- Backend 已独立提交为 `012c870 feat(agent): add opt-in LangSmith tracing`；提交后当前工作树仅有活动账本 `task_plan.md` 与未跟踪长期规格 `plan.md`。
- UI review baseline 切换为 `012c870`；范围固定为 shared IPC / generator / preload / renderer 独立“可观测性”section，不扩展全局 `AppSettings` 或 settings “保存全部”dirty model。
- 设计校准只采用现有 Roc settings 视觉语言、visible labels、明确 loading/error/success、键盘 focus 与响应式无溢出；拒绝与现有产品冲突的 landing、dark-only、glow、装饰卡片和外部字体建议。
- CodeGraph 已确认 `SettingsView` / `SETTINGS_SECTIONS` 是 navigation owner，`useSettingsDraft` 只管理现有全局 settings；下一步定位 capability -> shared IPC -> generated preload -> renderer client 的完整路径并先加红测。
- IPC/preload/renderer 红测：5 files / 24 tests，17 passed、7 failed；失败精确落在四条 adapter mapping、四个 schema channel、四个 preload method、可观测性 navigation 和尚不存在的 renderer panel。
- 首轮实现后 direct gate 5 files / 24 tests、typecheck 与 IPC check 通过；expanded settings gate 15 files / 60 tests、strict unused 与响应式 smoke 通过。
- Standards 与 Spec review 共同发现 1 个 Medium：持久配置关闭但本地启用草稿未保存时仍可清 key，留下 enabled/no-key 无效草稿。Local Risk review 另发现切换到独立 section 会遮蔽其他 section 的全局 dirty/save 状态。
- Review-fix 红灯：1 renderer file / 4 tests，2 passed、2 failed；分别精确命中 clear 草稿约束和全局 dirty 状态遮蔽。
- Review-fix green：2 files / 5 tests passed；direct gate 18 files / 71 tests、settings gate 15 files / 60 tests passed。
- preload 四个方法均有精确 channel/参数断言；strict unused、typecheck、IPC check 与初始 diff check passed。
- 最终 Standards / Spec 复审无 residual finding；本地 Risk / UI review 无生产逻辑 finding。
- Risk/UI review 发现响应式 smoke 的 settings header fixture 与真实 UI 不一致；fixture 已改为真实 dirty count + reset/save actions，并把 `pageActions` 纳入 overflow 断言。
- 修正后的 renderer focused 2 files / 15 tests 与 responsive smoke passed；320px、1280px 的 document/body、header actions、表单、输入和 key action 均无横向溢出或重叠。增量 Standards / Spec 复审无 finding。
- 首次 full Vitest：314 files 中 313 passed；`kernel-runtime.test.ts` 唯一失败，仍期望 Agent schema v12，而 Part 3 backend canonical migration 已为 v13。
- v13 integration red-green：focused 1 file / 2 tests 先稳定 1 failed，更新唯一显式版本锚点后 2/2 passed；增量 Standards / Spec 复审无 finding；独立补漏提交为 `77cf36a test(kernel): expect agent schema v13`。
- Broad gate：strict unused、typecheck、IPC check、build、full Vitest 314 files / 1721 tests、responsive smoke 与 `git diff --check` passed。
- Full Vitest 仍输出既有 Windows `node-pty AttachConsole failed` 子进程噪声，但主命令退出码为 0。
- 当前状态：**Verified passing; committed as `82164ab`**。

## 2026-07-26 - Stage 6 Part 4 Agent Integration Mode

- Review baseline：`82164ab feat(settings): add LangSmith observability controls`；工作树恢复后仅有未跟踪只读 `plan.md`。
- `agent-development` 合同确认：integration 应执行真实 Deep Agents/LangGraph harness 与 Roc state owner；真实 provider 是可选边界，离线 CI 仍需确定性结构证据。
- CodeGraph 已定位 `buildDeepAgent()` 为 Roc middleware/native harness 单一组装入口；现有 `core-plugins.integration.test.ts` 使用 static executor，不足以证明真实 agent loop。
- `package.json` 尚无 agent integration 命令；默认 Vitest include 会匹配 `*.int.test.ts`，因此单一路径冻结为专用目录/config/script + 默认 config 显式 exclude。
- 无 provider key 时仍运行 deterministic offline Deep Agents/Roc SQLite case；只有 live provider case 显式 skipped，避免 integration command 空绿。
- 已确认 `FakeToolCallingModel` 可驱动真实 `buildDeepAgent()` 与 `RocSqliteCheckpointer`；新 integration case 只覆盖 native `write_todos` trajectory + terminal result + checkpoint，不复制既有 summarization/subagent case或新增一次性 manifest。
- Live provider 采用显式 `ROC_AGENT_INTEGRATION_LIVE=1` opt-in；默认 skipped，opt-in 后缺 `ANTHROPIC_API_KEY` 明确失败；离线 case 还需压制 ambient LangSmith tracing。
- 当前状态：**Located**。下一步定位现有 live-provider 环境约定，并为 config/script/default exclusion 与最小 agent case先写稳定红测。
- 恢复检查确认 HEAD/工作树与交接一致，session catchup 无额外未同步实现；memory 无 Roc 相关旧记录。
- 已增加 config/script/default exclusion 合同测试与专用 integration 文件；生产 config/script 尚未修改，下一步运行红灯并记录精确失败。
- Config 合同红灯：1 file / 3 tests 全部按预期失败，分别为 script undefined、default exclude undefined、专用 config 无法加载。
- Offline harness 首跑：trajectory、terminal result、SQLite checkpoint 均已通过，唯一失败为 ambient LangSmith fetch 86 次；根因为 builder 在 disabled context 外构造，测试修正为 context 同时包住 build 与 invoke，待重跑。
- Offline harness 第二次仍为 86 次 fetch；进一步定位为 `langsmith/singletons/traceable` 冷启动使用 no-op mock，既有 executor 测试因 import 顺序已初始化而未覆盖。已增加官方 `langsmith/traceable` 初始化 import，待重跑同一回归。
- 第三次仅增加初始化 import 后仍为 86 次 fetch；pnpm 解析确认该路径统一为 LangSmith 0.8.1。扩大诊断后改用官方 `traceable(..., { tracingEnabled: false })` 传播 nested runnable config，替代 disabled 分支的手写 singleton context，待重跑。
- 官方 disabled wrapper 重跑仍为 86 次 fetch；当前假设未成立。Fetch stub 已改为在拒绝错误中包含目标 URL，下一次只用于确定实际外发 owner，不继续试改生产逻辑。
- 诊断确认唯一目标为 `https://api.smith.langchain.com/info`，是 direct `agent.invoke` nested harness 的 capability probe；没有证据表明生产 `streamEvents` 路径退化。撤回 tracing 生产试改，offline 专用进程改为显式关闭四个新旧 tracing env、清空 key 并拒绝全部 fetch。
- Offline harness green：1 deterministic case passed、1 live case skipped；真实 builder/native `write_todos`、terminal AI、Roc SQLite checkpoint 与零 fetch 均通过。
- 已增加 `test:agent:integration`、默认 `tests/integration/**` exclude 与专用 Vitest config；状态为 **Changed, unverified**，下一步重跑 config contract、专用命令、missing-key failure 和 typecheck。
- Focused 首轮：config contract 3/3 passed；专用命令 1 passed / 1 skipped；typecheck 仅因 fixture 缺必填 `contextBudgetTokens` 失败。已显式补 `undefined`，待重跑。
- Focused green：专用命令 1 passed / 1 skipped；typecheck 无错误。显式 live opt-in 且缺 key 的定向运行在 4ms 内按预期失败为 `agent_integration_anthropic_api_key_missing`，未进入 provider 构造或网络。
- 当前状态：**Changed, focused verified; Standards / Spec / Risk review pending**。
- 初次 Spec review 无 finding；Standards 仅有 1 个 Low 账本事实漂移。Local Risk review 发现 live case 未显式隔离 ambient LangSmith env/key，可能在 Anthropic 请求之外产生未声明外发。
- Review fix：offline/live 共用 tracing isolation helper；offline 先模拟四个 tracing flag 与新旧 key 已启用，再关闭并断言零 fetch；账本明确区分默认未 opt-in skipped 与 opt-in 缺 key failure。
- Review-fix focused gate：config contract 3/3 passed；专用命令 1 passed / 1 skipped；`pnpm typecheck`、strict unused 与 diff check passed。
- Live opt-in missing-key boundary 在 4ms 内按预期失败为 `agent_integration_anthropic_api_key_missing`，未进入 provider 或 network。
- 当前状态：**Changed, review fixes focused verified; final re-review and broad gate pending**。
- 最终 Standards、Spec 与本地 Risk review 均无 residual finding；上一轮账本 Low 与 live ambient tracing 外发风险已关闭。
- Broad gate：`pnpm build`（含 typecheck）、`pnpm check:ipc`、默认 `pnpm test` 315 files / 1724 tests 与 `git diff --check 82164ab` 全部通过。
- Full Vitest 仍输出既有 Windows `node-pty AttachConsole failed` 子进程噪声，但主命令退出码为 0。
- 真实 Anthropic live turn 因未提供凭据未运行；默认 skipped 与 opt-in missing-key expected failure 已直接验证。
- 当前状态：**Verified passing; committed in current commit**。

## 2026-07-27 - Stage 6 Part 5 Deterministic Agent Eval Mode

- Part 4 已独立提交为 `da0eb8d test(agent): add dedicated integration mode`；提交后工作树仅剩未跟踪只读 `plan.md`。
- Part 5 baseline 固定为 `da0eb8d`；范围为本地 deterministic runner、专用 config、strict versioned dataset 与两个真实 harness scenario，不含 live/judge/performance 或生产 runtime 改动。
- CodeGraph 与本地测试确认 `buildDeepAgent()`、`RocSqliteCheckpointer`、`FakeToolCallingModel`、Plan Mode runtime guard 和 Part 4 offline isolation 可形成单一 test-only 路径。
- Observable contract：分别评分 terminal outcome、critical tool trajectory 与持久 state/side effect；初始 case 为 `write_todos` success 和 Plan Mode `write_file` denial。
- 当前状态：**Located**。下一步增加 CLI/config/dataset/scenario red tests，不先实现 runner 或 config。
- Config/CLI red：2 files / 8 tests 为既有 integration 3 passed、eval 5 expected failures；script、default exclude、dedicated config 与两个 fail-closed mode error 均有精确失败证据。
- Scenario red：`deterministic-trajectory.eval.test.ts` 在 0 case 执行前以 `ENOENT` 精确失败于缺失 versioned dataset。
- 当前状态：**Changed, red tests verified**。下一步实现 runner/config/dataset，再观察真实 Plan Mode trajectory，不修改生产 guard。
- 首次实际 runner 执行在启动 Vitest 前失败为 `agent_eval_unknown_arg:--`；原因是 pnpm 保留计划命令中的 separator。含 separator 的两个 CLI 红测稳定复现后，parser 只剥离一个前导 `--`。
- 首次 scenario green 为 2 cases 中 Plan Mode denial 通过、native `write_todos` 因 success `ToolMessage.status` 省略而失败；固定 SDK 类型/实现确认 optional contract 后，eval adapter 显式规范化 undefined success，未改 dataset 或生产 harness。
- Runner 改为当前 Node 直接启动已安装 Vitest bin，移除 Windows shell 拼接与 `DEP0190` warning。
- Focused green：`pnpm eval:agent -- --mode deterministic` 1 file / 5 tests；config/CLI 2 files / 8 tests；Part 4 integration 1 passed / 1 skipped；typecheck 与 strict unused passed。
- Runner 收敛后的新鲜 focused gate：eval 1 file / 5 tests、config/CLI 2 files / 8 tests、Part 4 integration 1 passed / 1 skipped、typecheck、strict unused 与 `git diff --check da0eb8d --` 全部通过。
- 最终 Spec review 无 finding；Standards 仅发现 `progress.md` 顶部 HEAD/阶段状态过期，已同步修正；本地 Risk review 对 cwd、CLI、dataset、tracing/network、checkpoint 与 side effect 边界未发现新增 finding。
- Broad 首轮：`pnpm check:ipc`、`pnpm build` 与 diff check 通过；与 build 并行的默认 full Vitest 为 314 files passed、2 files timeout failed，失败位于未改动的 NVIDIA schema compatibility 与 production multiple-interrupt tests。
- 两个 timeout 文件独占重跑分别为 1/1 与 3/3 passed；随后默认 full Vitest 独占重跑为 316 files / 1729 tests passed，确认首轮失败是并行资源竞争下的 timeout。
- Full Vitest 仍输出仓库已记录的 Windows `node-pty AttachConsole failed` 子进程噪声，但主命令退出码为 0。
- Broad gate 最终证据：`pnpm check:ipc`、`pnpm build`（含 typecheck）、默认 `pnpm test`、strict unused 与 `git diff --check da0eb8d --` 全部通过。
- 当前状态：**Verified passing; included in the current Part 5 commit**。
