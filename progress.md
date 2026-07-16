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
