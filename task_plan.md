# Task Plan: Codex Plan Mode / Roc Write Tool Boundary

## Goal
分析 Codex Plan 模式的实现与交接边界，并修复 Roc Plan 模式仍会调用 `write_file` 类写工具的问题，带回归证据。

## Current Phase
Phase 7: Review Follow-up Fixes Complete

## Phases

### Phase 1: Requirements And Discovery
- [x] 提取目标、范围、约束、验收条件
- [x] 阅读 Roc 当前 Plan 模式入口、工具暴露、运行时执行链
- [x] 阅读 Codex 官方文档/源码中 Plan 模式与交接语义
- [x] 记录发现到 findings.md
- **Status:** complete

### Phase 2: Root Cause And Test
- [x] 定义 Roc 当前可复现条件
- [x] 写最小失败回归测试，证明 Plan 模式不能执行写工具
- [x] 验证测试按预期失败
- **Status:** complete

### Phase 3: Implementation
- [x] 实施最小修复，优先运行时边界，不只改 prompt
- [x] 清理本次改动造成的 unused 项
- **Status:** complete

### Phase 4: Verification
- [x] 运行目标测试
- [x] 根据影响面运行 `pnpm typecheck`
- [x] 运行 `git diff --check`
- [x] 审计显式要求是否全部有当前证据
- **Status:** complete

### Phase 5: Handoff
- [x] 总结 Codex Plan 模式实现和交接机制
- [x] 总结 Roc 根因、改动、证据、未做项
- **Status:** complete

### Phase 6: Root Non-Registration Boundary
- [x] 按用户澄清收窄目标：Plan 只屏蔽文件修改相关工具，其余阅读、网络搜索、MCP 继续接入
- [x] 避免 DeepAgents filesystem middleware 在 Plan 下注册 `write_file` / `edit_file`
- [x] Plan 注册全部非文件修改外部工具，并补本地只读 `ls` / `read_file` / `glob` / `grep`
- [x] Plan executor 继续加载已启用 MCP；MCP 内部工具不在 Plan 层屏蔽
- [x] 运行目标测试、`pnpm typecheck`、`git diff --check`
- **Status:** complete

### Phase 7: Review Follow-up Fixes
- [x] 按用户澄清保留 MCP 配置页边界：Plan 不处理 MCP 审批，不屏蔽 MCP 内部工具
- [x] 修正 Plan prompt，明确网络搜索和已启用 MCP 仍可用
- [x] 恢复 Plan 下 `write_todos` / `task` 能力，但不重新注册本地文件写工具
- [x] 运行目标测试、`pnpm typecheck`、`git diff --check`
- **Status:** complete

## Key Questions
1. Codex Plan 模式如何限制写入：是工具隐藏、sandbox read-only、审批，还是多层组合？
2. Codex Plan 完成后如何交接到实施：同线程继续、用户确认、权限/模式切换如何发生？
3. Roc 当前 Plan 模式中 `write_file` 仍可调用的真实执行路径是什么？
4. Roc 应在模型可见层、运行时工具层、权限层哪一层阻断写工具？

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 先调查再修复 | 用户要求仔细阅读 Codex 源码并分析根因；Roc 规则要求先定位真实执行路径。 |
| 回归测试优先 | 当前问题是行为缺陷；按 TDD 先证明 Plan 模式写工具仍可执行。 |
| Plan 不走 DeepAgents filesystem middleware | DeepAgents read-only permissions 不隐藏写工具；要从注册层杜绝 `write_file` / `edit_file`，Plan 不能使用会成套注册写工具的 filesystem middleware。 |
| Plan 工具规则改为文件修改 blocklist | 用户澄清 Plan 只应屏蔽修改文件相关工具，其余阅读、网络搜索、MCP 都要接入。 |
| MCP 工具边界交给配置页 | 用户澄清 MCP 审批在配置页管理，Plan 模式不需要审批；MCP 内部工具不在 Plan 过滤层屏蔽。 |
| 不使用 subagent review | 当前 subagent 工具规则要求用户明确授权才可派生子代理；本次改为本地风险审计。 |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|

## Notes
- 不把 prompt 当根修复；必须查执行层和工具边界。
- 不删除无证据的旧逻辑。
