# Chat Streaming Performance Design

## Goal

修复聊天页面渲染流式输出时卡顿的问题。范围限定在聊天流式输出性能链路：事件聚合、状态更新、transcript 构建、Markdown 渲染、长消息列表渲染和对应测试。不得更改样式文件、视觉设计、布局语义或无关业务逻辑。

## Current Facts

- 流式事件入口在 `src/renderer/chat/use-chat-run.ts`，当前已用 `requestAnimationFrame` 合并事件，但每帧仍会触发 React state 更新。
- `src/renderer/chat-run-state.ts` 对 text 和 reasoning block 使用逐事件字符串拼接；长输出会产生累积复制成本。
- `src/renderer/chat/chat-view.tsx` 使用 `useDeferredValue`，但 `useMemo` 依赖整个 `chatRun.state`，state 每帧变更会重新构建 transcript。
- `src/renderer/chat-transcript.ts` 每次构建都会过滤、排序并重新创建消息对象，旧消息引用不稳定，会削弱 `ChatMessageRow` 的 memo 效果。
- `src/renderer/chat/markdown-view.tsx` 使用 `react-markdown`、`remark-gfm`、`rehype-highlight`；live assistant 内容每帧增长时会反复解析整段文本。
- `src/renderer/chat/chat-transcript-panel.tsx` 自动滚动 effect 依赖 `messages` 和 `liveSignal`，流式期间每次新消息数组引用都会触发测量和滚动调度。

## Acceptance Criteria

- 5,000 个 text chunk 合并处理后，assistant 内容正确且更新次数低于逐 chunk 更新。
- 流式输出期间 composer 输入保持可响应，非紧急渲染不得阻塞输入路径。
- live assistant Markdown 不再在每帧通过 `react-markdown + rehype-highlight` 解析完整增长文本。
- persisted 历史消息在 live chunk 到达时保持稳定引用，未变化的消息行不重渲染。
- 自动跟随滚动只在 live 信号变化和用户接近底部时执行，不因 transcript 数组新引用重复触发。
- 长历史会话可通过虚拟列表渲染，不一次性挂载所有消息 DOM。
- 不修改 `src/renderer/styles/**` 或其他样式文件。
- 验证命令至少包括 `pnpm typecheck` 和聊天相关 renderer 测试。

## Recommended Approach

采用分阶段主方案：先收敛热路径，再替换 live Markdown，再引入消息列表虚拟化。

### Phase 1: Event And State Hot Path

新增批处理 helper，把同一帧内连续 `assistant_block` text delta 合并成单个 delta，把同一 reasoning block 的连续 delta 合并成单个 delta。`applyChatRunEventBatch` 继续作为测试入口，但先归并事件再 reduce。

在 `useChatRun` 的 `flush` 中用 `startTransition` 包裹非紧急 `setState`，让流式 token 渲染可被输入、点击、滚动等紧急交互打断。错误消息和 terminal event 仍同步处理，避免状态终止延迟。

保持现有合同：`assistantMessage` 最终字符串不变，reasoning/tool/subagent/approval 行为不变，未知 runId 事件仍被忽略。

### Phase 2: Transcript Construction

把 persisted transcript 和 live transcript 分开计算：

- persisted 部分只依赖 `activeThreadId`、`persistedMessages`、promoted thread ids。
- live 部分只依赖必要字段：`runId`、`threadId`、`status`、deferred assistant content、deferred activity blocks、pending approvals、subagents。
- 不再让 `chatTranscript` 的 `useMemo` 依赖完整 `chatRun.state`。

给 live block 构建使用 Map/单次循环替代反复扫描。旧消息对象引用必须尽量稳定，确保 `ChatMessageRow` 对未变化历史消息直接跳过重渲染。

### Phase 3: Live Markdown Renderer

引入 `streamdown@2.5.0` 专用于 live assistant 内容。新增一个小边界组件，例如 `StreamingMarkdownView`：

