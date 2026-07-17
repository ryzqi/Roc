# Roc Agent Harness 进度

## 2026-07-15 — Stage 0

- **Status:** in_progress
- 已读取：`plan.md`、项目 `AGENTS.md`、RTK 规则、项目脚本、CodeGraph 初始结果。
- 已确认：当前只开始 Stage 0，尚未修改生产代码。
- 已确认：`plan.md` 是用户提供的未跟踪文件；不将其内容改写为代理账本。
- 已定位 Stage 0 初始调用链：同 thread 无 lease、subscriber failure 透传、scheduler start/link 非原子。
- 已定位测试资产及计划路径漂移；下一步复用 runtime executor fixture 新建同-thread 并发 characterization。
- Step 1 已完成：`runtime-thread-concurrency.test.ts` 通过；`pnpm typecheck`、`git diff --check` 通过；双轴 review 无问题。
- Step 2 已完成：`runtime-terminal-projection.test.ts` 通过；standards review 无问题；spec review 发现 `plan.md` 的旧故障前提已不成立，已用当前行为回归测试和账本说明处理。
- Step 3 已完成架构定位：将用真实 LangGraph/Deep Agents deterministic interrupt fixture 覆盖重建 saver 后的 `Command(resume)`；不使用 provider 或外网。
- Step 3 已实现：`runtime-checkpoint-restart.integration.test.ts` 通过 2 项，覆盖 approval 和 `ask_user` 的 durable restart/resume。
- Step 3 已完成 review/fix：临时文件 DB close/reopen 证明跨连接恢复；approval 使用真实 `createDeepAgent` HITL；focused test、typecheck、diff check 通过。
- Step 4 已定位：现行 scheduler 仅有 timer dispatch 顺序，没有可持久化 crash point；先以顺序 characterization 锁定，durable crash/reconcile 留给 Stage 3 的 occurrence 实现。
- Step 4a 已完成：`scheduler-crash-consistency.test.ts` 通过；typecheck/diff check 通过；review 无标准问题，spec 标为顺序基线而非完整 crash fixture。
- Step 5 已定位：queue/event log 缺 high-water 与 row cap 可观测性；吞吐基线可做，但完整计划指标需后续 instrumentation。
- Step 6 已定位：runtime 的 abort signal 传入 Deep Agent stream，但 `run_shell_command` tool/`ShellExecutionService`/hook runner 没有接收入口；web 只有自身 timeout controller。完整取消与 Windows child-tree fixture留待 Stage 4 合同落地后补齐。
- Stage 1 已进入实施：manifest compiler/preview 已完成 WIP；新的 smoke 失败定位为 `AgentSessionRepository` 未原子持久化 capability manifest。接下来先加 snapshot schema/migration/repository red-green 测试，再让 executor 只消费冻结 snapshot。
- 会话恢复：已重读 `task_plan.md`、`findings.md`、`progress.md`、`plan.md`、`AGENTS.md` 和 package scripts；session catchup 无未同步结果。CodeGraph 显示当前 WIP 已在 `AgentSessionRepository.createTaskRun()` 事务内插入 `context_manifest`。smoke 失败锚点仍为 `No context_manifest event found after chat submit`，后续定位事件读取/投影链。
- 已完整复核 `plan.md`：本轮边界固定为 Stage 1，不进入 Stage 2；Stage 1 必须通过 snapshot-only executor rebuild 与单一 manifest hash 证明。
- CodeGraph 复核：`startRun -> executeRun -> executeDeepAgentRun -> executor.execute` 传递持久化 snapshot；`createTaskRun()` 事务内校验 manifest hash 并写 `context_manifest`。下一步只追 smoke 消费链和残留授权重算。
- 误用 `rtk pnpm test -- <path>` 实际跑了全套，不能作为 focused 结论。结果：286 files 通过、6 files / 10 tests 失败。回归包括 agent schema 版本 3 与旧断言 2、workspace capability dependency 未声明、hook fixtures 的裸 workspace path 被来源合同拒绝；另有 `node-pty` `AttachConsole failed` teardown 噪音。后续使用 `rtk pnpm exec vitest run <path>`。
- 回归根因：agent plugin 无条件创建 workspace capability provider，却仅在某些 executor options 下声明 workspace plugin dependency；runtime hooks fixture 应标明其 workspace 为 `workbench` 来源。计划修复这两点和 schema-version 断言，不降低 workspace 来源约束。
- smoke 诊断：current source 的 user message 与 `context_manifest` 同事务写入，task snapshot 直读同一 `agent_events`。已找到 user 而找不到后写 manifest 与 current source 矛盾；先查 smoke 是否使用旧构建目标。
- 已确认 smoke target 可能是旧 `release\\win-unpacked\\Roc.exe` 或旧 `dist`，而 smoke assertion 来自当前 source。等待 Stage 1 source build 后，以 `ROC_SMOKE_TARGET=dist` 重跑；不修改 repository 做补写。
- **Changed, unverified：** `createAgentPlugin()` 现始终声明 `@roc/plugin-workspace`，与无条件 `workspace.getCurrent` capability 调用一致；更新 manifest contract test。`runtime-hooks` fixture 显式标为 `taskSource: 'workbench'`；database fast probe/health schema 断言由 agent 2 更新至 3。
- Focused regression：`plugin.test.ts`、`runtime-hooks.test.ts`、`core-plugins.integration.test.ts`、database fast probe/health 均通过；`kernel-runtime.test.ts` 仍失败，原因是 test plugin 写死 agent schema 2。待定点更新该 test contract 后重跑。
- **Changed, unverified：** `kernel-runtime.test.ts` 的 agent schema assertion 已从 2 更新为 3；准备重跑同一组 Stage 1 focused tests。
- **Verified passing：** Stage 1 回归组 `plugin.test.ts`、`runtime-hooks.test.ts`、`core-plugins.integration.test.ts`、`kernel-runtime.test.ts`、`database-fast-probe.test.ts`、`database-health.test.ts` 共 6 files / 27 tests 通过。
- 已确认 `release\\win-unpacked\\Roc.exe` 与 `dist\\main\\index.js` 同时存在、`ROC_SMOKE_TARGET` 未设置；此前 Electron smoke 默认选择 packaged target。Stage 1 build 后必须强制 `ROC_SMOKE_TARGET=dist`。
- `ROC_SMOKE_TARGET=dist pnpm smoke:electron`：已证明 `context_manifest` 出现在 task snapshot，原 manifest smoke failure 已修复。当前失败改为 composer Enter 未提交，chat input 保留文本且 transcript 为空；这是独立 renderer submit 回归，正在定点定位。
- Composer source 已确认包含 Enter submit handler；当前测试未覆盖实际 `ChatComposer` 的多行 Enter 路径。下一步读取 smoke `sendDisabled` 证据及 artifact，再作最小修复。
- Composer 直接委派 `ChatView.submitCurrentInput`；smoke 预检查会确认 send button 未 disabled，但 failure debug 没有输出该 evidence。继续检查上层 submit guard 与焦点，不假设 keyboard handler 缺失。
- `submitCurrentInput` success path 会立即清空 input；本次未清空，说明最终 Enter 没触发 textarea handler。未找到本轮 smoke artifact，先为 smoke timeout debug 加入 active element/pre-submit evidence，再复现；不动 production。
- **Changed, unverified：** smoke chat timeout debug 现输出 `chatInputEvidence` 与 `activeElementTestId`，只为区分 focus 丢失和 renderer key handler 回归；准备复现 dist Electron smoke。
- **Changed, unverified：** diagnostic 已改为将 `chatInputEvidence` 显式传入 `page.evaluate`；上一轮 failure 只来自诊断代码作用域，不代表产品行为。
- Reproduction evidence：final key 前 active element 是 `chat-input` 且 send button enabled，输入仍未清空；定位为 smoke 使用的全局 Playwright keyboard path 不可靠，不是 manifest/repository 或 submit guard。改用 locator-targeted Enter 后重跑。
- Locator-targeted Enter 同样无法提交，排除 keyboard focus 假设。输入未清空且 snapshot 无 typed prompt event；转查 `onSubmitChatTask` 的 IPC/main error，不继续修改 keyboard path。
- **Located：** 普通 chat request 带 `taskSource: null` 和 `workspacePath: currentWorkspacePath`，被 Stage 1 workspace source contract 拒绝。将删除该 request field，让 main `workspaceProvider` 成为唯一 workspace 来源；保留 workbench task 的显式 workspace path 路径。
- 普通 chat/plan-chat 的 `app-shell.test.tsx` contract 也固定了该非法 payload；会与 production request 同步更新，workbench task request 不动。
- **Changed, unverified：** 普通 chat 已移除 renderer `workspacePath` 传递与对应 hook/AppShell dead path；`app-shell.test.tsx` 现断言该字段缺失。workbench task 的显式 path 及 source 保持原状。
- **Verified passing：** `tests/renderer/app-shell.test.tsx` 15 tests 通过。已删除 task-only smoke focus diagnostics，并恢复原始 global Enter action；下一步 rebuild 后重跑 `ROC_SMOKE_TARGET=dist` Electron smoke。
- **Verified passing：** 修复后 `pnpm build` 通过。以 rebuilt `dist` 运行原始 Enter smoke，验证普通 chat 不再被 workspace source contract 拒绝。
- `ROC_SMOKE_TARGET=dist pnpm smoke:electron` 已通过 chat submit 与 `context_manifest`；下一失败为缺 `agent_update` provider event。该事件是 Stage 1 run creation timeline contract，开始定位生产写入路径，不降低 smoke assertion。
- 已确认 `agent_update` 旧路径是 Task plugin 订阅 `agent.run.started` 后写 agent DB，晚于 run transaction。Stage 1 正确方向是同事务写 canonical start/provider event，并移除会重复写入的 projector path；正在检查 payload 与 tests。
- **Located：** Task projector 在 run 已存在时早退，故不写 `agent_update`；Stage 1 repository 创建 run 后必然触发该分支。将把 running/provider/model event 原子写入 repository，并以 repository test 覆盖。
- Legacy start payload 仅为 `agent_update: { status: 'running' }`；按既有 consumer contract 原子恢复该形状，不扩大 payload。先将 session repository test 的初始 event sequence 改为预期四项，形成 red case。
- **Changed, unverified：** `session-repository.test.ts` 已要求 `createTaskRun()` 原子写入 `agent_update: { status: 'running' }`；当前 source 尚未实现，准备 red run。
- **Red confirmed：** `session-repository.test.ts` 10 tests 中目标 test 失败，initial event count 为 3 而非 4。下一步在 `createTaskRun()` transaction 写 canonical running event。
- **Changed, unverified：** `AgentSessionRepository.createTaskRun()` 已在 snapshot/user message/context manifest 的同一事务写入 `agent_update: { status: 'running' }`；准备 green test 与 task plugin compatibility tests。
- **Verified passing：** red test 已转绿；`session-repository.test.ts`、`runtime.test.ts`、Task plugin run-state/plugin compatibility 共 4 files / 32 tests 通过。准备 rebuild 与 dist Electron smoke。
- 最新 rebuilt dist smoke 已通过 chat submit、manifest、canonical start event 和大部分全链路检查；失败仅为 start `agent_update` 缺 provider/model identity，以及独立的 task creation audit event 缺失。先扩展 snapshot-derived start payload 的 repository test。
- 最新 dist smoke 完整运行后仅余 `taskProviderUpdateStored` 与 `naturalLanguageTaskCreated` 两项失败；先定位 writer 和 smoke predicate，暂不修改。
- 已确认 `background_task_created` writer 存在但 payload 缺 `goal`，与 smoke predicate 不一致；provider check 需要 terminal rather than start update。先为 task-created goal 添加 red test，completed projector 后续独立定位。
- 细化：provider check 必须 terminal `finishReason:'stop'`，start event 不能替代；created task check 只需在 audit payload 加 `goal`。开始 task repository red-green，terminal projector 待此修复后单独检查。
- **Changed, unverified：** task repository test 现要求 `background_task_created` audit payload 含 taskId、goal、status；准备 red run。
- **Red confirmed：** `background_task_created` payload 缺 `goal`，目标 task repository test 失败。下一步在现有 event writer 补该 task identity。
- **Changed, unverified：** `createBackgroundTask()` 已在现有 `background_task_created` writer 补 `goal`；准备 task focused tests。
- **Verified passing：** `task-repository.test.ts`、task plugin/run-state compatibility 共 3 files / 22 tests 通过。剩余 provider smoke failure 仅指向 terminal `agent_update`，开始定位 completed projector。
- **Changed, unverified：** session repository test 现要求 start `agent_update` 同时包含 snapshot-derived `providerId` 与 `modelId`；准备 red run。
- **Red confirmed：** start event 只有 `{ status: 'running' }`，缺 snapshot-derived provider/model。下一步只从 `snapshot.model` 补全 payload。
- Task plan 状态补丁因错误表行文本漂移未命中，未改文件；待读取尾部后精确追加。
- **Changed, unverified：** start `agent_update` 现从 immutable `snapshot.model` 写入 `providerId`、`modelId`；准备 green/compatibility tests。
- **Verified passing：** provider/model red test 已转绿；repository/runtime/task plugin compatibility 4 files / 32 tests 通过。下一步定位已创建 background task 却缺 `background_task_created` agent event 的链路。
- **Verified passing：** Stage 1 changed-test suite 共 15 files / 102 tests 通过，覆盖 schema migration、snapshot repository、manifest/preview、executor、runtime、plugin dependency 与健康探针。下一步：`pnpm check:ipc`、typecheck、build，然后 `ROC_SMOKE_TARGET=dist` Electron smoke。
- **Verified passing：** `pnpm check:ipc` 报 generated files current；`pnpm typecheck` 报 `TypeScript: No errors found`。开始 build，以生成与 Stage 1 source 匹配的 Electron smoke target。
- **Verified passing：** `pnpm build` 通过，已生成新的 `dist/main/index.js`、preload 与 renderer。接下来执行 `ROC_SMOKE_TARGET=dist pnpm smoke:electron`，验证当前 Stage 1 source 而非旧 packaged target。
- **2026-07-16 会话恢复：** Stage 1 仍在收尾。前序记录已通过 focused runtime/task tests、build 和 dist Electron smoke；随后修复显式 `/skill` 的 snapshot 冻结合同，focused suite 为 8 files / 63 tests 通过。此前启动的 `pnpm typecheck` 未留下可确认的终态，下一步先检查进程并重新取得该命令的明确结果，再进行 Stage 1 全量 focused 验证、IPC/diff 检查、build/smoke、review 和独立提交。
- **Verified passing：** 本会话重新执行 `rtk pnpm typecheck`，结果 `TypeScript: No errors found`。所有本次变更涉及的 Vitest 文件共 22 files / 137 tests 通过。下一步执行 `pnpm check:ipc`，然后 build 与明确 `ROC_SMOKE_TARGET=dist` 的 Electron smoke。
- **Verified passing：** `pnpm check:ipc` 确认 IPC 生成文件无漂移；fresh `pnpm build` 通过；`ROC_SMOKE_TARGET=dist pnpm smoke:electron` 通过，验证目标为当前重建的 dist。开始 Stage 1 diff review，之后只会修复 review 发现项并独立提交；不进入 Stage 2。
- **Review scope：** `plan.md` 的 Stage 1 是本轮规格来源。由于本 stage 是当前未提交工作树，review 基线固定为 `HEAD`，检查 `git diff HEAD`；不将 `main` 的既有提交重新纳入审查。
- **Review preflight：** `HEAD` resolves to `9845543a65551076763769e5c998c3fbf523460e` and the Stage 1 worktree diff is non-empty. 已读取 Stage 1 规格、当前 `AGENTS.md` 与 package scripts；`git diff --check HEAD` 通过。`AGENTS.md` 已包含本次非显而易见的 IPC、构建和 Electron smoke 验证规则，当前没有可复用的新项目规则，故不改该文件。
- **Verified passing：** strict unused scan 通过；全量 `pnpm test` 为 292 files / 1522 tests 通过。退出码为 0 后出现四次 node-pty `AttachConsole failed`，为已知 Windows teardown 噪音；不把它当作本次变更失败。等待独立 standards/spec review，然后处理发现项或提交。
- **Review found：** 双轴 review 一致确认 run-origin provenance 与 explicit `/skill` audit-card 两项 Stage 1 缺口。将先增加 red regression，再做最小修复；Stage 2 的 outbox/subagent safety 项仅记录为后续工作，不提前实现。
- **Changed, narrowly verified：** review red suite 3 files / 22 tests 先以 6 项失败证明 provenance/audit-card 缺口，后通过新增 `background_schedule` trusted source、workflow hint source gate、snapshot rehydration preservation 和完整 manifest skill cards 转绿。red run 的 accepted workflow request 触发 DB teardown unhandled rejection；修复后同一 focused run 无该错误。完整 Stage 1 verification 需要重跑。
- **Verified passing：** Stage 1 focused 集合重跑为 23 files / 144 tests 通过。期间两个旧 fixture 按旧来源合同失败，已只更新 fixture input 后同一集合转绿。继续执行 post-review strict scan、全量 tests、IPC、build、dist Electron smoke 与最终 diff review。
- **Verified passing：** post-review strict unused scan、`pnpm check:ipc`、fresh `pnpm build`、`ROC_SMOKE_TARGET=dist pnpm smoke:electron` 与全量 `pnpm test` 均通过；full suite 为 292 files / 1524 tests。仅余最终 diff review、计划状态更新及 Stage 1 独立提交。
- **Review complete：** final CodeGraph call-path review 与 `git diff --check HEAD` 未发现新问题。Stage 1 implementation、review、fix 与 verification 已完成；准备提交 tracked implementation/tests 与 execution ledger，明确排除用户提供的 untracked `plan.md`。
- **Stage 1 complete：** 已以 `feat(agent): freeze immutable run execution contract` 独立提交。提交包含实现、测试和 execution ledger；用户提供的 `plan.md` 仍保持 untracked 且未纳入。未进入 Stage 2。

