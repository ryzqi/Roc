# Background Task Propose Runtime Normalization Design

## Goal

修复后台任务创建流中 `propose_background_task` 参数不稳定的问题。DeepAgents 仍负责理解用户目标和触发时间，但 runtime 必须成为 workspace 路径和低风险派生字段的权威来源，避免模型在 Windows 绝对路径、DeepAgents 虚拟路径和后台任务持久化合同之间猜测。

## Current Facts

- 当前后台任务创建流由 DeepAgents 调用 `propose_background_task` 创建 preview，再调用 `schedule_background_task` 落地。
- `src/main/services/deep-agent/background-task-tools.ts` 的 `cronTriggerSchema` 要求 `trigger.description`、`cronExpression`、`nextRunAt`。
- 实际失败样例中，模型传入了 `trigger.type`、`cronExpression`、`nextRunAt`，但漏掉 `trigger.description`，LangChain 工具层在进入业务逻辑前直接 schema parse 失败。
- `src/main/services/deep-agent/backend.ts` 已将 `/workspace/` route 映射到当前 Windows 工作区，并使用 `FilesystemBackend({ virtualMode: true })`。
- DeepAgents 文件工具应使用虚拟路径 `/workspace/...`；后台任务 `workspacePath` 元数据应保存 Windows 绝对路径，例如 `G:\杂\test`。
- DeepAgents 官方 TypeScript 示例使用 `CompositeBackend` 将 `/workspace` 前缀路由到 `FilesystemBackend({ rootDir })`，说明虚拟路径和宿主路径应由 backend 隔离，而不是暴露给模型混用。

## Requirements

- 模型不再负责填写 `workspacePath`。
- runtime 注入当前选中工作区的 Windows 绝对路径作为后台任务 `workspacePath`。
- 模型漏填 `trigger.description` 时，runtime 自动补齐可解释的中文描述。
- 不放宽最终业务合同：repository 和持久化层仍要求完整 `BackgroundTaskPreviewRequest`。
- 不恢复旧 deterministic `resolve -> propose -> schedule` 创建链路。
- 不新增配置开关、兼容别名或第二套后台任务创建工具。
- 不允许模型把 `/workspace/` 当作后台任务 `workspacePath`。

## Field Ownership

模型负责生成：

- `goal`
- `trigger.type`
- `trigger.cronExpression`
- `trigger.nextRunAt`

runtime 负责生成或注入：

- `workspacePath`
- `allowedActions`
- `forbiddenActions`
- `notificationPolicy`
- `enabledCapabilities`
- `failurePolicy`

runtime 可派生：

- `trigger.description`

runtime 不派生：

- `trigger.type`
- `trigger.cronExpression`
- `trigger.nextRunAt`

如果缺少不派生字段、cron 非法、`nextRunAt` 非 UTC ISO，工具应继续返回明确错误或让 agent 请求澄清。

## Path Boundary

Roc 中必须保留两套路径语义。

DeepAgents 文件工具路径：

- `read_file`
- `write_file`
- `edit_file`
- `ls`
- `glob`
- `grep`

这些工具只应使用 `/workspace/...`、`/skills/...`、`/agents/...`、`/memory/...` 等虚拟路径。`/workspace/...` 由 `CompositeBackend` route 映射到当前 Windows 工作区。

后台任务元数据路径：

- `BackgroundTaskPreviewRequest.workspacePath`
- `BackgroundTask.workspacePath`
- scheduler 后续恢复执行时的 workspace root

这些字段必须是 runtime 注入的 Windows 绝对路径。模型不应填写，也不应看到需要自己选择 `/workspace/` 还是 `G:\...`。

## Recommended Design

### 1. Split model-visible input from final preview request

为 `propose_background_task` 引入 model-visible 输入合同：

- `goal`
- `trigger`

`trigger.description` 允许缺省。`workspacePath` 不作为模型必填字段。

工具内部将 model-visible 输入转换为完整 `BackgroundTaskPreviewRequest`，再交给现有 preview 创建逻辑。

### 2. Runtime normalization

新增或调整 normalize 层，执行顺序：

1. 解析 model-visible 输入。
2. 读取当前 runtime workspace path。
3. 如果没有选中 workspace，返回 `background_task_workspace_required` 一类明确错误。
4. 如果模型传了 `workspacePath`，不采用该值；最终值始终来自 runtime。
5. 如果 `trigger.description` 缺失，按 trigger 生成中文说明。
6. 注入 runtime defaults。
7. 用完整业务合同校验 normalized request。
8. 调用 `task.background.preview`。

