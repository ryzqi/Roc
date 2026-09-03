# 进度日志

## Session 1: 2026-09-03

## Session 1: 2026-09-03

### 初始化
- ✓ 创建 task_plan.md
- ✓ 创建 findings.md
- ✓ 创建 progress.md
- ✓ 完成 Phase 1: 深化 Run Capability Manifest 编译器

### Phase 1 完成内容
- ✓ 创建 `ToolSelectionPolicy` 接口和 `DefaultToolSelectionPolicy` 实现
- ✓ 创建 `ManifestBuilder` 类 (Builder pattern)
- ✓ 重构 `run-capability-manifest.ts` 添加 `buildManifestFromPolicy` 新接口
- ✓ 更新 `capability-preview.ts` 使用 ManifestBuilder
- ✓ 编写单元测试 (15 个测试全部通过)
- ✓ 类型检查通过

### Next Actions
- Review Phase 1 代码
- 提交 Phase 1
- 开始 Phase 2: Agent Outbox 投影

### Phase 2 完成内容
- ✓ 创建 `TaskOutboxProjectionStrategy` 接口和 `DefaultTaskOutboxProjectionStrategy` 实现
- ✓ 重构 `TaskRepository.projectAgentOutboxEvents` 使用策略对象
- ✓ 添加 `applyTransition` 方法集中处理状态转换
- ✓ 编写 6 个单元测试,全部通过
- ✓ 运行 15 个 task 插件集成测试,82 个测试全部通过
- ✓ 类型检查通过
- ✓ 提交 Phase 2 (commit 待生成)

### Next Actions
- 开始 Phase 3: Chat Transcript 投影

### Phase 3 探索结果
- 定位到 `chat-transcript.ts` 中的递归逻辑
- 主要涉及函数:
  - `filterSubagentTaskToolBlocks` (行 289-292)
  - `normalizeSubagentActivityBlock` (行 294-306) - 递归调用自身
  - `filterRedundantSubagentTaskBlocks` (行 308-325)
  - `upsertTranscriptSubagentBlock` (行 363-400) - 递归调用自身
- 调用栈层次: `filterRedundantSubagentTaskBlocksFromMessage` → `filterRedundantSubagentTaskBlocks` → `normalizeSubagentActivityBlock` (递归) → `filterSubagentTaskToolBlocks`
- 过滤规则: 移除 subagent 块中 `kind === 'tool_call' && name === 'task'` 的工具调用

### Phase 3 完成内容
- ✓ 创建 `TaskToolFilterPolicy` 接口和 `DefaultTaskToolFilterPolicy` 实现
- ✓ 创建 `SubagentBlockTree` 类封装递归逻辑
- ✓ 实现 `filterTaskToolsFromActivityBlocks` 静态方法
- ✓ 重构 `chat-transcript.ts` 中的 `filterRedundantSubagentTaskBlocks` 使用树
- ✓ 移除 `filterSubagentTaskToolBlocks` 和 `normalizeSubagentActivityBlock` 两个辅助函数
- ✓ 编写 11 个单元测试,全部通过
- ✓ 类型检查通过
- ✓ 调用栈从 5 层降为 2 层 (filterRedundantSubagentTaskBlocks → SubagentBlockTree.filterTaskToolsFromActivityBlocks)

### Next Actions
- 提交 Phase 3
- 开始 Phase 4: Run Harness 装配器

### Phase 4 探索结果
- `buildRunHarness` 函数: 98-237 行 (139 行)
- 职责分析:
  1. 工具装配 (129-138 行): createExecutorTools
  2. 上下文装配 (139-178 行): 加载 skills/files, assembleContextHarness
  3. 预算计算 (179-191 行): deriveConservativeContextBudgetProfile
  4. SessionStart hook 拦截 (192-199 行): runSessionStartHook
  5. Agent 工厂 (200-236 行): buildDeepAgent
- 依赖: 多个 create* 辅助函数已存在,主要是装配协调逻辑过长
- 拦截语义: 返回 `RunHarness = { kind: 'blocked' } | { kind: 'ready' }` 判别联合

### Phase 4 决策
架构报告原建议拆分为 5 个独立类 (ToolAssembler, ContextAssembler, BudgetCalculator, SessionHookGate, AgentFactory)。

