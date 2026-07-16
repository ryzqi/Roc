# Roc Agent Harness 发现

## Requirements

- 严格按 `plan.md` Stage 0–7 顺序执行。
- 每部分完成后独立 review；有问题修复；无问题提交。
- 最终安全清理仅能证明无用的遗留代码。

## Current Findings

- 工作树当前仅有用户提供、未跟踪的 `plan.md`；代码分支为 `main`。
- `.codegraph/` 存在；代码定位必须优先使用 CodeGraph。
- Stage 0 目标是表征测试，不改变运行行为。
- `plan.md` 指定的 shell scope 与 scheduler misfire 属于产品行为 Gate，分别在 Stage 4、Stage 3 切换前确认。
- `AgentPluginRuntime.startRun()` 只以 `run.id` 加入 `activeRuns`，未见 per-thread lease；Stage 0 可先用受控 executor 固定复现同 thread 双启动。
- `AgentPluginRuntime` 同步等待 EventBus；`EventBus.publish()` 在 subscriber 失败后抛出 `AggregateError`，这是 terminal 投影复现的真实路径。
- `TaskScheduler.fire()` 先 `startRun()`，后 `runNow()` 记录 task 关联；Stage 0 crash fixture 应固定这个间隙。
- `completeRun()` 当前在 `agent.run.completed` publish 前移除 `activeRuns`；subscriber failure 不会把 persisted completed 覆盖为 failed。`plan.md` 对这一条的“当前问题”已过时，Stage 0 应保留回归 characterization，而非伪造旧故障。
- 现有 runtime fixture 集中在 `runtime-executor.test.ts`、`runtime-streaming.test.ts`、`runtime-approval.test.ts`；计划指定的新 Stage 0 文件尚不存在。
- shell 现有测试位置为 `tests/main/plugins/runtime-tools/shell-adapter.test.ts`，不是计划中的旧路径；新 cancellation fixture 可按计划创建。
- Step 3 官方/本机契约：interrupt 必须使用 persistent checkpointer 与稳定 `configurable.thread_id`；重建后的 agent 用同一 thread 和 `new Command({ resume })` 恢复。现有 `sqlite-checkpointer.test.ts` 仅验证 saver DTO，尚无真实图 restart fixture。
- Step 3 已用真实 LangGraph graph 验证：approval 原生 `interrupt()` 与 Roc `createAskUserTool()` 都能在新 graph/new saver instance 中用相同 thread resume；不依赖 provider 或网络。
- Step 3 review 修正：approval fixture 改走真实 `createDeepAgent({ interruptOn })`；Deep Agents 1.10.7 通过原生 `humanInTheLoopMiddleware` 生成 approval interrupt。
- Step 3 review 通过：文件 SQLite reopen、new saver/new graph/new Deep Agent、same thread、native HITL 和 Roc ask_user 均已覆盖。
- Step 4 当前 scheduler 无 durable occurrence/claim、crash hook 或 terminal projection；可直接证明的当前路径是 `startRun -> recordScheduledTaskRun -> markBackgroundTaskFired`。真正四个 crash/restart fixture 需要 Stage 3 occurrence 状态机落地后验证，不能由现有 timer 伪造。
- Step 4 review：scheduler 顺序基线符合当前源代码且无生产行为改动；它不是完整 crash recovery 证据，Stage 0 Gate 不能因此宣告完成。
- Step 5 当前 `ChatRunEventQueue` 没有 queue depth/high-water 观测，`AgentRunEventLog` 没有 event row cap；因此无法从现有公开或测试接口诚实记录计划要求的 queue high-water。可在不改生产代码时测 10k/100k 吞吐、SQLite rows、replay time，但高水位需 Stage 2/6 的 instrumentation。
- Step 6 当前 Deep Agent stream 接收 run `AbortSignal`，但 `createRocWindowsCommandTool()` 的 adapter contract、`ShellExecutionService` 和 `HookCommandRunner` 均未接收该 signal；`WebReadService` 仅有自身 timeout 的 `AbortController`。因此 shell/web/hook 的 graph-cancel 与 Windows child-tree regression 只能随 Stage 4 的统一执行合同实现，不能用脆弱的源码形状断言伪装为当前完成。
- Stage 1 的真实持久化 owner 是 `AgentSessionRepository.createTaskRun()`：它在同一 agent DB 事务创建 thread/run/user message。Task plugin 只读取该 DB 作工作台投影。现状没有把 `capabilityPreview` 写为 `context_manifest`，因此 Electron smoke 找不到审计卡。修复必须和 snapshot 同事务完成，不能把 task subscriber 变成第二事实源。
- 2026-07-15 恢复核对：当前 WIP 的 `AgentSessionRepository.createTaskRun()` 已在创建 run/user message 的同一事务插入 `context_manifest`。但 Electron smoke 仍报 `No context_manifest event found after chat submit`；下一步应追 `agent_events` 的读取、replay 和 smoke 诊断投影链，不能再增加平行写入。
- 2026-07-15 恢复核对：session catchup 无未同步上下文；当前工作树包含 Stage 1 的未提交 WIP，`plan.md` 仍是未跟踪的用户提供验收源。
- Stage 1 Gate：不得把 preview、executor、subagent、HITL 或 effect policy 的授权计算分散保存；验收是给定 `runId` 仅从 agent DB 重建执行请求，且所有消费者共享一个 manifest hash。当前只处理这个 contract 和由它导致的 smoke 回归，不提前进入 Stage 2。
- CodeGraph 当前调用链：`startRun()` 创建 snapshot 后用其生成 normalized request，并把同一 snapshot 传到 `executeRun()`；executor contract 已只接收 `snapshot`。`createTaskRun()` 校验 preview/snapshot manifest hash 相同后，在同一事务写 run、user message、`context_manifest`。需确认 smoke 未观察到事件的实际消费链及 WIP 是否仍有其他授权性重算。
- 回归基线：`rtk pnpm test -- <path>` 会把额外 `--` 传给 Vitest，导致路径过滤失效；聚焦测试必须用 `rtk pnpm exec vitest run <path>`。误跑的全套暴露 Stage 1 回归：agent schema 已为 3 而基础设施健康测试仍断言 2；agent plugin 调 workspace capability 时未声明依赖；runtime hooks fixture 发送了非 workbench 来源的 `workspacePath`，被新来源合同拒绝。
- 根因定位：`createAgentPlugin()` 无条件配置 `workspaceProvider` 并在 run start 调 `workspace.getCurrent`，但 `resolveDependencies()` 只在非 mock deep executor 场景添加 `@roc/plugin-workspace`。依赖应与实际 capability 调用一致。`runtime-hooks` 的 `workspacePath` 是模拟 workbench workspace，应显式加 `taskSource: 'workbench'`，而非放宽生产来源合同。
- Smoke 推断：`createTaskRun()` 对 user message 与 `context_manifest` 使用同一个 timestamp 和数据库事务；task snapshot 同样直接读取 `agent_events`。若同一 smoke 已读取到该 run 的 user event，却读不到后写入的 manifest，当前源码不可能产生该持久化状态。先验证 smoke 的 Electron 运行目标是否为未重建的 `dist`；不在 repository 增加补写或双写。
- Smoke target 机制：`pnpm smoke:electron` 直接启动 smoke 脚本；未显式 `ROC_SMOKE_TARGET=dist` 时优先使用已存在的 `release\\win-unpacked\\Roc.exe`，否则使用 `dist/main/index.js`。该 smoke assertion 是当前 WIP 新增，但 target 可为旧构建，足以解释其与当前 repository 事务矛盾。正确验证顺序是先 build，再明确 `ROC_SMOKE_TARGET=dist` 运行。
- 现场确认：`release\\win-unpacked\\Roc.exe` 和 `dist\\main\\index.js` 均存在，且 `ROC_SMOKE_TARGET` 未设置。因此此前 `pnpm smoke:electron` 实际优先运行已存在 packaged target，不是当前 source；Stage 1 smoke 必须先 build 后显式 `ROC_SMOKE_TARGET=dist`。
- Stage 1 dist smoke：`context_manifest` 已出现在 task snapshot，原 `No context_manifest event found after chat submit` 已验证为旧 target 假阳性。新的独立失败：chat composer `Enter` 后输入仍留在框内、`[data-testid="chat-transcript"]` 为空，超时等待 `Smoke Provider 已生成首轮回复。`。先定位 renderer submit 事件；不修改 manifest/repository。
- Composer source：textarea 的裸 `Enter` 已调用 `preventDefault()` 和 `submitComposer()`；send button 同样调用该函数。现有 renderer tests 覆盖上层 queued task 的 keyboard submit，但没有覆盖真实 `ChatComposer` 的多行 `Shift+Enter` 后裸 Enter。因此下一步先检查 submit disabled/state 与 smoke artifact，再决定是 renderer 实现还是 smoke focus/interaction contract。
- Composer wiring：`ChatComposer` 将 `submitComposer()` 直接绑定到 `ChatView.submitCurrentInput`。smoke 在 submit 前已验证 send button 未 disabled，但其 timeout debug 未包含该 pre-submit evidence；需检查 `submitCurrentInput` 的 guard，以及实际 `document.activeElement`，不能仅凭 input 保留文本判断键盘事件未到达。
- `submitCurrentInput` 若进入 success path 会在等待 assistant 前立即清空 input；此次 input 未清空，故最终 Enter 未触发 textarea handler，而非 provider response 延迟。现有 `.artifacts\\wave1` 是旧产物，本轮 smoke 未落入可用 failure artifact；在 smoke debug 中补焦点与 pre-submit evidence，再复现一次。
- 焦点复现证据：final key 前 `activeElementTestId` 为 `chat-input`，输入可编辑、send button 未 disabled，`submitCurrentInput` guard 不成立；全局 `page.keyboard.press('Enter')` 仍未触发提交。此处用 locator-targeted `press('Enter')` 保持真实 textarea key path，并避免 Playwright/CDP 全局键盘焦点漂移；不改 production behavior。
- locator-targeted Enter 同样失败，故不是 focus/CDP 全局键盘问题。未清空 input 且无该 typed prompt 的 agent event 表明 `onSubmitChatTask` 未返回成功，或 run start 被 IPC/main 拒绝。下一步应直接采集 renderer error 和 IPC result；停止修改 keyboard path。
- 根因：`use-app-task-runs.ts` 的普通 chat request 发送 `taskSource: null` 与 `workspacePath: currentWorkspacePath`；Stage 1 runtime 正确以 `agent_workspace_path_source_invalid` 拒绝该裸 path。普通 chat 应不传 `workspacePath`，由 main 的 plugin-scoped `workspaceProvider` 解析当前 workspace；不能为兼容 renderer 输入放宽 runtime policy。
- Renderer coverage：`app-shell.test.tsx` 当前在普通 chat 与 plan-chat 两处断言 `taskSource: null` 仍携带 `workspacePath`，因此必须随 production request 一起更新。`startTaskRun()` 的 workbench task path 继续携带显式 workspace path，不能被本次改动触及。
- 修复后 dist smoke 已越过 composer submit 与 manifest assertion，新的失败为 `No provider agent_update event found after chat submit.`。这符合 Stage 1 未完成项：`createTaskRun()` 当前事务只写 user message 与 context manifest，未写现有 consumer 所需的 canonical run start/provider event。先追 `agent_update` 的旧生产路径与 payload contract，不改 smoke 降级。
- `agent_update` 当前由 Task plugin 的 `agent.run.started` EventBus subscriber 写入，而不是 `createTaskRun()` 的 agent DB 事务；runtime publish 在创建后发生。Stage 1 需要把 canonical start/provider timeline event 同 run snapshot/user message 原子持久化，并防止 Task projector 继续重复写入。先读 projector payload/ownership和对应 tests。
- 精确缺口：`TaskRepository.recordAgentRunStarted()` 在 `agent_runs` 已存在时立即返回；Stage 1 repository 先创建 run，导致 EventBus task projection 不再插入 `agent_update`。把 running/provider/model timeline event 直接加入 `createTaskRun()` 事务可恢复现有 consumer 合同，同时避免重复写入。
- 兼容 payload：legacy task projector 的 start event 是 `agent_update` `{ status: 'running' }`；不要借修 smoke 擅自扩展 timeline payload。Stage 1 repository 应原子写同形 event，repository test 从三项初始事件更新为 message、context manifest、agent update、后续 assistant block。
- 当前 dist smoke 已证明 start event 存在，但 `taskProviderUpdateStored=false`：smoke 的 provider timeline contract 需要 `providerId` 与 `modelId`。将 immutable snapshot 的 model identity 写入同一 start event；这是 Stage 1 明确的 provider/model recovery contract，不是 UI 特判。另有独立 `naturalLanguageTaskCreated=false`：task 已创建但缺 `background_task_created` event，待 provider event green 后单独追踪。
- 最新 dist smoke 已完成全链路并收敛为两个失败检查：`taskProviderUpdateStored` 与 `naturalLanguageTaskCreated`。前者说明 start event identity 与 smoke expected provider 不一致，后者说明 background task 已存在却没有 `background_task_created` timeline record；两者均须先查实际 writer 与 predicate，不能根据名称补写。
- Writer/predicate 对齐：`createBackgroundTask()` 确实写 `background_task_created`，但 payload 只有 `taskId/status`；smoke 按 `goal` 匹配，故 task 已创建仍判失败。需在该 event 写 task goal。provider smoke 则要求 terminal `agent_update` 包含 `finishReason:'stop'`，start event 不足；另行检查 completed projector。
- Smoke predicate detail：`taskProviderUpdateStored` 要 terminal event 的 `providerId`、`modelId`、`finishReason:'stop'`，不能由 start event 满足；`naturalLanguageTaskCreated` 的缺口只在 created audit payload 少 `goal`。两个生产路径独立，先用 task repository test 固定 created event goal，再追 terminal projector。
- 2026-07-16 会话恢复：catchup 表示完成 terminal `agent_update` 与自然语言 task audit 的 smoke 修复后，正收尾显式 `/skill` 的 immutable manifest 合同：selected 与 explicit skill identity 进入 manifest；executor 只读 snapshot、不会运行时重新列技能；显式技能同样进入 `/skills/` backend 白名单，并在 manifest 编译阶段拒绝 disabled/not-found/invalid 项。该变更的 8 files / 63 tests 已通过；后续 `pnpm typecheck` 的结果必须重新回收确认。
- 2026-07-16 验证：无残留 `typecheck` 进程；重新执行 `rtk pnpm typecheck` 通过。覆盖本次变更的 22 个 Vitest 文件（数据库 migration/rebuild、manifest、executor、runtime、task repository 与 renderer）共 137 tests 通过。
- 2026-07-16 完整验证：`pnpm check:ipc` 确认 generated files current；fresh `pnpm build` 成功；`ROC_SMOKE_TARGET=dist pnpm smoke:electron` exit 0，明确验证了刚重建的 dist。smoke 输出仅有 Node deprecation warnings，不影响成功退出。
- 2026-07-16 review 静态证据：`startRun()` 编译 capability preview、创建 snapshot seed，再由 `createTaskRun()` 在同一事务写 run、user message、`context_manifest`、canonical start `agent_update` 与 `run_started` event；随后重新从 repository 读取 snapshot 再构造执行请求。`getRunExecutionSnapshot()` 会对缺失、JSON 无效、schema/identity 不匹配的 snapshot quarantine 并失败。`git diff --check HEAD` 通过；等待独立 standards/spec review 对完整差异作最终判定。
- 2026-07-16 broad verification：`pnpm exec tsc --noEmit -p tsconfig.json --noUnusedLocals --noUnusedParameters` 通过；`pnpm test` 为 292 files / 1522 tests 通过。测试进程后输出四次 `node-pty` `AttachConsole failed`，但 Vitest exit 0，属于既有 Windows teardown 噪音，不能作为失败或本次修复证据。
- 2026-07-16 双轴 review 已确认两项当前 Stage 1 合同缺口：(1) `resolveRunOrigin()` 仅看 `workflowHint`，普通 chat 可被标为 `workbench_creation`，而 scheduler 使用 `taskSource: 'workbench'` 仍会落为 `manual_task_run`；由于 executor snapshot-only，这会冻结错误的授权来源。(2) compiler 在 `manifest.skills` 加入 explicit skills，却只将 requested selected skills 返回为 `skillCards`；repository 持久化该不完整卡片列表，导致 explicit skill 可执行但审计卡缺失。review 建议的 Stage 2 outbox 与完整 subagent safety stack 属于后续 stage，不提前实现。
- Run-origin 回归定位：当前 `ChatStartRunRequest.taskSource` 只表达 `'workbench' | null`，scheduler 也复用了 `'workbench'`；必须增加明确的 trusted scheduler value，并同步更新 renderer/workbench、scheduler 和测试 helper 中用 workflow hint 猜 origin 的逻辑。`resolveRunWorkspace()` 已把非-workbench 的 `workspacePath` 作为来源错误拒绝，故 scheduler 的 trusted source 应延续该显式来源检查而非绕过它。
- Snapshot rehydration 还会把所有 `mode: 'task'` 的 request 一律还原为 `taskSource: 'workbench'`。新增 `background_schedule` 来源时必须使 `createChatStartRunRequestFromSnapshot()` 保留该来源；否则 initial run 虽冻结正确，resume/metadata request 又会丢失 provenance。
- Review fix：`taskSource` 新增 `background_schedule` 并只允许该来源冻结为同名 `runOrigin`；workflow hint 必须同时有 `taskSource: 'workbench'`，否则在持久化前以 `agent_workflow_hint_source_invalid` 拒绝。scheduler、workspace source validation、new-thread kind 与 snapshot rehydration 均同步到该来源。compiler 的 `skillCards` 现在从完整 `manifestSkills` 生成，故 selected 与 explicit skills 均写入同一 `context_manifest` audit card。新增/扩展的 3 files / 22 tests 已 green；完整再验证仍待执行。
- Post-review focused suite 的两个失败均是 fixture 仍构造旧 provenance：executor unit test 需要 frozen `workbench` snapshot，runtime tool-block test 需要 workflow hint 的 workbench source。仅更新这两个测试输入后，Stage 1 focused 集合为 23 files / 144 tests 通过。
- Post-review full verification：strict unused scan、`pnpm check:ipc`、fresh `pnpm build`、明确 `ROC_SMOKE_TARGET=dist` 的 Electron smoke 与 `pnpm test` 全部通过；全量为 292 files / 1524 tests。full Vitest exit 0 后仍有已知 Windows node-pty `AttachConsole failed` teardown 噪音，非本次回归。

## Verification Rules

- TypeScript 改动至少运行 focused test、`pnpm typecheck`、`git diff --check`。
- 数据库、路径、打包、IPC 改动按 `plan.md` 的专项矩阵扩展。
- 最终清理运行 strict unused scan、typecheck、IPC check、build、test、diff check。

## Review Results

- Stage 0 Step 1 standards review：无问题。
- Stage 0 Step 1 spec review：无问题；deferred barrier、fake timers 和 runId/status 断言覆盖实际并发路径。
