# Roc 架构深化重构任务

**Created:** 2026-09-03
**Goal:** 依次修复架构报告中的 5 个深化候选点,每完成一部分就 review、修复问题并提交,直到全部完成

## Next Step

Phase 3: 深化 Chat Transcript 投影 (SubagentBlockTree 封装递归逻辑)

## Current Phase

Phase 3

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
**Status:** in_progress
**Files:**
- `src/renderer/chat-transcript.ts`
- `src/renderer/chat/chat-transcript-panel.tsx`

**Tasks:**
- [ ] 创建 `SubagentBlockTree` 类封装递归逻辑
- [ ] 实现不可变更新接口 `applyEvent(identity, event): SubagentBlockTree`
- [ ] 创建 `TaskToolFilterPolicy` 集中过滤规则
- [ ] 重构现有 5 层调用栈使用 tree
- [ ] 添加工厂方法 `fromFlat([...blocks])` 方便测试
- [ ] Review + 修复问题
- [ ] 提交

**Acceptance Criteria:**
- 调用栈从 5 层降为 2 层
- 递归逻辑封装在 SubagentBlockTree
- task 过滤规则集中在一处

---

### Phase 4: 深化 Run Harness 装配器
**Status:** not_started
**Files:**
- `src/main/plugins/agent/run-harness.ts`
- `src/main/plugins/agent/index.ts`

**Tasks:**
- [ ] 创建 5 个独立类: ToolAssembler, ContextAssembler, BudgetCalculator, SessionHookGate, AgentFactory
- [ ] 重构 `buildRunHarness` 为协调器 (140 行 → 40 行)
- [ ] SessionHookGate 返回 `Result<Contexts, BlockReason>` 显式处理拦截
- [ ] 更新调用方
- [ ] 编写单元测试 (可单独测试每个类)
- [ ] Review + 修复问题
- [ ] 提交

**Acceptance Criteria:**
- buildRunHarness 从 139 行降为 40 行协调器
- 5 个职责分离到独立类
- 拦截语义显式,不埋在判别联合类型

---

### Phase 5: 明确 Task Repository 与 Agent History Contract 边界
**Status:** not_started
**Files:**
- `src/main/plugins/task/task-repository.ts`
- `src/main/plugins/agent/agent-task-history-contract.ts`

**Tasks:**
- [ ] 创建 `BackgroundTaskLifecycle` 领域服务
- [ ] 实现 `pause(taskId): DomainEvents[]` 等方法
- [ ] 引入 EventBus 解耦两个 repository
- [ ] TaskRepository 发布事件,不直接调用 AgentTaskHistoryContract
- [ ] 创建 AgentHistoryProjector 订阅事件写 agent 表
- [ ] Review + 修复问题
- [ ] 提交

**Acceptance Criteria:**
- TaskRepository 不再直接依赖 AgentTaskHistoryContract
- 通过 EventBus 解耦
- 可单独测试 TaskRepository (mock EventBus)

---

## Decisions Made

| Decision | Rationale | Date |
|----------|-----------|------|
| 优先修复 Manifest 编译器 | 热点模块,影响面最广,测试收益直接 | 2026-09-03 |
| 每个 phase 独立提交 | 降低回滚风险,便于 review | 2026-09-03 |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| - | - | - |

## References

- 架构报告: `C:\Users\任彦舟\AppData\Local\Temp\architecture-review-20260903.html`
- Codebase design 词汇表: 已读取
- CLAUDE.md: `F:\Code\Roc\CLAUDE.md`