## 2026-07-17 — Resume

- **Status:** in_progress
- 已恢复读取执行账本：Stage 1 已完成；Stage 0 的 Step 4b/5/6 仍由 Stage 3/2/4 的生产合同阻塞。用户要求继续；下一步读取 Stage 2 规格、session catchup 与当前工作树，先定义 Stage 2 的最小可验证实现边界。
- **Stage 2 started:** 已读取 `plan.md` Stage 2。范围固定为 durable run state、outbox、bounded timeline；先完成 repository/runtime/task projector 当前调用链与测试资产定位，再建立 state-machine red tests。Stage 3/4 和产品 Gate 不在本阶段实施。
- **Native contract preflight:** 使用 agent-development 读取 Deep Agents/LangGraph persistence 指引；Stage 2 先固定 durable state、recovery、side-effect owner 与 failure boundary，再选择 Roc 侧最小实现。
- **Located:** terminal path 与 task projection 当前均为分步写入/EventBus subscriber；event sequence 仍为 `MAX+1`。下一步读取 agent/task schema、repository tests 和 event log tests，定义第一批 repository CAS/outbox red cases。
- **Located:** agent migration 当前止于 v3，缺 outbox/cursor；event-log 单测仅有顺序 replay。测试发现路径实际为 `plugin-run-states.test.ts`，旧名不可用，已记录。下一步读取 session repository 与 task plugin state tests，定义 Stage 2 first-slice contract。
- **Located:** 无现成 CAS/terminal transaction repository test；migration test 锁 v3。Stage 2 first slice：agent v4 schema + repository transition API red tests；不先接 task projector 或 queue，避免跨越 migration sequence。
- **Located:** task workbench history已直接读取 agent DB，EventBus task-event subscriber 是 no-op。outbox projector范围收窄为跨 DB task side effect；第一切片维持此 owner 边界。下一步定义状态图、CAS error contract 与 v4 schema，然后先写 red tests。
- **Red confirmed:** `database-migrations.test.ts` 与 `session-repository.test.ts` 的 Stage 2 contract 共 3 项失败：v4 migration 不存在、repository 没有 `transitionRun()`、同 thread 可创建第二 active run。下一步只实现 v4 partial unique lease、CAS transition API 与 conflict mapping；runtime/outbox 暂不切换。
- **Changed, failed verification:** CAS/lease 实现后 focused suite 报 `agent_run_leases` 不存在，且 migration test 仍只看到 v3。原因待定位；不继续修改 runtime/outbox，先修正 agent migration chain。
- **Verified passing:** v4 migration placement 已修正；`session-repository.test.ts` 与 `database-migrations.test.ts` 共 19 tests 通过。完成 lease/CAS first slice，继续处理受影响的 runtime concurrency contract、database rebuild/schema-version tests 与 typecheck。
- **Changed, unverified：** `runtime-thread-concurrency.test.ts` 已从“双 executor 可并发”改为 second `startRun()` 返回 `thread_run_conflict`，并保留首 run `waiting_next_turn` 与单 executor 断言；接下来运行该回归及 agent schema 受影响基础设施测试。
- **Changed, unverified：** impacted run 首次验证发现一个残留变量名与两项 v3 schema 断言；已将 `hasActiveThread` 改为 `hasExistingThread`，并将 database fast-probe/health 的 agent schema expectation 更新为 v4，准备原命令重跑。
- **Verified passing：** runtime concurrency 与 agent schema impacted suite 为 4 files / 7 tests，通过 second `startRun()` 的 `thread_run_conflict`、database rebuild、fast-probe 和 health v4 ledger。`rtk pnpm typecheck` 通过。repository CAS/state-version/per-thread active-run invariant 已完成；下一 slice 实现 agent terminal transaction 与 outbox/projector，不切换 Stage 3/4。
- **Located:** terminal completion currently splits status, pending interrupt deletion, session message, `agent_events`, `agent_run_events` and EventBus. Stage 2 outbox will be append-only in agent DB; task projection cursor belongs task DB. Existing task history remains agent-DB read-only and is excluded from outbox replication. Next: red tests for one atomic terminal write and migration ledgers.
- **Verified passing：** completed terminal red case 已实现并转绿。agent v5/task v3 migration ledgers 与 `completeRunAtomically()` 的 run/status-version、assistant fact、timeline、outbox、lease/interrupt cleanup 同事务断言，共 20 tests 通过。下一步补 failed terminal 同一合同，再进入 task outbox shadow projector。
- **Verified passing：** failed terminal red case 先确认 API 缺失，后以同一 CAS transaction 写 error/history/replay/outbox 转绿；repository/migration suite 共 21 tests 通过。下一步实现 task-side cursor projector 的 duplicate/restart shadow replay，runtime 仍保留旧 EventBus path。
- **Verified passing：** 新增 `agent-outbox-projector.test.ts`，completed shadow replay与旧 EventBus task state 投影等价，且 cursor 在 TaskRepository 重建后阻止重复；failed outbox按现有 failure policy 暂停任务。2 tests通过。下一步切 runtime complete/fail 到 terminal transaction，并让 EventBus terminal notification best-effort；随后才把 projector接入 plugin lifecycle。
- **Verified passing：** runtime complete/fail 已切到 terminal transaction；task plugin startup replay及 terminal notification drain已切到 outbox cursor。新增 started-subscriber rejection regression，终态 subscriber regression继续通过。runtime/task focused suite为 5 files / 23 tests，`rtk pnpm typecheck` 通过。下一步替换两类 `MAX+1` allocator，之后做 bounded queue/reconciliation。
- **Changed, narrowly verified：** agent v6 cursor schema、repository/run-log/task-history allocators已改为 transaction cursor；首次受影响测试暴露 cursor外键删除顺序和无 run fixture，均已定点修正。migration、run-log与 task deletion suite为 4 files / 28 tests通过；接下来补 cursor state assertion、跑完整 agent/task focused suite，并开始 bounded queue/reconciliation。
- **Verified passing：** cursor state assertion与 task test harness均已迁移；failure snapshot改为真实 `error` timeline合同。`rtk pnpm exec vitest run tests/main/plugins/agent tests/main/plugins/task` 为 33 files / 181 tests通过。Stage 2 sequence objective完成；下一步仅处理 startup reconciliation与 bounded queue/backpressure，再做全量 review/verification/commit。
- **Verified passing：** 在 Stage 2 当前切片后重跑 `rtk pnpm typecheck` 与 `git diff --check` 均通过；后者只报告既有/工具链 CRLF 归一化警告，没有 whitespace error。Stage 2 尚未完成：`ChatRunEventQueue` 仍无界，runtime 尚未有 startup reconciliation；不提前标记 stage complete 或提交。
- **Verified passing：** queue 已增加上限、text delta 合并、high-water stats 和 overflow stream failure；`chat-run-event-queue.test.ts` 2 tests及 `rtk pnpm typecheck` 通过。Stage 2 最后未完成项为 startup reconciliation；其 restart policy 仍需和 snapshot/checkpoint/effect ledger 对齐后实现。

