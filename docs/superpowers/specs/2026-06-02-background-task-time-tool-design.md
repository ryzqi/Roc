# Background Task Time Tool Design

## Goal

任务工作台的"新建任务"入口继续走现有 `workflowHint: 'propose_background_task'` 合同，但创建后台任务前必须先经过后台任务专用 one-shot 指引和时间解析工具。后台任务通常带时间条件，模型不应直接凭上下文猜 `once` / `cron` 的 `nextRunAt`。

本设计新增一个主进程内置工具 `resolve_background_task_time`，用于把用户的自然语言时间表达解析成可用于 `propose_background_task` 的 trigger 候选。该工具只做解析和校验，不创建任务。

## Current Flow

当前任务工作台创建链路如下：

1. `TaskCreateDialog` 收集自然语言描述。
2. `TasksView.submitTaskDescription` 读取当前 workspace，并提交：
   - `input: description`
   - `workflowHint: 'propose_background_task'`
   - `workspacePath`
3. `App.queueTaskPrompt` 清空选中会话，切到 chat，隐藏 workbench，并保存 queued prompt。
4. `ChatView` 在 agent ready 后自动调用 `onSubmitChatTask`。
5. `DeepAgentRuntimeService.startRun` 创建 task run，并把 `workflowHint` 传入 deep-agent session。
6. `prompt.createWorkflowOverview` 只追加简短 workflow overview。
7. 模型直接调用 `propose_background_task` / `schedule_background_task` / `confirm_with_user`。

缺口：系统提示没有 one-shot 示例，工具集中没有可被模型调用的时间解析工具，`propose_background_task` 的 `nextRunAt` 由模型直接生成。

## Non-Goals

- 不恢复 `buildTaskProposalPrompt` 作为 renderer 输入包装器。
- 不把任务创建弹窗改成时间表单。
- 不引入新的用户配置开关。
- 不修改后台任务存储表结构。
- 不让时间工具创建、更新或调度后台任务。
- 不支持任意复杂自然语言时间解析；超出明确模式时要求澄清。

## Chosen Approach

采用 workflow-local 方案：

1. 在 deep-agent 工具集中新增 `resolve_background_task_time`。
2. 在 `workflowHint === 'propose_background_task'` 的系统提示中加入 one-shot 示例。
3. 在 forge guardrails 中把创建后台任务主路径 workflow 更新为：
   - `resolve_background_task_time`
   - `propose_background_task`
   - `schedule_background_task`
   - `confirm_with_user`
4. 增加 prerequisite：`propose_background_task` 必须先完成 `resolve_background_task_time`。
5. 增加时间澄清分支：当 `resolve_background_task_time` 返回 `needs_clarification` 时，允许 `confirm_with_user` 结束本轮并向用户询问缺失时间信息；该分支不创建后台任务。

这样既满足"后台任务前面要有专用提示词"和"使用 one-shot"，也保留当前 renderer 直接传用户原话的合同。

## Tool Contract

工具名：`resolve_background_task_time`

模型可见输入：

```ts
{
  text: string
}
```

工具由 runtime 内部读取：

- 当前 UTC 时间。
- 当前本机时区。
- 当前本机本地时间。

工具输出：

```ts
type ResolveBackgroundTaskTimeResult =
  | {
      status: 'resolved';
      trigger: BackgroundTaskTrigger;
      reference: {
        nowUtc: string;
        nowLocal: string;
        timeZone: string;
      };
      confidence: 'high' | 'medium';
      notes: string[];
    }
  | {
      status: 'needs_clarification';
      reference: {
        nowUtc: string;
        nowLocal: string;
        timeZone: string;
      };
      clarificationQuestion: string;
      notes: string[];
    };
```

`BackgroundTaskTrigger` 沿用现有后台任务 schema：

- `manual`: 无明确时间表达，或用户明确要求手动触发。
- `once`: 一次性触发，必须返回 UTC ISO `nextRunAt`。
- `cron`: 周期触发，必须返回五段 `cronExpression` 和 UTC ISO `nextRunAt`。

## Supported Time Patterns

首版只支持可稳定测试的中文常见模式：

- `N 分钟后`、`N 小时后`。
- `今天 HH:mm`、`明天 HH:mm`。
- `YYYY-MM-DD HH:mm`。
- `每天 HH:mm`。
- `每周一 HH:mm` 到 `每周日 HH:mm`。
- `每月 D 日 HH:mm`。

解析规则：

- `cronExpression` 按本机时区执行。
- `nextRunAt` 必须是 UTC ISO，含 `T` 和 `Z`。
- 一次性时间如果早于当前时间，返回 `needs_clarification`。
- 周期时间的 `nextRunAt` 是下一个未来触发点。
- 有明确时间意图但无法解析时，返回 `needs_clarification`，不降级为 `manual`。
- 没有时间意图时，返回 `manual` trigger，并在 notes 中说明。

## One-Shot Prompt

`prompt.createWorkflowOverview('propose_background_task')` 从简短 overview 扩展为工作流说明和 one-shot。

必要内容：

- 本轮是创建后台任务。
- 后台任务创建前先调用 `resolve_background_task_time`。
- 用该工具返回的 trigger 组装 `propose_background_task`。
- `propose_background_task` 只生成 preview。
- `schedule_background_task` 才实际创建并注册调度。
- `confirm_with_user` 最后告知用户结果。

one-shot 示例必须展示完整顺序，但不把用户当前输入包装成新的 renderer prompt。

示例语义：

用户：`每天 9:00 检查测试失败情况`

工具顺序：

1. `resolve_background_task_time({ text: '每天 9:00 检查测试失败情况' })`
2. `propose_background_task({ goal, trigger: resolved.trigger, workspacePath })`
3. `schedule_background_task({ previewId })`
4. `confirm_with_user({ summary })`

