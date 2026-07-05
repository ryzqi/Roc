# Roc 记忆系统重构设计

## 目标

重构 Roc 自动记忆写入策略，在保持 DeepAgents native-first 架构的前提下，让 `USER.md` 也可以被自动写入，但只允许高置信、直接用户证据的稳定用户偏好直写。其余长期事实、项目决策、坑点和验证结果继续写入 `MEMORY.md`；`AGENTS.md` 保持只由显式编辑修改。

## 当前事实

- Roc 当前 DeepAgents runtime 已通过 `createBackend()` 挂载 `/skills/`、`/memory/global/`、`/memory/workspaces/current/`、`/workspace/`，并用 `StoreBackend` 承载 memory route。
- `buildDeepAgent()` 已传入 `backend`、`store`、`memorySources`、`skillSources`、`checkpointer`；plan mode 下 memory 只读注入，不允许写入。
- `store-slots.ts` 当前定义 global `USER.md`、`AGENTS.md`、`MEMORY.md`，以及 workspace `AGENTS.md`、`MEMORY.md`；workspace `USER.md` 被拒绝。
- `AutoMemoryWriter` 当前从 `agent.run.completed` 的 typed candidate 解析自动记忆，只追加到 `kind: 'memory'`，即 `MEMORY.md`。
- `user_preference` 当前已有较严格准入：必须存在直接用户证据；`workspace_fact`、`pitfall`、`verification` 需要 evidence；`transient_task_result` 被拒绝。
- `MemoryStoreRepository.writeFile()` 已统一执行安全扫描、容量检查和 Store 写入。
- `memory_auto_audit` 当前记录 action、type、scope、confidence、key、summary、sourceRunId、reason、workspacePath、createdAt，但不能直接区分目标文件。

## 外部文档依据

- DeepAgents 官方 JavaScript memory 文档将 long-term memory 定义为 filesystem-backed memory：通过 `memory=` 指向文件，backend 控制存储和访问，agent 可用 `edit_file` 更新 memory 文件。
- DeepAgents 文档把 memory 区分为 short-term、long-term、episodic、procedural、semantic、user-scoped、agent-scoped、organization-level，并强调 writable/read-only memory 应按权限分层。
- LangGraph 官方 JavaScript memory 文档区分 short-term memory 和 long-term memory：前者由 thread-level checkpointer 维护，后者通过 Store 跨 session 保存 user-specific 或 application-level data。
- Codex 和 Claude Code 的产品语义都指向同一原则：用户/项目规则、技能、会话历史和长期记忆是不同层，不能把所有内容混入一个可写文件。

## 设计原则

- 保持 DeepAgents native-first：不重写 DeepAgents memory backend、不新增 Roc 私有 runtime、不绕过 `CompositeBackend` / `StoreBackend` / `memorySources`。
- Roc 负责治理层：candidate admission、目标文件路由、冲突处理、审计和 UI 可解释性。
- `USER.md` 是高价值、低噪声、跨 workspace 的用户画像文件，必须比 `MEMORY.md` 更严格。
- 自动写入只能扩大到 `USER.md` 和 `MEMORY.md`；`AGENTS.md` 继续显式编辑。
- 写入失败必须审计，不能静默吞掉。

## 文件职责

### `/memory/global/USER.md`

保存全局稳定用户偏好、沟通方式和明确表达的工具习惯。允许自动写入，但必须满足严格直写规则。

推荐正文格式：

```md
## Preferences

<!-- key: user.cli.shell -->
- User prefers PowerShell for command examples.

<!-- key: user.workflow.evidence_first -->
- User wants evidence-first diagnosis before Roc architecture changes.
```

`sourceRunId`、`evidence`、`confidence`、`reason` 不写进 `USER.md` 正文，只进入 audit。

### `/memory/global/AGENTS.md` 和 `/memory/workspaces/current/AGENTS.md`

保存规则、约束和工作方式。继续只允许用户或 agent 显式通过 memory file edit 修改，不参与自动写入。

### `/memory/global/MEMORY.md` 和 `/memory/workspaces/current/MEMORY.md`

保存长期事实、项目决策、坑点、验证结果和可重验证经验。继续使用现有结构化条目格式，便于 key 去重、TTL 和 revalidate。

### `session_search`

继续作为 episodic recall，不把完整会话历史灌入 memory 文件。

## 自动写入路由

新增 candidate target resolution：

| Candidate type | 条件 | 目标 |
| --- | --- | --- |
| `user_preference` | 满足严格直写规则 | `/memory/global/USER.md` |
| `user_preference` | 不满足严格直写规则 | 拒绝并审计 |
| `workspace_fact` | workspace 可用且 evidence 非空 | workspace `MEMORY.md` |
| `pitfall` | workspace 可用且满足现有 evidence / low-confidence TTL 规则 | workspace `MEMORY.md` |
| `verification` | workspace 可用且 evidence 非空 | workspace `MEMORY.md` |
| `decision` | workspace 可用 | workspace `MEMORY.md` |
| `decision` | workspace 不可用 | global `MEMORY.md` |
| `transient_task_result` | 任意 | 拒绝并审计 |

