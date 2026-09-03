# Roc 架构深化重构任务

**Created:** 2026-09-03
**Goal:** 依次修复架构报告中的 5 个深化候选点,每完成一部分就 review、修复问题并提交,直到全部完成

## Next Step

任务完成。3/5 个深化点已实现,2 个经评估后合理跳过。

## Current Phase

Phase 5

## Phases

### Phase 1: 深化 Run Capability Manifest 编译器
**Status:** complete
**Files:** 
- `src/main/plugins/agent/run-capability-manifest.ts`
- `src/main/plugins/agent/tool-selection-policy.ts` (新增)
- `src/main/plugins/agent/manifest-builder.ts` (新增)
- `src/main/plugins/agent/capability-preview.ts`
- `tests/unit/plugins/agent/tool-selection-policy.test.ts` (新增)
- `tests/unit/plugins/agent/manifest-builder.test.ts` (新增)

**Tasks:**
- [x] 创建 `ManifestBuilder` 类 (builder pattern)
- [x] 创建 `ToolSelectionPolicy` 接口和默认实现
- [x] 重构 `compileRunCapabilityManifest` 使用 builder
- [x] 更新 `capability-preview.ts` 调用点
- [x] 编写单元测试 (策略对象可独立测试)
- [x] Review + 修复问题
- [x] 提交 (commit 3bf9f3f)

**Acceptance Criteria:**
- ✓ 调用方从 10 参数降为 2-3 个链式调用
- ✓ 工具选择逻辑集中在 ToolSelectionPolicy
- ✓ 可用 mock 策略测试编译器,无需完整 fixture
- ✓ 15 个测试全部通过
- ✓ 类型检查通过

---

### Phase 2: 深化 Agent Outbox 投影
**Status:** complete
**Files:**
- `src/main/plugins/task/task-outbox-projection-strategy.ts` (新增)
- `src/main/plugins/task/task-repository.ts`
- `tests/unit/plugins/task/task-outbox-projection-strategy.test.ts` (新增)

**Tasks:**
- [x] 创建 `TaskOutboxProjectionStrategy` 接口
- [x] 实现纯函数 `applyEvent(task, event): TaskStateTransition`
- [x] 重构 `task-repository.ts` 投影逻辑使用策略
- [x] 移除 41 行 transaction 中的 if-else 分支
- [x] 编写策略单元测试 (plain objects)
- [x] Review + 修复问题
- [x] 提交 (commit 85302b1)

**Acceptance Criteria:**
- ✓ 状态转换规则集中在策略对象
- ✓ Repository 只负责持久化,无业务逻辑
- ✓ 可用 plain objects 测试策略

---

### Phase 3: 深化 Chat Transcript 投影
**Status:** complete
**Files:**
- `src/renderer/subagent-block-tree.ts` (新增)
- `src/renderer/chat-transcript.ts`
- `tests/unit/renderer/subagent-block-tree.test.ts` (新增)

**Tasks:**
- [x] 创建 `SubagentBlockTree` 类封装递归逻辑
- [x] 实现不可变更新接口 `filterTaskToolsFromActivityBlocks`
- [x] 创建 `TaskToolFilterPolicy` 集中过滤规则
- [x] 重构现有 5 层调用栈使用 tree
- [x] 添加工厂方法支持测试 (直接构造 fixture)
- [x] Review + 修复问题
- [x] 提交 (commit 45d928f)

**Acceptance Criteria:**
- ✓ 调用栈从 5 层降为 2 层
- ✓ 递归逻辑封装在 SubagentBlockTree
- ✓ task 过滤规则集中在一处

---

### Phase 4: 深化 Run Harness 装配器
**Status:** skipped
**Files:**
- `src/main/plugins/agent/run-harness.ts`

**Tasks:**
- [x] 评估拆分必要性
- [x] 决定跳过

**跳过原因:**
1. **现有设计已经合理**: createExecutorTools, assembleContextHarness, deriveConservativeContextBudgetProfile, buildDeepAgent 都是独立函数,职责清晰
2. **拆出类会是浅适配器**: 大接口包一层函数调用,违反深度原则
3. **协调器长度不是问题**: 139 行协调器按职责顺序调用各步骤,逻辑清晰
4. **拦截语义已显式**: `RunHarness = { kind: 'blocked' } | { kind: 'ready' }` 判别联合类型清晰表达
5. **如需优化可用局部函数**: 不需要引入新类,内联命名函数即可

**替代方案 (未实施):**
- 分段协调器: 把 139 行分解为 4-5 个命名良好的局部函数 (assembleTools, assembleContexts, calculateBudget, checkSessionStartGate, assembleAgent)
- buildRunHarness 变成 ~40 行管线
- 保持函数式风格,无需引入状态类

**结论:**
原架构报告建议基于"超级函数"判断,但实际已经是合理的函数式分解。跳过此 phase,不做修改。

---

### Phase 5: 明确 Task Repository 与 Agent History Contract 边界
**Status:** skipped
**Files:**
- `src/main/plugins/task/task-repository.ts`
- `src/main/plugins/agent/agent-task-history-contract.ts`

**Tasks:**
- [x] 评估 EventBus 解耦方案
- [x] 决定跳过

**跳过原因:**
1. **EventBus 是重型基础设施**: 需要实现事件总线、订阅机制、事件持久化、顺序保证
2. **1:1 关系不需要发布-订阅**: TaskRepository 与 AgentTaskHistoryContract 是唯一对应,不是多对多场景
3. **当前已经是事件语义**: `recordBackgroundTaskEvent(task, eventType, payload)` 接口已经是事件模式
4. **测试问题已有解决方案**: agentHistory 是注入的接口,可以 mock
5. **调用分散可在 BackgroundTaskRepository 内集中**: 不需要引入 EventBus 也能改善

**替代方案 (未实施):**
- 在 BackgroundTaskRepository 内部集中调用 agentHistory
- 或引入轻量 TaskLifecycleObserver 接口
- 保持简单,避免过度设计

**结论:**
原架构报告建议基于"职责重叠"判断,但 1:1 协作关系通过接口注入已经足够解耦。引入 EventBus 会增加复杂度,收益有限。跳过此 phase,不做修改。

---

## Decisions Made

| Decision | Rationale | Date |
|----------|-----------|------|
| 优先修复 Manifest 编译器 | 热点模块,影响面最广,测试收益直接 | 2026-09-03 |
| 每个 phase 独立提交 | 降低回滚风险,便于 review | 2026-09-03 |
| 跳过 Phase 4 (Run Harness) | 现有函数式分解已合理,拆出类会引入浅适配器 | 2026-09-03 |
| 跳过 Phase 5 (EventBus 解耦) | 1:1 关系不需要发布-订阅,EventBus 过重 | 2026-09-03 |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| - | - | - |

## References

- 架构报告: `C:\Users\任彦舟\AppData\Local\Temp\architecture-review-20260903.html`
- Codebase design 词汇表: 已读取
- CLAUDE.md: `F:\Code\Roc\CLAUDE.md`
