# Findings & Decisions

## Requirements
- 阅读 Codex 的 Plan 模式实现/官方源码或文档，说明 Plan 模式怎么实现。
- 说明 Plan 完成后如何交接进入实施。
- 说明怎样避免 Plan 模式写文件。
- 修复 Roc 当前 Plan 模式仍会调用 `write-file` / `write_file` 工具的问题。
- 以当前工作树和当前外部来源为证据，不靠旧记忆。

## Research Findings
- OpenAI Codex manual 已刷新到 `C:\Users\任彦舟\AppData\Local\Temp\openai-docs-cache\codex-manual.md`。
- Codex manual 表述：复杂任务可用 Plan mode，Plan mode 让 Codex 收集上下文、提问、生成计划，然后再实施；如需“聊天或计划但不改文件”，应切到 `read-only`。
- Codex manual 表述：sandbox 是技术边界，approval policy 是何时暂停审批；`read-only` 下 Codex 可检查文件，但不能编辑文件或运行命令而不经批准。
- Roc 当前搜索显示 Plan 相关入口包括 `src/main/services/deep-agent/agent-builder.ts`、`model-tool-exposure.ts`、`context/prompt-blocks.ts`、`deep-agent-executor.ts`、`tests/main/deep-agent-build-wiring.test.ts`、`tests/main/services/deep-agent/model-tool-exposure.test.ts`。
- 初步代码图显示 Roc 当前已有 Plan 模式 model-visible allowlist，但这可能只隐藏模型可见工具，不等于运行时不能执行写工具。
- Codex 源码 `collaboration-mode-templates/templates/plan.md` 明确：Plan Mode 是 collaboration mode，直到 developer message 结束；Plan Mode 允许非变异探索，禁止编辑/写文件/格式化/codegen 等 mutating action。
- Codex 源码 `collaboration-mode-templates/templates/plan.md` 明确：`update_plan` 是 checklist/TODO 工具，不是 Plan Mode，也不负责进入/退出 Plan Mode。
- Codex 源码 `tui/src/chatwidget/plan_implementation.rs` 明确：计划交接通过 “Implement this plan?” 弹窗；选择实施后以 Default mode 提交 `Implement the plan.`，或清上下文后带完整计划重新提交。
- DeepAgents 1.10.5 合同测试已说明：`createFilesystemMiddleware({ permissions: createRocReadOnlyFilesystemPermissions() })` 仍注册 `write_file`、`edit_file` 等写工具；read-only permissions 不隐藏写工具。
- Roc 当前根因：Plan 模式只做 `wrapModelCall` 的 model-visible tool 过滤，并给 DeepAgents read-only filesystem permissions；但 DeepAgents 仍注册写工具，若模型/恢复解析/历史 tool call 走到 ToolNode，运行时没有 Plan 专属 hard guard。
- LangChain JS `wrapToolCall` 组合实现说明 middleware 列表第一个是最外层；Roc 新 guard 接在 Plan exposure 后、filesystem path policy 前，可以在实际 handler 执行前短路 hidden/mutating 工具。
- Context7 LangChain JS 文档确认 `createMiddleware({ wrapToolCall })` 用于拦截工具调用，并通过是否调用 `handler(request)` 控制工具执行。
- 用户进一步澄清：Plan 模式只应屏蔽修改文件相关工具，其余阅读、网络搜索、MCP 都要接入。
- DeepAgents `createDeepAgent` 会强制包含 filesystem middleware；该 middleware 成套注册 `write_file` / `edit_file`，无法只通过 permissions 或 excluded tools 达成“不注册写文件工具”。
- 最新实现改为：Plan 分支使用 LangChain `createAgent`，注册 Roc 自有只读文件工具和全部非文件修改外部工具；不经过 DeepAgents filesystem middleware，因此 Plan 注册层没有 `write_file` / `edit_file`。
- Plan executor 现在仍加载已启用 MCP 工具；`web_search`、`filesystem__search`、`filesystem__write_file` / `filesystem__edit_file` / `filesystem__delete_file` 等 MCP 工具都不在 Plan 层做内部屏蔽，MCP 审批与启停由配置页能力管理负责。
- Plan 分支通过 LangChain `createAgent` 加 `todoListMiddleware()` 和 DeepAgents `createSubAgentMiddleware()` 恢复 `write_todos` 与 `task`；没有重新引入 DeepAgents `FilesystemMiddleware`，因此不会从 DeepAgents 注册裸 `write_file` / `edit_file`。

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Plan 分支不使用 DeepAgents filesystem middleware | 这是从注册层杜绝 `write_file` / `edit_file` 的唯一稳定边界；read-only permissions 不会隐藏工具。 |
| Plan 工具过滤从 allowlist 改为 file-mutation blocklist | 满足用户要求：只屏蔽修改文件相关工具，其余阅读、网络搜索、MCP 继续接入。 |
| MCP 工具不在 Plan 层做内部屏蔽或审批 | 用户明确 MCP 审批在配置页管理；Plan 模式只处理 Roc 本地工具注册边界。 |
| 保留 Plan runtime guard | 即使未来有隐藏/恢复/下游路径尝试调用文件修改工具，仍在工具执行前短路。 |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| `createRocPlanRuntimeToolGuardMiddleware` 测试红灯失败，函数不存在 | 按 TDD 证明当前缺少运行时边界后再实现。 |

