# Roc Agent Harness 发现

## Requirements

- 严格按 `plan.md` Stage 0-7 顺序执行。
- 每个 stage 完成实现、独立 review、修复、验证和独立提交。
- 当前树和新鲜验证优先于旧计划描述或历史过程记录。
- 最终 cleanup 只删除有直接证据证明无用的代码。

## Current Findings

### Stage 5 Part 1 Review Result

- 2026-07-23 已完成 context reducer update、summary segment 边界、summary hard budget、deterministic hard trim、provider token counter/fallback、artifact scope/pagination、main/subagent budget gate 和 `context_budget_exhausted` 终态映射。
- `read_context_artifact` 已进入 executor tool surface、冻结 capability manifest、chat/plan harness；SQL 读取同时绑定 `artifactId + threadId + workspaceHash`，sha256 必填，返回 bounded slice 与 continuation metadata。
- summary fallback 仅接受明确 schema failure、timeout、network、empty response 和 retryable HTTP；未知实现错误继续抛出。
- hard trim 保持 AI tool-call/ToolMessage 成对删除；ToolMessage 反向删除路径也会递归移除对应 AI call 及其全部结果。
- 新鲜验证：focused 11 files / 95 tests、`pnpm typecheck`、strict unused scan、`pnpm check:ipc`、`pnpm build`、full Vitest 302 files / 1631 tests、`git diff --check` 全部通过。
- 独立 risk review：未发现未处理 Critical/High/Medium finding。全量 Vitest 末尾 node-pty `AttachConsole failed` 为子进程诊断噪声，Vitest 退出码 0；不改变本 part 结论。
- 状态：**Verified passing; committed**。Part 2 Native Convergence 与 Part 3 Checkpoint/HITL 仍 pending。

### Stage 5 Part 2 Native Convergence

- Deep Agents 1.10.7 的 harness profile 过滤只作用于 main middleware；declarative inline subagent 的 native summary 在 `normalizeSubagentSpec` 中固定前置，现有 profile 不能将其排除。
- 生产路径选择 Roc pipeline：main 继续由 provider profile 排除 native summary；声明式 subagent 在 Roc builder 内编译为 runnable，保留官方 todo/filesystem/skills/patch/prompt-cache、权限覆盖、HITL 与 static response format。
- Anthropic cache 识别已对齐 1.10.7：支持 `anthropic:*`、裸 `claude*`、`ChatAnthropic` 与 provider 为 anthropic 的 `ConfigurableModel`；静态 system breakpoint 在相同输入上保持稳定。
- 固定 corpus A/B 本地结果：两条候选均完成并保留 PROJECT/DECISION/NEXT 标记；Roc summary input token 少于 native，structured summary output 较 native plain-text summary 更大；两者原文均可恢复，Roc checkpoint 经 saver 序列化后小于 native event + full message state。
- 真实 route integration 使用未 mock 的 `createDeepAgent`、compiled research subagent、Roc compaction 与 `RocSqliteCheckpointer`，完成 `task -> write_todos -> return` 并触发 `context_summary_completed`；main 最终 middleware 不含 `SummarizationMiddleware`。
- 双轴 review 的 Standards finding 已全部修复并复核无新增问题；Spec 初审的 mock vacuity、cache model compatibility、真实 route/checkpoint/long-context 证据均已补齐。Standards 与 Spec 最终复核均无本地未处理 finding。
- 新鲜验证：focused 6 files / 26 tests、真实 route、`pnpm typecheck`、strict unused scan、`pnpm check:ipc`、`pnpm build`、full Vitest 304 files / 1634 tests、`git diff --check` 全部通过。
- 状态：**Verified passing; pending commit**。真实 Anthropic provider cache usage 仍按 Stage 6 外部 integration 边界处理。

### Remaining Stage 5 Gaps

- Roc SQLite saver 的上游 conformance、multiple interrupt projection 和 resume failure preservation 尚未完成。
- checkpoint/artifact/event retention 规则尚未实现和验证。

### Durable Project Facts

- `.codegraph/` 存在；理解或定位代码时先使用 CodeGraph。
- `/workspace/` 是 DeepAgents file-tool 虚拟路径，不是 shell cwd。Shell、hook 和 subprocess 必须使用真实 Windows 工作目录。
- Run capability、tool identity、execution scope、effect policy 和 background shell authorization 以冻结 manifest/snapshot 为执行事实源。
- Agent DB 持有 run/timeline/outbox 真相；task DB 只做幂等 projection；EventBus 不是 durable state owner。
- 同 thread active run 使用 CAS/lease 约束；background occurrence 使用 durable claim/lease 和 latest-only coalesce。
- Interactive shell 无审批但仍是 host code execution；background shell 缺 durable pre-authorization 时 fail closed。
- Effect 状态包含 checkpoint/subagent execution path；`unknown` 或 manual-confirmation effect 不允许盲重试。

## Closed Stage Evidence

| Stage | Commit evidence | Durable result |
|---|---|---|
| 0 | `ae0c95b`, `4543408`, `2b28ef1`, `9845543`，以及 Stage 2/4 回归 | 原始 P0 路径已有 characterization、stress、restart 和 cancellation 证据。 |
| 1 | `4d9e8a3` | Preview、executor、audit 和 resume 共享 immutable run contract。 |
| 2 | `1fbda30` | CAS run state、terminal transaction、outbox projector、bounded timeline/backpressure。 |
| 3 | `dfbbf00` | Durable occurrence、claim/lease、restart reconcile、crash-point/projector coverage。 |
| 4 | `4ced164`, `031baea`, `20c235d`, `e75a754`, `7e1ed9f` | Shared execution safety、native budgets、host shell、web/hooks cancellation、effect reconciliation。 |

## Verification Anchors

- Backpressure：`tests/main/plugins/agent/run-event-backpressure.test.ts` 覆盖 100k text coalesce、10k structural overflow 和 10k timeline/replay bound。
- Shell cancellation：`tests/main/services/shell-execution-cancellation.test.ts` 覆盖 Windows parent/child tree termination。
- Hook cancellation：`tests/main/services/hooks/command-runner.test.ts` 覆盖 running abort、pre-abort 和 Windows child tree。
- Web abort/security：`tests/main/web-read-service.test.ts` 覆盖 caller abort、private destination 和 response cap。
- Stage 5 当前 focused anchor：`tests/main/services/deep-agent/context/context-compaction-pipeline.test.ts`。

## Open Risks

- reducer update 已由真实 LangGraph + Roc saver restart integration 证明写入 checkpoint；尚未覆盖完整 Deep Agents model loop。
- `context_budget_exhausted` 只有进入 runtime terminal path 后，才能证明不会触发 recovery 或继续 model call。
- Stage 5 不得保留 Roc 与 native 两套长期并行的 summarization 事实源。
- 本地 cache contract 已验证；真实 Anthropic `cache_read` usage 需要外部 provider 凭据，归 Stage 6 integration，当前不得表述为 provider hit 已验证。
- Windows 全量测试偶发输出 node-pty `AttachConsole failed`，当前 Vitest 仍以退出码 0 完成；后续若转为非零退出再单独定位环境边界。