workspace-scoped candidate 没有可用 workspace 时，继续沿用当前保守降级到 global `MEMORY.md` 的行为，匹配现有 `resolveTargetScope()` 语义。

## `USER.md` 严格直写规则

`user_preference` 只有同时满足以下条件才写入 `/memory/global/USER.md`：

- `confidence === 'high'`
- candidate scope 为 `global`
- evidence 命中直接用户表达：`user stated`、`user confirmed`、`user selected`、`user chose`、`user requested`、`user asked`
- summary 表示稳定偏好、沟通方式或工具习惯，不是一次性任务结果
- 安全扫描通过，不包含 prompt injection、凭据、SSH 后门或不可见字符
- 不与现有同 key 用户偏好冲突

模型推断偏好、低/中置信偏好、身份敏感信息、一次性偏好和冲突偏好不得直写 `USER.md`。

## 去重和冲突

- `USER.md` 去重基于 candidate `key` 和 normalized summary。
- 同 key + 同 summary：记录 `duplicate_skipped`。
- 同 key + 不同 summary：记录 `conflict_rejected`，不覆盖现有 `USER.md`。
- `MEMORY.md` 继续沿用现有结构化条目的重复检测；容量溢出时仍可执行一次精确重复清理后重试。

为了让 `USER.md` 正文保持简洁且仍支持长期冲突检测，自动写入的每条偏好前写入一行 HTML comment：`<!-- key: ... -->`。冲突检测只读取这些 key 标记和后续 bullet summary；audit 仍然保存 source、evidence、confidence 和 reason。`USER.md` 不写完整审计日志。

## 审计

扩展自动记忆审计记录，新增目标文件字段 `targetPath`：

- `/memory/global/USER.md`
- `/memory/global/MEMORY.md`
- `/memory/workspaces/current/MEMORY.md`

所有 accepted、duplicate_skipped、conflict_rejected、rejected、write_failed 都必须带目标文件。没有目标文件的早期拒绝可以使用 `null`，但 UI 需要明确显示为“未写入”。

Schema 变更必须同步 shared types、repository、MemoryStatus、renderer 使用方和测试。

## UI 和设置

- Memory Center 自动写入 tab 显示目标文件，至少能区分 `USER.md` 和 `MEMORY.md`。
- 设置页文案更新为：自动记忆会按准入规则写入 `USER.md` 或 `MEMORY.md`；`USER.md` 仅接受高置信直接用户偏好。
- 不新增审核队列、不新增复杂审批流、不新增 workspace `USER.md`。
- 现有容量设置继续生效：`charLimits.user` 控制 `USER.md`。

## 错误处理和安全

- 写 `USER.md` 必须复用 `MemoryStoreRepository.writeFile()`，继续走安全扫描和容量检查。
- 关键 contract 缺失必须显式失败或拒绝，不用默认值掩盖。
- 不用宽泛 `try/catch` 吞掉业务错误；自动写入 boundary 可以 catch 并记录 `write_failed`。
- 不依赖 prompt 作为唯一边界；路由和准入必须在执行层实现。

## 测试策略

最小回归测试：

- `user_preference` 高置信 + direct user evidence 写入 global `USER.md`。
- `user_preference` medium/low confidence 被拒绝。
- `user_preference` model-inferred evidence 被拒绝。
- 同 key 同 summary 写 `USER.md` 时 duplicate skipped。
- 同 key 不同 summary 写 `USER.md` 时 conflict rejected，旧偏好不被覆盖。
- `workspace_fact`、`pitfall`、`verification`、`decision` 仍写入正确 `MEMORY.md`。
- 审计记录包含 `targetPath`，renderer 自动写入 tab 能展示目标文件。
- prompt 文案测试更新：不再说 automatic writes only append to `MEMORY.md`。
- schema / IPC 生成物如有变更，运行 `pnpm generate:ipc` 和 `pnpm check:ipc`。

建议验证顺序：

1. `pnpm test -- tests/main/services/memory/auto-memory-writer.test.ts`
2. `pnpm test -- tests/main/deep-agent-prompt.test.ts`
3. 涉及 renderer 时运行对应 Memory View / Settings 测试。
4. 涉及 shared IPC/schema 时运行 `pnpm check:ipc`。
5. `pnpm typecheck`
6. `git diff --check`

## 不做事项

- 不重写 DeepAgents backend、checkpointer、Store 或 skills 机制。
- 不新增审核队列。
- 不允许 workspace `USER.md`。
- 不让 `AGENTS.md` 自动写。
- 不把 session history 批量固化进 `MEMORY.md`。
- 不做无关 UI 重设计。
- 不删除无法证明无用的旧代码。

## 验收标准

- 严格直写规则被测试覆盖并通过。
- `USER.md` 自动写入使用简洁偏好格式，审计信息不污染正文。
- `MEMORY.md` 现有 typed candidate 写入行为不回退。
- 审计和 UI 能显示目标文件。
- DeepAgents native memory wiring 不被替换。
- 无新增 unused import、旧文案或 stale 测试残留。