## Verification Evidence
- `pnpm test -- tests/main/services/deep-agent/model-tool-exposure.test.ts` -> 5 tests passed.
- `pnpm test -- tests/main/deep-agent-build-wiring.test.ts` -> 8 tests passed.
- `pnpm test -- tests/main/services/deep-agent/deep-agent-official-contracts.test.ts` -> 7 tests passed.
- Combined focused suite: `pnpm test -- tests/main/services/deep-agent/model-tool-exposure.test.ts tests/main/deep-agent-build-wiring.test.ts tests/main/services/deep-agent/deep-agent-official-contracts.test.ts tests/main/services/deep-agent/filesystem-path-policy.test.ts tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts` -> 5 files, 47 tests passed.
- `pnpm typecheck` -> exit 0.
- `git diff --check` -> exit 0 before final planning-file update.
- Latest target suite: `pnpm test -- tests/main/services/deep-agent/model-tool-exposure.test.ts tests/main/deep-agent-build-wiring.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts` -> 3 files, 29 tests passed.
- Latest `pnpm typecheck` -> exit 0.
- Review follow-up focused suite: `pnpm test -- tests/main/services/deep-agent/model-tool-exposure.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/deep-agent-build-wiring.test.ts tests/main/services/deep-agent/tools.test.ts tests/main/services/deep-agent/deep-agent-official-contracts.test.ts` -> 6 files, 44 tests passed.
- Review follow-up `pnpm typecheck` -> exit 0.
- Review follow-up `git diff --check` -> exit 0; Git printed CRLF normalization warnings only.
- Strict unused scan: `pnpm exec tsc --noEmit -p tsconfig.json --noUnusedLocals --noUnusedParameters` -> exit 0.
- Full Vitest: `pnpm test` -> 254 files, 1254 tests passed; command exit 0 with Windows `node-pty` `AttachConsole failed` teardown noise.
- IPC check: `pnpm check:ipc` -> generated files are current.

## Resources
- Codex manual: `C:\Users\任彦舟\AppData\Local\Temp\openai-docs-cache\codex-manual.md`
- Codex manual outline: `C:\Users\任彦舟\AppData\Local\Temp\openai-docs-cache\codex-manual.outline.md`
- Roc memory pointer: `MEMORY.md:340` points to older Plan mode research, but current task uses fresh source.

## Visual/Browser Findings
- Not applicable.