## Test Results

| Test | Result |
|---|---|
| Stage 0 focused tests | 尚未运行 |

## Errors

| Error | Resolution |
|---|---|
| `tests/main/services/shell-execution-service.test.ts` does not exist | Locate current test path; do not retry same command. |
| PowerShell passed literal `runtime-*.test.ts` to `rg` | Use `rg -g` from the test directory. |
| Concurrent fixture asserted `running`; runtime marks active runs `waiting_next_turn` before model work | Assert `waiting_next_turn`; no production behavior changed. |
| Terminal subscriber fixture timed out after generic `task_projection_failed` | Generic errors map to retryable provider failures; use non-retryable `RocDomainError`. |
| Terminal fixture still timed out after non-retryable error | `completeRun()` already removes active run before publish, so catch exits and no failed event occurs; characterize completed persistence instead. |
| Combined Step 3 discovery command failed without diagnostic output | Split discovery commands; do not retry the combined command. |
| Step 3 fixture failed typecheck: `__interrupt__` absent from static graph state | Read runtime interrupt projection with `Reflect.get`; validate array and payload shape. |
| Scheduler fixture asserted before async post-start work completed | Use `vi.runAllTimersAsync` to drain the timer and promise chain. |
| Scheduler callback referenced nonexistent `BackgroundTask.runId` | Remove invalid assertion; it made the simulated starter fail. |
| Step 3 review found memory DB did not prove database restart | Switch fixture to temporary SQLite file and close/reopen before resume. |
| Cancellation discovery searched nonexistent `src/main/web-read-service.ts` | Correct source is `src/main/services/web-read-service.ts`; use the current service path. |
| Combined cancellation call-path discovery failed without diagnostic output | Split discovery into independent commands. |
| `pnpm smoke:electron` failed: `No context_manifest event found after chat submit` | Investigating event production and smoke assertion; do not treat Electron smoke as passing. |
| 恢复时的分块读取 PowerShell 命令因 `$p:` 变量插值报 `Variable reference is not valid` | 改用独立命令与安全字符串格式；未重复该命令。 |
| Stage 1 并行最小回归批次在 120 秒超时且未返回单项结果 | 不重复并行批次；先查残留进程，再以单命令、单文件方式定位。 |
| `rtk pnpm test -- <path>` 将额外 `--` 传给 Vitest，跑了全套而非目标文件 | 改用 `rtk pnpm exec vitest run <path>`；记录全套失败作为 Stage 1 回归。 |
| 当前 source 的 dist Electron smoke 在 composer Enter 后未提交 chat | `context_manifest` 已出现，停止排查 repository；定位 renderer keyboard submit path。 |
| Composer 定位的组合 `rg` 正则在 PowerShell 转义后变成未闭合 group | 改用 `rg -F` 精确文本和独立 key-handler 搜索；不重复错误正则。 |
| Smoke diagnostic referenced outer `chatInputEvidence` inside `page.evaluate`, where Playwright does not retain lexical closure | Pass the evidence as the explicit `page.evaluate` argument, then rerun. |
| Locator-enter patch first matched the Shift+Enter line rather than final submit line | Restore Shift+Enter; scope the locator patch to the final submit after evidence capture. |
| Resume ledger patch string was incomplete and the tool rejected it before any write | Resent one complete patch; no repository file was modified by the failed call. |
| Smoke result ledger patch was incomplete and rejected before any write | Resend one complete patch; code was unaffected. |
| Agent-update ledger patch was incomplete and rejected before any write | Resend one complete patch; code was unaffected. |
| Agent-update root-cause ledger patch was incomplete and rejected before any write | Resend one complete patch; code was unaffected. |
| Agent-update payload ledger patch was incomplete and rejected before any write | Resend one complete patch; code was unaffected. |
| Red-test ledger patch missed a drifted task-plan error-table line | Read the table tail, then append with the exact current context. |
| Provider-update smoke ledger patch was incomplete and rejected before any write | Resend one complete patch; code was unaffected. |
| Post-smoke audit ledger patch was incomplete and rejected before any write | Resend one complete patch; code was unaffected. |
| Writer/predicate ledger patch was incomplete and rejected before any write | Resend one complete patch; code was unaffected. |
| Task-created detail ledger patch was incomplete and rejected before any write | Resend one complete patch; code was unaffected. |