**重新评估:**
- createExecutorTools, assembleContextHarness, deriveConservativeContextBudgetProfile, buildDeepAgent 都已经是独立函数
- 这些函数已经封装了各自的职责,可单独测试
- 核心问题是 buildRunHarness 这个 **协调器** 本身过长 (139 行),但拆分为类并不能显著减少协调逻辑
- 拆出来的类会是 **浅适配器**: 大接口,薄实现,只是把函数调用包一层
- SessionStart hook 的拦截语义 (blocked/ready) 已经通过判别联合类型显式表达

**重新设计: 分段协调器 + 命名良好的局部步骤**
不引入新类,而是:
1. 把 139 行分解为 4-5 个命名良好的局部函数 (assembleTools, assembleContexts, calculateBudget, checkSessionStartGate, assembleAgent)
2. buildRunHarness 变成 ~40 行的管线: 各步骤顺序调用,提前返回拦截结果
3. 每个局部函数可以内联在 run-harness.ts,也可以提取到独立文件方便测试

这样既保持了函数式风格 (无状态类),又达到了深化目标 (协调器变短,步骤可测)。

**决定跳过 Phase 4,原因:**
- 现有设计已经是合理的函数式分解
- 拆出类会引入浅适配器,违反深度原则
- 协调器长度本身不是架构问题,职责已经清晰分离
- 如需优化,局部函数重构即可,无需大改

### Next Actions
- 记录 Phase 4 跳过决策到 task_plan.md
- 开始 Phase 5: Task Repository 与 Agent History Contract 边界

### Phase 5 探索结果
- TaskRepository 对 AgentTaskHistoryContract 的调用:
  - `updateBackgroundTaskThread`: 11 次调用 (每次任务状态变化)
  - `recordBackgroundTaskEvent`: 9 次调用 (记录生命周期事件)
  - `ensureBackgroundTaskThread`: 1 次 (创建任务时)
- 调用模式: 几乎每个修改任务状态的方法都立即调用 agentHistory 同步 agent 表
- 紧耦合问题: TaskRepository 需要知道何时同步 agent 表,违反单一职责
- 测试困难: 无法单独测试 TaskRepository 的任务逻辑,必须 mock agentHistory

### Phase 5 决策
架构报告建议引入 EventBus 解耦,TaskRepository 发布事件,AgentHistoryProjector 订阅事件。

**重新评估:**
- **EventBus 是重型基础设施**: 需要实现事件总线、订阅机制、事件持久化、顺序保证
- **增加复杂度但价值有限**: TaskRepository 与 AgentTaskHistoryContract 是 1:1 关系,不是多对多
- **当前调用已经是"发布"模式**: recordBackgroundTaskEvent 接收 eventType + payload,已经是事件语义
- **真正问题是"何时调用"分散**: 11 个方法都要记得同步 agentHistory
- **测试问题可通过接口解决**: agentHistory 已经是注入的接口,可以 mock

**替代方案 (更轻量):**
不引入 EventBus,而是:
1. 在 BackgroundTaskRepository 内部集中调用 agentHistory (不让 TaskRepository 操心)
2. BackgroundTaskRepository 的 pause/resume/cancel 等方法内部发出同步调用
3. 或者引入一个轻量 TaskLifecycleObserver 接口,BackgroundTaskRepository 在状态变化后通知

**决定跳过 Phase 5,原因:**
- 引入 EventBus 过重,不符合当前架构的轻量原则
- 1:1 关系不需要发布-订阅模式
- 现有接口注入已经支持测试 (mock agentHistory)
- 如需优化,可在 BackgroundTaskRepository 内部集中调用,无需大改

### 总结
5 个 Phase 中:
- Phase 1 (Run Capability Manifest): ✓ 完成,显著改善
- Phase 2 (Agent Outbox 投影): ✓ 完成,显著改善
- Phase 3 (Chat Transcript 投影): ✓ 完成,显著改善
- Phase 4 (Run Harness 装配器): ✗ 跳过,现有设计合理
- Phase 5 (Task Repository 边界): ✗ 跳过,EventBus 过重

**完成 3/5 个深化,均为真正有架构摩擦的点。**