`trigger.description` 派生规则保持简单：

- cron 且五段格式可解析时，生成 `每天 HH:mm 触发`、`每周 D HH:mm 触发` 或保守的 `按 cron <expr> 触发`。
- once 生成 `在 <nextRunAt> 触发`。
- manual 生成 `手动触发`。

如果派生不确定，使用保守描述，不反向改变 cron 或 nextRunAt。

### 3. Prompt update

创建流 prompt 应说明：

- `propose_background_task` 不需要模型填写 `workspacePath`。
- DeepAgents 文件工具使用 `/workspace/...`。
- 后台任务 workspace 由 runtime 注入 Windows 绝对路径。
- 用户要求定时执行文件操作时，当前 run 创建后台任务，不立即写文件。

prompt 是辅助约束，不作为唯一防线。

### 4. Error mapping

schema 错误建议应能指出具体缺失路径。至少覆盖：

- 缺 `trigger.description` 不再失败。
- 缺 `workspacePath` 不再失败。
- 缺 `trigger.nextRunAt` 时提示 `cron trigger 需要 UTC ISO nextRunAt`。
- 非法 cron 时提示使用五段 cron。

## Data Flow

1. 用户在任务工作台输入“每天中午一点创建 docx 文件，里面写你好世界”。
2. renderer 发起 `agent.run.start`，携带 `workflowHint='propose_background_task'` 和当前 workspace。
3. DeepAgents 使用 `/workspace/...` 作为文件工具路径语义。
4. 模型调用 `propose_background_task`，可以只传 `goal` 和 `trigger`。
5. runtime normalization 注入 Windows `workspacePath`，补齐 `trigger.description`。
6. 完整 preview request 进入 `task.background.preview`。
7. `propose_background_task` 返回 `previewId`。
8. 模型调用 `schedule_background_task`。
9. scheduler 后续使用持久化的 Windows workspace root 执行后台任务。

## Error Handling

- 未选择 workspace：不创建 preview，要求用户先选择工作区。
- 模型传 `/workspace/` 或其它 workspacePath：最终 preview 仍使用 runtime workspace；可记录 diagnostic。
- 缺 `trigger.description`：自动补齐。
- 缺 `cronExpression`、缺 `nextRunAt`、非法 cron：返回工具错误，agent 应修正参数或请求澄清。
- `schedule_background_task` 的 `previewId` 仍保持 one-shot 语义，不在本设计中改变。

## Alternatives Considered

### A. Runtime 注入 workspacePath，补齐低风险字段

推荐方案。它保留 DeepAgents 创建流，同时把路径和低风险派生字段移出模型责任面。

### B. 只加强 prompt 和错误提示

改动小，但仍依赖模型每次完整复写复杂 schema。当前失败正是 prompt 足够接近但缺字段导致，不能作为生产级修复。

### C. 新增 `create_scheduled_background_task` 高层工具

能进一步降低模型负担，但会新增一套创建工具和合同，超出当前修复范围，也会与现有 `propose -> schedule` 审批和 preview 语义重叠。

## Testing Plan

- schema/tool 测试：模型输入缺 `workspacePath` 时，preview 使用 runtime Windows path。
- schema/tool 测试：cron trigger 缺 `description` 时自动生成描述。
- schema/tool 测试：模型传 `/workspace/` 作为 `workspacePath` 时，最终 preview 不采用该值。
- prompt 测试：创建流 prompt 包含文件工具路径和后台任务 workspacePath 的边界说明。
- executor/runtime 测试：用户目标为“每天中午一点创建 docx 文件，里面写你好世界”时，缺 `description` 和 `workspacePath` 的 tool call 仍可完成 `propose -> schedule`。
- regression 测试：`/workspace/` route 仍存在，且后台任务持久化 `workspacePath` 为 Windows 绝对路径。

## Verification

实现后至少运行：

- `pnpm test -- tests/main/background-task-schema.test.ts`
- `pnpm test -- tests/shared/background-task-contract.test.ts`
- `pnpm test -- tests/main/deep-agent-prompt.test.ts`
- `pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts`
- `pnpm test -- tests/main/plugins/agent/runtime.test.ts`

如果修改 backend route 或 smoke fixture，再运行对应 smoke fixture 测试。
