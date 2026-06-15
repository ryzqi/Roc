# Background Task Workbench Isolation Design

## Goal

把后台任务能力收口到任务工作台。普通聊天不再暴露、注册或可达后台任务的创建、修改、取消、查看能力；只有用户通过任务工作台进入时，才允许创建或修改后台任务。与此同时，任务工作台必须能直接观测调度器和任务运行状态，失败时默认暂停并显眼提示。

## Current Facts

- 后台任务相关能力已经存在于 `src/main/plugins/task/index.ts`、`src/main/services/deep-agent/background-task-tools.ts`、`src/shared/background-task-tool-contract.ts`。
- 任务工作台 UI 已经有任务表格、状态栏、详情抽屉和新建对话框，主要在 `src/renderer/views/tasks/TasksView.tsx`、`TaskDetailDrawer.tsx`、`TaskRow.tsx`、`TaskCreateDialog.tsx`。
- 当前 `TasksView` 里已经显示 `SchedulerStatus` 的运行状态、注册数量和下一次触发。
- 当前任务插件已经暴露 `task.snapshot.get`、`task.scheduler.status`、`task.detail.get`、`task.scheduledRuns.list` 和相关后台任务能力。
- 当前 `TaskScheduler` 已经能返回运行状态、最近 skipped 数、最后错误，并支持注册、注销、挂起和恢复。

## Requirements

- 普通聊天中不可创建、修改、取消、查看后台任务。
- 只有任务工作台上下文可以触发后台任务相关能力。
- 服务端必须做二次校验，不能只依赖前端隐藏。
- 任务工作台必须清晰展示调度器状态、任务最近运行、计划运行和失败原因。
- 后台任务失败后默认暂停，暂停结果要立即进入任务状态和事件流。
- 不增加新配置开关，不保留兼容入口，不新增普通聊天里的替代草稿流。

## Recommended Design

### 1. 入口隔离

把后台任务能力从普通聊天路径中移除，只在任务工作台会话中注入：

- `resolve_background_task_time`
- `propose_background_task`
- `schedule_background_task`
- `read_background_task`
- `update_background_task`
- `cancel_background_task`

任务工作台打开任务线程时，附带明确的工作台来源标记和 `workflowHint`。这个来源标记不是 UI 装饰，而是后端校验条件。

服务端在任务工具入口处再次验证来源。没有任务工作台上下文的请求，一律拒绝创建、修改、取消或读取后台任务。这样即使普通聊天侧误带了 `workflowHint`，也不能绕过边界。

### 2. 工作台可观测状态

任务工作台增加一个固定的状态区，显示：

- 调度器是否运行
- 当前注册任务数
- 下一次触发时间
- 近 24 小时 skipped 数
- 最后错误信息

任务详情抽屉继续显示单任务粒度的信息：

- 当前状态
- 最近运行结果
- 最近事件
- 计划运行列表
- 是否已注册到调度器

列表层只保留快速扫描信息，详情层负责解释为什么停了、为什么失败、什么时候会再跑。

### 3. 失败处理

后台任务执行失败后默认进入暂停状态，不自动重试当前任务。失败结果要同时写入：

- 任务状态
- 最近运行状态
- 任务事件流
- 工作台错误提示

恢复必须由用户在任务工作台显式触发。这样任务失败时不会默默继续跑，也不会在普通聊天里偷偷恢复。

## Architecture

### Main process

任务插件继续作为唯一后端事实来源，调度器继续负责执行和注册。需要新增一个“工作台来源校验”边界，放在任务相关 capability 的注册或调用入口处，而不是散落在 UI 或 prompt 中。

### Renderer

任务工作台继续复用现有 `TasksView`、`TaskDetailDrawer`、`TaskRow` 和 `TaskCreateDialog`，只补状态呈现和必要的入口约束。普通聊天页面不再展示后台任务相关按钮、提示或能力卡片。

### Shared contract

共享类型继续作为状态展示和 IPC 的源头。`SchedulerStatus`、`TaskDetail`、`ScheduledTaskRun`、`TaskSnapshot` 仍然是工作台 UI 的基础数据形态。

## Data Flow

1. 用户在任务工作台打开任务列表。
2. 工作台向后端拉取 `task.snapshot.get`、`task.scheduler.status`、`task.detail.get`、`task.scheduledRuns.list`。
3. 后端只在工作台上下文中允许后台任务工具调用。
4. 用户在工作台提交新建或编辑请求。
5. 后端校验来源，预览或落库。
6. 调度器注册或刷新任务。
7. 任务运行失败时，仓库写入失败状态并暂停，工作台刷新后直接看到失败原因。

## Alternatives Considered

### A. 只靠前端隐藏

实现最省，但不满足“只有任务工作台才能创建/修改任务”的硬约束。只要后端能力仍可达，就不算真正隔离。

### B. 只靠 prompt 约束

更弱。它只能降低误用概率，不能防止普通聊天路径通过工具调用、补偿逻辑或未来回归重新暴露能力。

### C. 独立后台任务代理

边界最干净，但会把已有任务插件、调度器、工作台和审批链路拆成另一套系统。当前需求不需要换架构，成本过高。

## Testing Plan

- 普通聊天路径测试：不再暴露后台任务相关工具或能力卡片。
- 工作台路径测试：只有任务工作台来源能调用 `create / update / cancel / read`。
- 调度器状态测试：`SchedulerStatus` 在运行、注册数、下一次触发、最后错误上都能正确输出。
- 失败测试：后台任务失败后进入暂停，并留下可见事件和状态。
- UI 测试：任务工作台顶部状态区和详情抽屉能展示调度器与任务运行信息。

## Verification

实现后至少验证：

```powershell
pnpm typecheck
pnpm test -- tests/main/plugins/task/plugin.test.ts tests/main/plugins/task/scheduler.test.ts tests/renderer/tasks-view.test.ts tests/renderer/task-detail-drawer.test.ts
```

如果改到任务工作台状态展示，再补一次相关 smoke 或 renderer 交互测试。

## Boundaries

- 不改普通聊天里的其他业务流程。
- 不新增任务能力的兼容入口。
- 不引入新的配置开关。
- 不重写任务调度器，只改边界和观测。
- 不扩展到其他插件或其他工作流。

## Risks

- 如果工作台来源校验只放在 renderer，后端仍可能被绕过。
- 如果失败暂停只改 UI，不写仓库和事件流，工作台会出现假状态。
- 如果把“查看任务”也放回普通聊天，边界会再次变软。

## Implementation Order

1. 给任务能力加工作台来源校验。
2. 收紧普通聊天能力注入和提示词。
3. 在任务工作台补调度器状态区和失败提示。
4. 让失败任务默认暂停并写事件流。
5. 补测试和回归验证。