## 2026-07-17 — Stage 2 resume

- 恢复前已读取 `task_plan.md`、`findings.md`、`progress.md` 与 `plan.md` Stage 2；session catchup 无未同步上下文。
- 当前 WIP 已完成 Stage 2 的 CAS/terminal transaction/outbox/projector/cursor/queue 主体；未完成：startup reconciliation 与 queue/backpressure plan 验收证据。
- 当前工作树含本 Stage 的未提交代码和测试，以及用户验收源 `plan.md`；继续只改 Stage 2 所需文件。
- 下一步：定位 runtime 初始化、snapshot/checkpoint/effect ledger 状态和现有 restart 测试；先写稳定 red fixture，再实现 reconcile。
- 定位：`createAgentPlugin().initialize()` 当前无 reconcile。拟定安全合同：不自动重放可能已有 side effect 的执行；可恢复的持久化 `waiting_user` hydrate，其他进程中断的 non-terminal run 显式转 `interrupted`。下一步写 restart red tests。
- 已确认 `resumeRun()` 的 pending interrupt 可由 repository 回读；reconcile 不需引入平行事实源。实现顺序：repository batch transition -> runtime hydrate -> plugin initialize 调用 -> restart tests。
- 更正：pending interrupt 是懒加载，无需 runtime hydrate。实现缩为：repository batch transition -> plugin initialize 调用 -> restart tests。
- 现有 restart approval 测试已覆盖 persisted `waiting_user` 的 lazy resume。新 test 必须覆盖崩溃中 run 的 terminal outbox/task 投影，防止只改 agent DB 导致 workbench 假运行。
- 同时发现 snapshot quarantine 绕开 CAS/version/outbox。纳入本次闭环：reconcile 与 quarantine 共用 terminal writer；新增测试覆盖 cursor、state version、lease、timeline/replay/outbox。
- Task outbox 已能消费同形 `run_failed`，无需 IPC/schema 扩张。下一步先盘点剩余 `updateRunStatus` 调用；Stage 2 内 HITL/retry 改 CAS，cancel 留 Stage 4 并明确记录。
- Red：`rtk pnpm exec vitest run tests/main/plugins/agent/session-repository.test.ts`；14 passed / 1 failed，唯一失败为预期的 `reconcileStartupRuns` 缺失。开始实现。
- Green：新增 `reconcileStartupRuns()` 与 plugin initialize 接线。`rtk pnpm exec vitest run tests/main/plugins/agent/session-repository.test.ts` 为 15/15；`rtk pnpm exec vitest run tests/main/plugins/agent/plugin.test.ts` 为 15/15。reconcile/quarantine 共用 CAS terminal writer，保证 state version、lease、timeline、run replay、outbox 一致。
- 下一步：Stage 2 仍需按 plan.md 验证 10k/100k bounded queue、backpressure、event-row cap 与 replay；之后做完整 Stage 2 review/修复/提交。
- Queue discovery：producer 已通过 queue failure 向 runtime 回传 overflow；无需再造 backpressure channel。需修正 coalesce-before-capacity 顺序，并为 `agent_run_events` 增加固定 10,000/run capacity；新增 10k/100k stress/replay fixture。
- Red：`rtk pnpm exec vitest run tests/main/plugins/agent/run-event-backpressure.test.ts`；queue 100k test green，timeline branch fails because event-row cap constant/behavior is absent。补齐 max=1 same-block coalesce red branch后实现。
- Green：queue coalesce-before-capacity 与 `agentRunEventLogMaxEvents=10_000` 已实现。`rtk pnpm exec vitest run tests/main/plugins/agent/run-event-backpressure.test.ts` 为 2/2（约 0.9s test time）。Stage 2 还需清除 startup/HITL/retry 对旧 `updateRunStatus()` 的旁路，随后完整验证与独立 review。
- CAS design：不迁移 repository 创建语义；runtime start 立刻 `waiting_next_turn -> dispatch_pending`，timer 进入 executor 前 `dispatch_pending -> running`。HITL/resume/retry 均改 CAS；cancel 只收敛状态 CAS，完整 cancellation side-effect 合同仍留 Stage 4。
- Red：session repository test 14/15，HITL `stateVersion` 实为 1（预期 2）；runtime thread test 同时已锁 executor-start 状态应为 `running`。开始替换旧 direct updates。
- Green：删除 `updateRunStatus()`。start、HITL/resume、retry、cancel 全部改为 expected status/version CAS；runtime thread 1/1、session repository 15/15、runtime approval 6/6、runtime recovery 12/12 通过。下一步 Stage 2 focused/broad verification，然后独立 review。
- Focused verification：`rtk pnpm exec vitest run tests/main/plugins/agent ...` 共 30 files/156 tests，27/30 files green，153/156 tests green。待修：两项 migration-ledger stale assertion；一项 streaming fixture 断言了 queue coalescing 前的 chunk 边界。
- Fix verification：`database-fast-probe` 2/2、`database-health` 3/3、`deep-agent-executor-streaming` 4/4 均通过。重新执行完整 Stage 2 focused 集合。
- Focused aggregate已通过 30 files/156 tests；`rtk pnpm typecheck` 当前失败 5 个本轮错误（nullable model/provider 4 个、approval payload 1 个）。IPC/diff 的 parallel result未返回；先修 typecheck。
- Independent review completed: standards found P0 producer continuation and outbox sequence reuse plus P1 terminal capacity; spec found P0 observer-cap changes execution plus P1 cancel replay/outbox and bounded producer backpressure, and P2 notification metric gap. Stage 2 remains uncommitted until these findings are resolved/reviewed.
- Review repair implementation: queue producer abort test 5/5 passes; cancel projector and tombstone/non-reused outbox tests pass in focused set; replay capacity keeps runtime completed and counts only redacted notification code. Run Stage 2 aggregate again before re-review.
- Review-repair verification：Stage 2 aggregate 为 30 files/162 tests；`pnpm typecheck`、`pnpm check:ipc`、`git diff --check` 均通过。启动 standards/spec 独立复审，范围限定首轮 P0/P1/P2 findings 及修复 diff。
- Session recovery: no independent review worker is live. Restored Stage 2 from `task_plan.md`/`findings.md`/`progress.md`/`plan.md`; next action is a fresh standards/spec re-review of the repaired diff, followed by any repair, verification, and the Stage 2 commit.
- Independent spec re-review returned four blocking findings: raw tool-output persistence (P0), duplicate final tool backfill (P1), reconcile missing checkpoint/effect decision evidence (P1), and terminal failure replay payload drift (P1). Standards review remains in flight; repair begins only after both reports are recorded.
- Independent standards re-review returned one additional P0: background-task placeholder rows have no executable snapshot/provider/model but startup reconcile calls `requireNonEmpty`, which blocks plugin initialization. Include this restart regression in the repair set.
- Red repair suite: 7 failures fixed the five re-review findings and exposed a terminal-slot regression for a legacy full run timeline. The initial patch did not apply because the source import context had drifted; no production file changed, then smaller exact-context patches succeeded.
- Green repair suite: `rtk pnpm exec vitest run` across stream consumers, subagent projection, tool-output projection, executor streaming, session repository, and plugin initialization passed 6 files / 50 tests. Next: Stage 2 focused aggregate, typecheck, IPC check, whitespace check, then independent final re-review.
- Stage 2 focused aggregate after repair: 41 files / 219 tests passed. `rtk pnpm typecheck`, `rtk pnpm check:ipc`, and `rtk git diff --check` passed. The aggregate exposed one obsolete final-tool-backfill assertion; converted it to the new no-backfill contract and reran green. Next: independent final standards/spec re-review, then full suite and commit if clean.
- First full `rtk pnpm test` exceeded the 60-second command cap and exposed two current regressions before timeout: `run_cancelled` was not terminal in renderer state and kernel schema fixture asserted agent v3. Both were fixed; `rtk pnpm exec vitest run tests/renderer/chat-run-state.test.ts tests/main/kernel/kernel-runtime.test.ts` passed 2 files / 11 tests. `node-pty` also emitted `AttachConsole failed`; previous successful runs treat that as teardown noise only when the process exits 0, so the timed-out run is not a passing full-suite result.
- Re-run full `rtk pnpm test` passed 296 files / 1550 tests in 66.83s; `node-pty` emitted `AttachConsole failed` after Vitest completion, but the process exit code was 0. Final reviewers found the cancelled state union, terminal diagnostic/suggestion persistence, and output-projector error-boundary defects; all three now pass focused 4 files / 35 tests and `rtk pnpm typecheck`. Automatic restart replay is intentionally excluded by the existing Stage 2 no-auto-replay safety contract; checkpoint/effect evidence still controls wait versus interrupted and only explicit user resume continues execution. Next: fresh final review after these repairs, then final verification and commit.
- Release-spec reviewer then found fast-consumer delta delivery bypassed the coalescing window and task outbox failure had no in-process recovery entry point. Added 10k waiting-consumer queue regression and manual outbox replay regression; `rtk pnpm exec vitest run tests/main/plugins/agent/chat-run-event-queue.test.ts tests/main/plugins/task/plugin.test.ts` passed 2 files / 15 tests. Next: Stage 2 aggregate, strict checks, fresh independent release review, then commit.
- Commit-gate spec review returned no findings; standards review found that consumed queue prefix entries still counted toward capacity. Added prefix compaction and a partial-consumption capacity regression; queue/backpressure verification passed 2 files / 7 tests. Next: final aggregate/full verification and a fresh no-findings independent review before Stage 2 commit.
- Final standards review found `run_failed` outbox projection left agent history at failed without the old paused audit. Projection now updates that history and records the pause only when absent; `rtk pnpm exec vitest run tests/main/plugins/task/agent-outbox-projector.test.ts tests/main/plugins/task/plugin.test.ts` passed 2 files / 15 tests. Next: final aggregate, independent re-review, full suite, and Stage 2 commit.
- **Stage 2 complete:** final outbox mapping repair adds strict `diagnostic`/`suggestion` round-trip coverage. Focused regression 4/4, strict unused scan, IPC check, diff check, build, and full `pnpm test` all passed; full Vitest is 296 files / 1556 tests, exit 0. Two fresh independent reviews reported no findings. Isolated commit `feat(agent): harden durable run state and outbox`; `plan.md` remains user-provided and untracked.
- **Stage 3 started:** 用户以“继续”接受 Scheduler 推荐策略：同 task 不重叠；misfire 只 coalesce 最新一次。Stage 2 已独立提交；当前先定位 occurrence schema、scheduler 调用链与现有 crash/scheduler tests，再写第一个稳定 red fixture。
- **Located:** `TaskScheduler.fire()` 当前先 `startRun()`，再写随机 `scheduled_task_runs` 并覆盖 `background_tasks.run_id`；无 deterministic occurrence key、revision、claim/lease。下一步读取 task schema、scheduler tests 与 plugin start contract，先定义 occurrence repository red test。
- **Stage 3 plan:** 先完成 occurrence/revision schema 与 repository claim；再接 agent dispatch-key 幂等、scheduler reconcile/coalesce、按 occurrence 的 terminal projector；最后用 crash/duplicate/revision/power-resume/乱序投影与 smoke 验证。每个提交仍只覆盖 Stage 3。
- **Verified passing:** Step 1 red test 先证明 `claimDueScheduledOccurrence()` 缺失；实现 task v4 occurrence/revision schema、唯一 claim 和 immutable request snapshot 后，`scheduled-occurrence-repository` 与 database migrations 共 2 files / 9 tests 通过。下一步接入 agent `dispatchKey` 幂等，不改变 scheduler 行为直到该合同有回归覆盖。
- **Verified passing:** Step 2 red test 先得到两个 run；`dispatchKey` 现仅允许 `background_schedule`，runtime/快照/rehydration 复用该键，竞争回退也返回已有 run。runtime + occurrence repository 共 2 files / 17 tests通过；`pnpm typecheck` 通过。下一步将 scheduler 替换为先 claim 后 dispatch。
- **Verified passing:** Step 3a scheduler red tests 已锁 claim 在 agent start 前，成功后才关联 run，启动失败写 occurrence `failed`。scheduler/crash 测试 2 files / 6 tests与 `pnpm typecheck` 通过。下一步实现 claim/dispatched restart reconcile、latest-only misfire 与 overlap coalesce，再接 terminal outbox occurrence projection。
- **Verified passing:** Step 3b/4 红测先锁 misfire latest-only、overlap pending、lease restart、dispatched restart reconcile 与 old-run outbox protection；task repository/scheduler/projector 4 files / 19 tests均通过，`pnpm typecheck` 通过。下一步将 occurrence 作为 task detail history、revision 更新和 skip 统计事实源，并补跨 DB crash/重复/乱序回归。
- **Verified passing:** task detail scheduled history 已读取 occurrence 与旧历史的并集；revision update 跳过旧 pending occurrence；task deletion 会清理 occurrence FK。fast-probe/health 当前 task schema v4，相关 4 files / 21 tests通过。另有 power-resume cron regression 通过，只 dispatch latest missed occurrence。下一步运行完整 task/agent affected suite、IPC/build/smoke，再独立 review。
# 2026-07-17 — Stage 3 恢复与验收启动