- `isStreaming === true` 时使用 `streamdown` 渲染。
- `isStreaming === false` 时保持现有 `MarkdownView` 或在确认输出一致后统一迁移。
- 代码块高亮在 live 阶段延后或使用 streamdown 默认能力；完成后再走现有静态 Markdown 渲染，避免每 token 触发 highlight。

`MarkdownView` 保持现有对 task 输出、guardrail、completed chat 的兼容。此阶段不更改样式类名和 DOM 外层语义，避免视觉回归。

### Phase 4: Message List Virtualization

引入 `react-virtuoso@4.18.7` 作为消息列表虚拟化实现。选择它而不是手写虚拟滚动，因为聊天消息高度动态、Markdown/代码块高度不可预估，且需要底部跟随语义。

`ChatTranscriptPanel` 保留当前 props 语义，但内部把 `messages.map` 替换为 Virtuoso 渲染通道。滚动到底部按钮、用户手动上滚后暂停自动跟随、审批回调等行为保持一致。

如果虚拟化接入破坏现有滚动测试或 DOM 查询，可先把虚拟化放到独立组件，并保留非虚拟列表作为测试夹具；运行时默认使用虚拟化。不新增用户可见配置开关。

## Alternatives Considered

### Conservative No-Dependency Plan

只做事件合并、memo 依赖收敛和 transcript 缓存。不增加依赖，风险低，但长 Markdown 仍会在流式期间重复全量解析，无法解决最重路径。

### Headless Virtualization With `@tanstack/react-virtual`

`@tanstack/react-virtual` 更轻、更可控，但聊天动态高度、底部跟随、尺寸变化和滚动恢复需要自行实现。当前目标是修性能，不是重写滚动系统，因此不作为首选。

### Full Chat UI Replacement

参考 `assistant-ui` 等完整 AI chat UI 项目，但整体替换会触及组件结构、样式和交互，不符合“不得更改样式等其余代码”的约束。

## Testing Plan

- 新增 `applyChatRunEventBatch` 测试：连续 text chunk 和 reasoning chunk 被合并后结果一致。
- 新增 transcript 稳定性测试：live 内容变化时历史消息对象引用保持不变。
- 新增 renderer 测试：streaming 状态使用 live Markdown 渲染边界，completed 状态仍可走静态 Markdown。
- 扩展滚动测试：auto-follow 不因 `messages` 新引用重复触发。
- 新增或扩展 smoke performance 脚本：模拟长流式输出，采集渲染次数、long task 或完成时间证据。

## Verification Commands

```powershell
pnpm typecheck
pnpm test -- tests/renderer/use-chat-run.test.ts tests/renderer/chat-run-state.test.ts tests/renderer/chat-transcript.test.ts tests/renderer/chat-view.test.ts tests/renderer/chat-message-row.test.ts
pnpm smoke:performance
```

## Boundaries

- 不修改 `src/renderer/styles/**`。
- 不调整视觉布局、文案、颜色、间距、动画曲线。
- 不改变 IPC 合同。
- 不改变 main/preload 边界。
- 不新增性能配置开关。
- 不处理非聊天页面性能问题。

## Risks

- `streamdown` 与当前 `react-markdown` 的 HTML 结构可能不完全一致。缓解方式：只在 live 阶段使用，完成后回到现有静态渲染。
- `react-virtuoso` 会改变消息 DOM 挂载数量，部分测试可能依赖全量 DOM。缓解方式：更新测试断言到用户可见行为，不依赖离屏消息同时存在。
- `startTransition` 可能让测试中的 state 更新时序变化。缓解方式：用现有 async testing pattern 等待可观察结果，而不是假设同步 commit。

## Implementation Order

1. 添加性能回归测试，先证明当前热路径问题。
2. 实现同帧事件归并和 transition 更新。
3. 拆分 persisted/live transcript memo，稳定历史消息引用。
4. 引入 `streamdown` 并只接 live assistant 渲染。
5. 引入 `react-virtuoso`，替换 transcript list 内部渲染。
6. 跑类型检查、renderer 测试和 performance smoke。
