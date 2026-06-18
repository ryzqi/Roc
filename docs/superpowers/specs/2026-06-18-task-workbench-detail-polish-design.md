# 任务工作台与任务详情页美化设计

## Current State

任务工作台和任务详情页已经具备完整流程：创建后台任务、按列查看任务、打开详情、返回工作台、继续任务、处理审批，以及对后台任务执行暂停、恢复、立即运行、取消、删除。当前 UI 偏基础骨架：工作台卡片只展示目标、状态、工作区；详情页只按顺序展示返回按钮、标题状态、对话记录、继续输入和动作按钮。信息存在，但层级弱，两个页面不像同一套任务控制台。

## Goal

把任务工作台和任务详情页统一成克制、清晰的结构化任务控制台。改动只发生在 renderer UI 层，目标是改善现有信息的扫描效率、视觉层级和操作区秩序。

## Scope

改动范围：

- `src/renderer/views/tasks/TasksView.tsx`
- `src/renderer/views/tasks/TaskBoardColumn.tsx`
- `src/renderer/views/tasks/TaskBoardCard.tsx`
- `src/renderer/views/tasks/TaskDetailView.tsx`
- 任务页相关 CSS

不做：

- 不新增搜索、筛选、排序、统计摘要。
- 不新增业务字段展示。
- 不修改共享类型、IPC、后台任务合同、任务创建或调度逻辑。
- 不修改任务按钮行为、打开详情流程、返回流程、审批流程。
- 不提交 `.superpowers/brainstorm` 下的临时视觉草图。

## Design Direction

采用“结构化控制台”方向。工作台保留当前 4 列，详情页保留当前业务结构。通过少量 JSX wrapper 和 CSS class 让列头、任务卡片、详情头、记录区、输入区、动作区共享同一套视觉语言。

视觉原则：

- 保持 Roc 现有克制桌面应用风格。
- 不使用营销式 hero、重装饰背景或高对比大卡片。
- 卡片半径、边线、hover 和 focus 状态沿用现有 token。
- 文字层级服务扫描，不扩大字号制造“页面感”。
- 长任务目标和长工作区路径必须能换行，不撑破列宽。

## Task Workbench

工作台继续使用 4 个 lane：待处理、进行中、已暂停、已结束。每个 lane 是一个轻量控制台面板。

列头：

- 左侧显示现有标题。
- 右侧显示数量 pill。
- 列头下方用轻分隔线强化分组。

任务卡片：

- 仍只展示 `goal`、`status`、`workspacePath`。
- `status` 从普通文本改为小型状态 pill。
- `goal` 作为主标题，允许换行。
- `workspacePath` 作为低权重路径行，允许断行。
- hover/focus 只强化边线和浅底色，不引入重阴影。

空状态：

- 保留“暂无任务”、新建按钮和辅助说明。
- 容器改成克制空面板，和工作台视觉一致。

响应式：

- 桌面端保留 4 列。
- 窄宽度沿用单列堆叠，列和按钮不重叠。

## Task Detail

详情页继续展示返回按钮、任务标题、状态、对话记录、等待用户时的继续输入区，以及后台任务动作按钮。

页面头：

- 返回按钮在左侧。
- 标题和状态形成清晰层级。
- 任务不存在状态复用同一页面壳。

记录区：

- `ChatTranscriptPanel` 内部行为不改。
- 外层放入统一主内容面板，减少散落感。

继续输入：

- 只在 `waiting_user` 时显示。
- textarea 保持稳定高度。
- 提交按钮仍叫“继续任务”。
- 可增加 placeholder，但不改变提交校验。

动作区：

- 保留现有动作集合和触发函数。
- 调整为低权重工具条，按钮间距和换行更稳定。
- 不重新定义危险动作语义。

保留测试入口：

- `task-detail-view`
- `task-detail-followup-input`
- `task-detail-followup-submit`
- `task-detail-actions`

## Data And Behavior

本设计不引入新数据流。`TasksView` 继续从 `state.activeTasks` 构建 lanes。`TaskDetailView` 继续从 `state.taskDetail` 和 `liveTaskRun` 构建 transcript 与动作入口。

不使用默认值隐藏关键字段。当前 UI 已允许 `workspacePath` 为空时显示“无工作区”，该行为保持不变。

## Acceptance Criteria

- 任务工作台仍能展示 4 个 lane 和已有任务。
- 任务卡片点击仍打开对应详情。
- 返回按钮仍回到任务工作台。
- 等待用户状态下仍能输入并提交继续内容。
- 审批决策仍通过原有回调提交。
- 后台任务动作按钮仍调用原有 `taskActions`。
- 桌面和窄宽度下没有文字重叠、按钮溢出或列撑破。
- 相关测试 id 保持可用。

## Verification

直接验证：

```powershell
pnpm test -- tests/renderer/tasks-view.test.ts tests/renderer/tasks-view.interaction.test.ts tests/renderer/task-detail-view.test.tsx
pnpm typecheck
```

视觉验证：

```powershell
pnpm dev
```

检查任务工作台和任务详情页的桌面布局、窄宽度堆叠、详情头、按钮换行、长文本断行。

不需要：

- 不跑 `pnpm generate:ipc`，因为不改 IPC 合同。
- 不跑 `pnpm package:dir`，因为不改打包、native 依赖或启动路径。
- 不默认跑全量 smoke，除非实现阶段触及导航、IPC 或任务动作流程。