- 已重读 Stage 3 计划、当前账本、CodeGraph 调用关系和未提交 diff stat。
- 当前阶段：验收已有 Stage 3 WIP；顺序为 focused tests → 独立 review → 修复 → 再验收/review → 单独提交。
- 未修改生产逻辑；Stage 3 状态保持 `in_progress`。

## 2026-07-17 — Stage 3 聚焦验证

- `rtk pnpm exec vitest run`：9 files / 60 tests passed（occurrence、scheduler crash/reconcile、scheduler、outbox、repository、runtime、migration/health/probe）。
- 当前 diff 涉及 Stage 3 既定边界；下一步独立只读 review，禁止 reviewer 直接修改。
- `rtk pnpm typecheck` 通过。
- `rtk pnpm exec vitest run` 扩展集：3 files / 29 tests passed（schema/history/session/runtime executor）。
- `rtk git diff --check` 通过。`AGENTS.md` 已忽略且未跟踪；无新增可复用规则，不改该文件。
- `rtk pnpm test`：297 files / 1571 tests passed。期间 `node-pty` 子进程打印 `AttachConsole failed`，但测试进程退出码为 0。
- `rtk pnpm build` 通过。

## 2026-07-17 — Stage 3 独立 review #1

- Reviewer 发现 P0：lease 未到期的 restart 没有 lease-expiry wakeup，once occurrence 可永久卡在 `claimed`。
- Reviewer 发现 P1：持续 active run 下第二周期 pending occurrence 不能最新化，`next_run_at` 过期后进入 0ms loop，并违背 latest-only。
- Reviewer 发现 stale-owner CAS 缺口：terminal dispatch/failure 写入未以 owner/attempt 约束。
- 状态：修复中；禁止提交。

