# Background Task DeepAgents Creation Design

## Goal

后台任务创建流改为 DeepAgents 主导。用户在任务工作台创建后台任务时，由 DeepAgents 理解完整任务描述、解析自然语言触发时间、调用后台任务工具完成创建。系统必须修复当前 deterministic workflow 与 DeepAgents 同时处理同一个 run 的双链路并发问题。

## Current Facts

- `src/main/plugins/agent/runtime.ts` 在 `startRun` 中发布 `agent.run.started` 后，会继续异步启动 `executeRun`。
- `src/main/plugins/task/index.ts` 当前监听 `agent.run.started`，当 `workflowHint` 是 `propose_background_task` 时，会调用 `createTaskProposalWorkflow` 走 deterministic 创建链路。
- `src/main/plugins/task/task-proposal-workflow.ts` 当前通过 `resolveBackgroundTaskTime` 规则解析时间，再调用 `task.background.preview` 和 `task.background.create`。
- `src/main/services/deep-agent/background-task-tools.ts` 已经提供 `propose_background_task`、`schedule_background_task`、`read_background_task`、`update_background_task`、`cancel_background_task` 工具。
- `src/main/plugins/agent/deep-agent-executor.ts` 当前可以按 `workflowHint` 控制后台任务工具装配。

## Requirements

- 后台任务创建由 DeepAgents 作为唯一执行链路，不再由 task plugin 在 `agent.run.started` 后自动创建。
- 自然语言时间由大模型解析，不采用 `resolveBackgroundTaskTime` 规则解析器作为创建流权威来源。
- 创建后台任务时必须给 DeepAgents 装配后台任务创建工具。
- 创建后台任务时仍需要装配 shell、文件、workspace 等常规 DeepAgents 工具，不能把创建流降级成只会调用后台任务工具的窄 harness。
- DeepAgents 在创建后台任务流里可以分析 workspace、检查文件、运行命令，但最终应调用后台任务工具创建任务，而不是把用户要定时执行的目标立即当场完成。
- 修复双链路并发：同一个 workbench proposal run 只能被 DeepAgents 处理一次。
- 不增加配置开关，不保留第二条兼容创建链路。

## Recommended Design

### 1. DeepAgents 成为创建流 owner

`workflowHint='propose_background_task'` 且 `taskSource='workbench'` 时，`AgentPluginRuntime` 继续按正常 DeepAgents run 执行。task plugin 不再在 `agent.run.started` 事件中调用 `createTaskProposalWorkflow` 自动创建任务。

task plugin 仍保留这些职责：

- 记录 `agent.run.started`、`agent.run.completed`、`agent.run.failed`。
- 记录 `agent.run.task-event` 中的工具调用、消息、reasoning、审批事件。
- 提供 `task.background.preview`、`task.background.create`、`task.background.update`、`task.background.cancel`、`task.detail.get` 等 capability。
- 维护 repository、scheduler 和 task snapshot。

这样创建流只有一条路径：DeepAgents 生成工具调用，task capability 执行真实创建。

### 2. 工具装配

创建后台任务工作流需要同时装配两类工具。

后台任务工具：

- `propose_background_task`
- `schedule_background_task`
- `read_background_task`

创建流不装配 `update_background_task` 和 `cancel_background_task`。修改、取消已有后台任务继续走 `workflowHint='background_task_change'`，避免创建任务时顺带扩大破坏面。

常规 DeepAgents 能力：

- workspace 文件读写能力
- shell 执行能力
- 已启用 MCP 工具
- web read 工具
- 现有 memory、skills、subagent 能力按当前 DeepAgents 架构保持

不再把 `resolve_background_task_time` 作为创建流工具。若该规则解析器仍被其他非创建路径使用，也不能作为后台任务创建流的权威解析步骤。

### 3. 时间解析责任

时间解析由大模型在 DeepAgents 推理中完成，并直接写入 `propose_background_task` 的 `trigger` 参数。

创建流 system prompt 需要明确约束：

- 用户说“每天晚上9点”，生成每天 21:00 的 cron。
- 用户说“每天早上7点”，生成每天 07:00 的 cron。
- 用户说“每天中午1点”，生成每天 13:00 的 cron。
- 用户说“每天晚上12点”，生成每天 00:00 的 cron。
- `cronExpression` 使用五段 cron。
- `nextRunAt` 使用 UTC ISO 字符串。
- 如果触发时间仍不确定，回复澄清，不调用 `propose_background_task`。

