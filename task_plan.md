# Agent Harness Audit Plan

## Goal
依次审计 Roc 当前代码，从 agent harness 角度达到生产环境要求，并确认优先使用 DeepAgents/LangChain 原生能力；不确定点先查权威来源，不靠猜测。

## Current Phase
Phase 4 contracts/IPC/persistence/tests audit in progress; AHA-001 committed as `e7302d1`, AHA-002 committed as `c1158e3`, AHA-003 committed as `7c178c1`, AHA-004 committed as `de532da`, AHA-005 committed as `34799cc`, AHA-006 committed as `142a080`, Phase 3 audit records committed as `85e0d01` and `86c18eb`

## Scope
- 代码范围：`src/`、`tests/`、`scripts/`、`docs/`、配置文件中与 agent harness、DeepAgents、LangChain、LangGraph、工具调用、文件系统、shell、memory、skills、subagent、runtime、IPC/持久化边界有关的代码。
- 审计视角：生产可用性、原生框架优先、边界安全、错误契约、持久化连续性、Windows 路径语义、测试覆盖、无重复/无自造中间层。
- 不做事项：不凭名字删除代码；不做无关重构；不新增兼容胶水、配置项、抽象或 prompt-only 修复。

## Acceptance Criteria
- 每个进入审计范围的文件/模块都在 `agent_harness_audit.md` 有状态记录。
- 每个发现都有证据：文件、调用关系、测试、官方文档或命令输出。
- DeepAgents/LangChain/LangGraph 相关判断以本地代码、官方映射参考或官方文档为准。
- 已确认问题用最小改动修复；无法证明的问题只记录，不修改。
- 所有业务代码改动都有对应验证；完成前运行与变更范围匹配的验证命令。

## Phases

### Phase 1: Requirements, Sources, And Inventory
- [x] 恢复/创建持久追踪文件
- [x] 读取 DeepAgents/LangChain 原生能力参考
- [ ] 盘点 agent harness 相关文件、测试、配置入口
- [ ] 建立 `agent_harness_audit.md` 文件级审计清单
- **Status:** in_progress

### Phase 2: Runtime And Orchestration Audit
- [ ] 审计 DeepAgents runtime 创建、thread continuity、checkpointer/store、recovery、streaming、metrics
- [ ] 审计 subagent/task orchestration、todo/planning、HITL、background task 运行状态
- [ ] 记录 native-first 偏差和生产风险
- **Status:** in_progress

### Phase 3: Tools, Filesystem, Shell, Memory, Skills Audit
- [x] 审计 file tools、shell tools、path guard、side-effect idempotency
- [x] 审计 memory、skills、AGENTS.md、backend routing、permissions
- [x] 对 `/workspace/`、Windows cwd、virtual route 做边界验证
- **Status:** complete

### Phase 4: Contracts, IPC, Persistence, Tests Audit
- [ ] 审计 shared schema、IPC、database/store、task state、migration/compatibility risks
- [ ] 审计现有测试是否覆盖关键 contract、error branch、recovery branch
- [ ] 补充或修复最小必要测试
- **Status:** in_progress

### Phase 5: Fixes And Verification
- [x] 对 AHA-001 做最小修复
- [x] 运行 AHA-001 focused tests
- [x] 按 AHA-001 风险运行 `pnpm test -- tests/main/plugins/agent`、`pnpm typecheck`、strict unused scan、`git diff --check`
- [ ] 按后续更大范围风险运行 `pnpm check:ipc`、`pnpm test`、`pnpm build`
- **Status:** in_progress

## Key Questions
1. 当前 Roc 哪些代码在自造 DeepAgents/LangChain 已有能力？
2. 哪些自定义层是生产必要的边界适配，哪些只是重复实现？
3. DeepAgents 原生 `backend`、`permissions`、`memory`、`skills`、`subagents`、`checkpointer/store` 是否被正确使用？
4. Windows 真实路径和 DeepAgents virtual path 边界是否在执行层强制，而不只在 prompt 中描述？
5. 当前测试是否能证明恢复连续性、side-effect 幂等、工具边界、IPC/schema 未漂移？

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 使用文件级审计清单而非只在对话中记录 | 用户明确要求全程用文件追踪，且任务会跨多轮。 |
| 先审计 DeepAgents/LangChain 原生语义，再判断 Roc 自定义层 | 用户要求 native-first，不确定先查，不猜测。 |
| 只修证据明确的问题 | AGENTS.md 要求 surgical change 和 evidence-first deletion。 |
| 为 AHA-001 新增 durable pending interrupt 表，而不是从 `run_interrupted` event replay 恢复 | `run_interrupted` 事件不携带 mode、taskSource、workflowHint、workspacePath、explicitSkillIds；这些是恢复 DeepAgents run 所需 runtime metadata。 |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| `Get-Content` failed for `C:\Users\任彦舟\.codex\skills\.system\using-superpowers\SKILL.md` | 1 | Corrected skill path to `C:\Users\任彦舟\.codex\skills\using-superpowers\SKILL.md`. |
| `Get-ChildItem -Filter 'task_plan.md','findings.md','progress.md'` failed because `-Filter` accepts one string | 1 | Used root listing and direct `Get-Content` reads instead of repeating the array `-Filter` command. |
| RED stale pending interrupt test resolved instead of rejecting | 1 | Added run status guard in `resumeRun()` and stale pending cleanup. |
| RED repository interrupt transaction test failed with `repository.markRunInterrupted is not a function` | 1 | Added `markRunInterrupted()` to persist `waiting_user` state and pending interrupt metadata in one repository transaction. |
| `pnpm typecheck` failed because repository test approval payload used `actionRequests` outside `request` | 1 | Read `src/shared/types/chat.ts` and corrected the test payload shape. |
| `rg` over pnpm scoped package glob paths failed with `os error 123` | 1 | Resolved package directories with `Get-ChildItem` and read nested package files directly. |
| RED checkpointer special writes test preserved stale `__interrupt__` value | 1 | Added special-write upsert path in `RocSqliteCheckpointer.putWrites()`. |

## Notes
- 状态词：`Located`、`Changed, unverified`、`Verified passing`、`Blocked, not run`。
- 每轮结束前更新 `progress.md`；每两个搜索/读取动作后把关键发现写入 `findings.md`。