## 2026-07-17 — Stage 3 review red tests

- 新增 lease-expiry restart 与第二轮 overlap latest-only 回归；聚焦执行 2 files / 20 tests，新增两条均失败，确认 reviewer 时序结论。
- 失败原因：无 claim-expiry reconcile timer；active occurrence 存在时旧 pending 直接阻止最新 occurrence materialize。
- 修复首次运行发现 `pending` 常量赋值错误；已定点改为 `let`，将重跑同一聚焦集。

## 2026-07-17 — Stage 3 review repair green

- 修复 lease-expiry wakeup、latest-only overlap replacement、owner/attempt CAS；补 stale-owner regression。
- `rtk pnpm exec vitest run`：5 files / 36 tests passed。
- `rtk pnpm typecheck`、`rtk git diff --check` 通过。
- 下一步：新独立 reviewer 复审 repaired diff；未提交。
- 扩展验证：9 files / 63 tests passed；`pnpm check:ipc`、strict unused scan 通过。
- 全量验证：`pnpm test` 297 files / 1574 tests passed（`node-pty AttachConsole failed` 子进程输出，exit 0）；`pnpm build` 通过。

## 2026-07-17 — Stage 3 independent review #2

- 修复本身未发现新行为回归。
- P1 验收缺口：agent DB run 创建与 task DB occurrence 链接之间的 crash/restart 未用持久双 DB fixture 证明。下一步补该 fixture；禁止提交。