工具层继续做结构校验和安全校验：

- `trigger.type` 只能是 `manual`、`once`、`cron`。
- cron 表达式必须能被现有 cron parser 解析。
- once trigger 不能在过去。
- workspace path 必须可达。

### 4. 禁止即时完成任务目标

创建后台任务流允许 DeepAgents 使用 shell 和文件工具做上下文调查，但 prompt 必须区分“创建后台任务”和“执行后台任务目标”。

示例：用户说“每天晚上9点创建 docx 文件，里面写你好世界”，DeepAgents 应创建一个定时后台任务，任务 goal 描述未来要创建 docx 文件；不应在当前 run 里直接写出 docx 文件作为替代结果。

这是行为约束，不通过移除 shell/file 工具实现。工具保留，prompt 和测试约束防止误用。

## Data Flow

1. 用户从任务工作台提交创建请求。
2. renderer 发起 `agent.run.start`，携带 `workflowHint='propose_background_task'` 和 `taskSource='workbench'`。
3. agent runtime 发布 `agent.run.started` 并启动 DeepAgents run。
4. task plugin 只记录 run started，不自动创建任务。
5. DeepAgents 根据 prompt 和上下文解析任务目标与触发时间。
6. DeepAgents 调用 `propose_background_task` 创建 preview。
7. DeepAgents 调用 `schedule_background_task` 落库并注册调度器。
8. task plugin 通过 task event 记录工具调用过程，通过 background task capability 保存真实任务。
9. agent runtime 发布 completed，task plugin 记录最终 assistant message。

## Error Handling

- 如果模型无法确定时间，assistant 返回澄清问题，不调用 `propose_background_task`。
- 如果模型生成的 trigger 不符合 schema 或 cron parser 校验，现有工具错误映射返回明确修正建议。
- 如果 `schedule_background_task` 收到未知 `previewId`，继续返回现有 `Unknown previewId` 工具错误。
- 如果 shell/file 工具在创建流中被用于即时完成任务目标，测试应捕获该行为回归。

## Alternatives Considered

### A. 模型只解析时间，harness 创建任务

这个方案能避免模型直接创建任务，但仍保留 deterministic harness 作为创建 owner。用户已明确选择 DeepAgents 为主，不采用。

### B. DeepAgents 全程创建，保留常规工具

推荐方案。它符合用户要求，且能让 DeepAgents 在必要时检查 workspace 和运行命令，同时通过单 owner 修复双链路并发。

### C. DeepAgents 创建，但移除 shell/file 工具

能降低即时执行误用风险，但不符合“需要装配 shell 等工具”的要求。

## Testing Plan

- `deep-agent-executor` 测试：workbench proposal run 会装配 `propose_background_task` 和 `schedule_background_task`。
- `deep-agent-executor` 测试：workbench proposal run 仍保留 shell/file/web read/MCP 等常规能力。
- `task plugin` 测试：`agent.run.started` 携带 `propose_background_task` 时，不再触发 deterministic preview/create。
- `runtime` 或 executor 集成测试：DeepAgents 通过 `propose_background_task` 和 `schedule_background_task` 创建任务后，任务事件和 completed 状态只出现一条链路。
- provider fixture 测试：输入“每天晚上9点创建 docx 文件，里面写你好世界”时，工具调用为后台任务创建工具，不是 `write_file` 或 shell 立即写文件。
- prompt 测试：创建流 prompt 包含中文时段词映射和“不要即时执行任务目标”的约束。
- 清理测试：旧 `task-proposal-workflow` deterministic 创建测试删除或改写，避免继续要求旧链路存在。

## Verification

实现后至少运行：

- `pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts`
- `pnpm test -- tests/main/plugins/agent/runtime.test.ts`
- `pnpm test -- tests/main/plugins/task/plugin.test.ts`
- `pnpm test -- tests/main/deep-agent-prompt.test.ts`

若修改 shared prompt、工具协议或 smoke fixture，再运行相关 smoke fixture 测试。
