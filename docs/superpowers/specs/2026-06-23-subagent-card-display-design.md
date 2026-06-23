# 子代理卡片展示设计

## Current State

Roc 前端已经把子代理事件投影为结构化 transcript block：

- `ChatTranscriptActivityBlock.kind === 'subagent'`
- 子代理 block 包含 `identity`、`status`、`summary`、`error`、内部 `blocks` 和嵌套 `children`
- 内部 block 已支持 `text`、`reasoning`、`tool_call`

当前展示短板在 renderer 层：`SubagentActivityView` 仍是旧式内联 `details`，不像 Codex desktop 那样把子代理表达为一个独立 work item。

## Goal

只重做子代理块的前端展示，让它成为 Codex-style 独立工作卡片。

设计目标：

- 子代理看起来是一个独立执行单元，而不是普通折叠日志。
- 正常执行记录保持克制，不淹没主对话。
- 失败时自动暴露关键证据，方便排障。
- 复用现有 transcript 数据和内部 block 渲染能力。

## Scope

只改 renderer 展示层。

计划涉及：

- `src/renderer/chat/chat-message-row.tsx` 中的子代理展示组件
- 子代理展示所需的 renderer 样式
- 相关 renderer 测试

不涉及：

- 不改 `src/renderer/chat-transcript.ts`
- 不改 `SubagentEventPayload`
- 不改 main/shared 事件 contract
- 不增加子代理状态字段
- 不显示 `identity.taskInput` 任务摘要
- 不做侧栏、全局子代理面板或 task detail 布局重构

## Chosen Direction

采用 Codex-style 独立工作卡片。

默认展开规则：

- `failed` 默认展开
- 其他状态默认收起

该方案比运行中展开更稳定，不会在 streaming 期间频繁撑开 transcript；比始终半展开更克制，更适合聊天页和任务详情页共用。

## Card Structure

Header 显示：

- 子代理身份：`Subagent · general-purpose` 或 `Subagent · research`
- 状态 badge
- 展开箭头

Header 不显示任务摘要，不读取或展示 `identity.taskInput`。

Meta 区只显示结构性信息：

- `sync` 或 `async`
- 工具调用数量，例如 `2 tools`
- 子代理数量，例如 `1 child`
- 是否包含 reasoning，例如 `reasoning`

没有对应内容时不显示对应 chip。

## Status Labels

底层 status 不变，UI 显示中文：

- `started` -> `开始`
- `running` -> `运行中`
- `completed` -> `完成`
- `failed` -> `失败`
- `cancelled` -> `已取消`

失败状态使用更明显的 badge、状态点和 error 区域，但不使用大面积红色背景。

## Expanded Content

展开区按现有数据渲染：

1. `error`
2. `summary`
3. 内部 `text`
4. 内部 `reasoning`
5. 内部 `tool_call`
6. 嵌套 `children`

内部渲染复用现有组件：

- `StreamingMarkdownView`
- `ReasoningBlock`
- `ToolCallView`

嵌套子代理递归使用同款小卡片。子卡通过缩进和更浅背景表达层级，避免厚重的卡片套卡片效果。

## Component Boundary

子代理展示可以从 `chat-message-row.tsx` 中拆出小组件，但仍由 `ChatActivityBlockView` 调用。

组件只接收现有 `Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }>` 数据，不派生新的 transcript model。

展开状态使用现有 `useActivityBlockState` 模式：

- `defaultOpen: block.status === 'failed'`
- 不需要运行中强制展开

## Error Handling

展示层不吞掉状态，也不伪造状态。

如果没有 `summary`、`error`、内部 blocks 或 children，卡片仍显示 header 和可用 meta。缺失信息不显示占位文案。

## Testing

更新 renderer 测试，重点覆盖真实展示行为：

- `chat-activity-subagent` 仍存在
- 失败状态默认展开
- 状态中文标签可见
- 内部 text/error 可见
- children 能递归渲染
- meta chips 能显示工具数、子代理数或 execution 类型

目标测试：

- `pnpm test -- tests/renderer/chat-message-row.test.ts`

如果实现只改组件和 CSS，该目标测试是直接验收；实现完成后再根据实际改动决定是否补跑 `pnpm typecheck`。