## 2026-07-17 — Stage 3 crash-gap fixture

- 新增双 DB reopen fixture：agent start 成功、task occurrence link 前 crash、lease expiry re-claim、dispatch key run re-use、terminal reconcile。
- `rtk pnpm exec vitest run tests/main/plugins/task/scheduler-crash-consistency.test.ts`：2 tests passed。
- 下一步：独立 review 新 fixture 和 Stage 3 exit coverage；未提交。
- 扩展验证：9 files / 64 tests passed；typecheck、IPC、strict unused、diff check 通过。
- 真实 runtime fixture 首跑读到 `dispatch_pending`：需 drain 同刻新增 0ms executor timer，再验证 terminal/outbox；已定点补 timer drain。
- 0ms drain 仍早于 detached scheduler fire 的 runtime timer 创建；改为 startRun-return deferred 后再 drain，避免重复同一时序假设。
- deferred 后 0ms drain 仍不运行 nested timer；按 fake-timer next-tick 语义改为 1ms advance。
- 真实 runtime terminal 已在 restart scheduler link 后被立即 reconcile；fixture 断言 completed terminal 与幂等重放，不再错误期望 dispatched 中间态。
- 真实 runtime crash-gap fixture 通过：2 tests passed。下一步独立复审 repaired fixture；未提交。
- 最终聚焦集 9 files / 64 tests、typecheck、IPC、strict unused、diff check 通过；`ROC_SMOKE_TARGET=dist pnpm smoke:electron` exit 0（仅 Node deprecation warnings）。