## Guardrails

更新 `ROC_WORKFLOWS.propose_background_task`：

```ts
{
  name: 'propose_background_task',
  requiredSteps: [
    'resolve_background_task_time',
    'propose_background_task',
    'schedule_background_task'
  ],
  terminalTools: ['confirm_with_user']
}
```

更新 `ROC_PREREQUISITES`：

```ts
{
  propose_background_task: [
    { kind: 'nameOnly', tool: 'resolve_background_task_time' }
  ],
  schedule_background_task: [
    { kind: 'nameOnly', tool: 'propose_background_task' }
  ]
}
```

如果模型跳过时间解析直接调用 `propose_background_task`，prerequisite nudge 把它送回模型；如果模型提前 `confirm_with_user`，step enforcement 阻止结束。

### Clarification Branch

`resolve_background_task_time` 的成功工具结果由 step enforcement 记录一个时间解析状态：

```ts
backgroundTaskTimeResolution: 'resolved' | 'needs_clarification' | null
```

当该状态为 `needs_clarification` 时，`confirm_with_user` 可作为合法 terminal tool，即使 `propose_background_task` / `schedule_background_task` 尚未完成。`confirm_with_user` 的内容必须是澄清问题，不得声称任务已创建。

当该状态为 `resolved` 或 `null` 时，沿用主路径规则：`confirm_with_user` 必须等 `resolve_background_task_time`、`propose_background_task`、`schedule_background_task` 全部完成后才能调用。

## Data Flow

1. Renderer 仍传原始用户描述和 `workflowHint: 'propose_background_task'`。
2. Runtime 建立 task run，session 注册所有内置工具。
3. System prompt 注入 one-shot。
4. Forge step tracker 初始化 required steps。
5. 模型调用 `resolve_background_task_time`。
6. 工具返回 trigger 或澄清问题。
7. `resolved` 时，模型调用 `propose_background_task`。
8. `needs_clarification` 时，模型调用 `confirm_with_user` 请求用户补充；step enforcement 通过 clarification branch 放行该终止路径。
9. preview 成功后，模型调用 `schedule_background_task`。
10. 创建成功后，模型调用 `confirm_with_user` 总结。

## Error Handling

- 本机时区无法读取：工具抛 `RocDomainError`，提示用户检查系统时间设置。
- 输入为空：工具 schema 拒绝。
- 时间格式不支持：返回 `needs_clarification`，不抛错。
- 一次性时间已过期：返回 `needs_clarification`，不生成过期 `nextRunAt`。
- 周期表达可解析但无法计算下次运行：返回 `needs_clarification`。
- `propose_background_task` 收到无效 trigger：保持现有 schema 错误映射。

## Files

预计实现触点：

- `src/main/services/deep-agent/background-task-time-tool.ts`：新增解析工具与 parser。
- `src/main/services/deep-agent/session.ts`：注册 `resolve_background_task_time`。
- `src/main/services/deep-agent/prompt.ts`：新增 one-shot workflow prompt。
- `src/main/services/forge-guardrails/prerequisites-config.ts`：更新 required steps 和 prerequisites。
- `src/main/services/forge-guardrails/middleware/step-enforcement.ts`：记录时间解析状态，并放行合法澄清分支。
- `src/main/services/agent-service.ts`：工具卡增加 `resolve_background_task_time`。
- `tests/main/background-task-time-tool.test.ts`：新增 parser/tool 单测。
- `tests/main/deep-agent-prompt.test.ts`：覆盖 one-shot。
- `tests/main/services/forge-guardrails/prerequisites-config.test.ts`：覆盖工作流顺序。
- `tests/main/services/forge-guardrails/middleware/step-enforcement.test.ts`：覆盖澄清分支和提前完成阻断。
- `tests/main/app-services.provider.test.ts`：覆盖工具卡。
- `tests/main/deep-agent-runtime-service.test.ts`：覆盖工具注册或稳定 descriptors。

## Acceptance Criteria

- 从任务工作台创建后台任务时，renderer 仍传原始描述和 `workflowHint: 'propose_background_task'`。
- `resolve_background_task_time` 在 task run 工具集中可用。
- 创建后台任务 workflow 的 required steps 包含 `resolve_background_task_time`。
- 模型跳过时间工具时会收到 prerequisite nudge。
- 时间工具返回 `needs_clarification` 时，模型可以用 `confirm_with_user` 询问用户补充时间，且不会创建任务。
- 时间工具未返回 `needs_clarification` 时，提前 `confirm_with_user` 仍会被 step enforcement 阻断。
- one-shot prompt 明确展示时间解析到 propose/schedule/confirm 的顺序。
- 常见一次性和周期中文时间表达能解析为现有 trigger schema。
- 歧义、过期和不支持时间表达不会生成错误的 `nextRunAt`。
- 现有 `propose_background_task` schema 仍禁止 runtime-only 字段。
- 现有 `buildTaskProposalPrompt` 保持 deprecated，不成为新代码路径。

## Verification Plan

最小直接验证：

```powershell
pnpm vitest run tests/main/background-task-time-tool.test.ts tests/main/deep-agent-prompt.test.ts tests/main/services/forge-guardrails/prerequisites-config.test.ts
```

中等范围验证：

```powershell
pnpm vitest run tests/main/app-services.provider.test.ts tests/main/deep-agent-runtime-service.test.ts tests/main/background-task-tools.test.ts
```

最终实现完成后，按 Roc 桌面验收补跑：

```powershell
pnpm typecheck
pnpm package:dir
```

packaged smoke 是否需要新增用例，由实现阶段根据实际风险决定；如果工具顺序影响 packaged provider fixture，应补 smoke fixture。