## 2026-07-17 — Stage 3 independent review #4

- P1：四 crash-point restart gate 未全覆盖。缺持久 scheduler 的 claim-before-start restart、terminal/outbox projector-before-projection restart。
- 下一步：补四类明确命名的 fixture 与 projector cursor replay；未提交。

## 2026-07-17 — Stage 3 four-crash repair

- 补持久 claim-before-start 与 terminal outbox-before-projector fixtures；crash suite 共 4 tests passed。
- 下一步：独立 review 四 crash gate；未提交。
- Review 补充 P1：补 outbox projector 乱序/sequence-gap regression；未提交。
- 新增 projector 乱序回归：sequence 2 拒绝且无副作用，随后 1→2 成功；`agent-outbox-projector.test.ts` 6 tests passed。等待最终 review。
- Final review P1：terminal outbox fixture 绕过 task plugin startup wiring。下一步改为真实 `createTaskPlugin().initialize()` 持久重启 replay；未提交。
- 已改为持久真实 task plugin startup replay + second startup idempotence；crash suite 4 tests passed。下一步独立复审。
- Stage 3 聚焦集 9 files / 67 tests passed；typecheck、IPC、strict unused、diff check 通过。等待最终 review。

## 2026-07-17 — Stage 3 complete

- Independent review #6：无 blocker。
- Final verification：`pnpm test` 297 files / 1578 tests；`pnpm build`、Electron smoke、IPC、strict unused、diff check 全通过。
- `node-pty AttachConsole failed` 和 Node deprecation 为 exit 0 的既有环境输出。
- Stage 3 complete；准备提交。用户未跟踪 `plan.md` 保留在工作树，不纳入提交。

## 2026-07-17 — Stage 3 committed / Stage 4 gate

- 已提交 `bc87156 feat(task): make scheduled occurrences durable`；仅保留用户未跟踪 `plan.md`。
- Stage 4 需要 Shell scope 产品选择后才能开始：interactive shell 逐次审批、background shell durable pre-authorization；若要求 workspace isolation，需授权 OS sandbox 路线。
