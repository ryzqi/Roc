# Plan Mode Tool Boundary Design

## Goal

修复 Roc plan mode 仍会尝试 `write_file` 的问题。plan mode 和 chat mode 必须拥有独立工具面：plan mode 只做研究、澄清和只读检查，模型侧不能看到任何文件写入、删除、命令执行、后台任务变更、MCP 或子代理委派工具；chat mode 保持现有能力不变。

## Sources

- Roc 当前代码事实：
  - `src/main/plugins/agent/deep-agent-executor.ts` 在 plan mode 只把 `web_read` 和 `ask_user` 放进 Roc 自定义 `runTools`。
  - `src/main/services/deep-agent/agent-builder.ts` 仍调用 DeepAgents `createDeepAgent()`，并把 `filesystemPermissions` 传给 DeepAgents。
  - `src/main/services/deep-agent/context/prompt-blocks.ts` 的 plan workspace prompt 当前仍写了不要调用 `write_file`、`edit_file`、`delete_file`、`run_shell_command`。
  - `src/main/services/deep-agent/harness-profiles.ts` 已用 DeepAgents harness profile 全局排除 `execute`。
- DeepAgents 1.10.5 当前行为：
  - `createDeepAgent()` 默认装配 filesystem middleware。
  - filesystem middleware 会注册 `ls`、`read_file`、`write_file`、`edit_file`、`glob`、`grep` 和 `execute`。
  - `permissions` 是运行时访问控制，不会自动把 `write_file` 或 `edit_file` 从模型工具 schema 中移除。
  - harness profile 的 `excludedTools` 通过 `wrapModelCall` 过滤模型可见工具，但 Roc 现有注册是 provider 级全局 profile，不适合直接表达 per-request plan/chat 差异。
- Codex 源码参考：
  - `.artifacts/openai-codex/codex-rs/core/src/tools/router.rs` 将 runtime registry 与 `model_visible_specs` 分开。
  - `.artifacts/openai-codex/codex-rs/core/src/tools/registry.rs` 支持 `ToolExposure::Hidden`，工具可以存在于 runtime registry 中但不暴露给模型。

## User Decisions

- 采用方案 A：Roc request 级模型可见工具过滤，加 read-only filesystem permissions 兜底。
- plan mode 不暴露 `task`，避免通过 DeepAgents 子代理绕过主工具面。
- plan mode 不暴露 `write_todos`。
- plan mode 不暴露 shell、delete、MCP 或后台任务 mutation 工具。
- chat mode 不因本次修复丢失现有写文件、命令、MCP、后台任务或子代理能力。

## Plan Mode Tool Contract

plan mode 模型可见工具只允许：

- `ls`
- `read_file`
- `glob`
- `grep`
- `web_read`
- `ask_user`
- `session_search`

plan mode 模型可见工具必须排除：

- `write_file`
- `edit_file`
- `delete_file`
- `run_shell_command`
- `execute`
- `task`
- `write_todos`
- `resolve_background_task_time`
- `propose_background_task`
- `schedule_background_task`
- `read_background_task`
- `update_background_task`
- `cancel_background_task`
- selected MCP tools

`read_background_task` 虽然是读取动作，也不属于 plan mode 的通用研究工具面。本次按用户确认的独立 plan/chat 边界处理，不在 plan mode 暴露后台任务工具族。

## Runtime Design

`DeepAgentBuildInput` 增加 `mode: ChatStartRunRequest['mode']` 字段。`deep-agent-executor.ts` 在构建 agent 时把当前 `ChatStartRunRequest.mode` 传入 `buildDeepAgent()`。

`buildDeepAgent()` 根据 mode 装配 Roc-owned model tool exposure middleware：

- chat mode：不装配 plan-only exposure middleware，继续使用现有 Roc harness profile 排除全局禁用的 `execute`。
- plan mode：在模型调用前过滤 `request.tools`，只保留 plan allowlist。

该 middleware 只改变模型可见工具 schema，不改 DeepAgents backend、filesystem middleware 或 runtime registry。这样符合 Codex 的分层思想：模型只能看到当前 mode 允许的工具；runtime 仍保留权限和路径 guard 作为防线。

plan mode 继续传入 `createRocReadOnlyFilesystemPermissions()`：

- 允许读取 `/workspace/**`、`/memory/**`、`/skills/**`。
- 拒绝所有写入。

这不是主修复手段，而是防止未来 DeepAgents 或 Roc 变更导致工具过滤漏网后的第二道防线。

## Prompt Design

plan mode prompt 必须只描述真实暴露的能力：

- Plan Mode exposes read-only inspection tools only.
- Local file inspection uses Roc virtual routes: `/workspace/`, `/memory/`, and `/skills/`.
- Use `ls`, `read_file`, `glob`, and `grep` for local inspection.
- Use `web_read` for public web pages.
- Use `ask_user` only for concise clarifying questions when needed.

plan mode prompt 不再写：

- `Do not call write_file...`
- `Do not call edit_file...`
- `Do not call delete_file...`
- `Do not call run_shell_command...`

原因是这些工具不应出现在模型 schema 中。prompt 不能成为主要安全边界，也不能暗示被屏蔽工具仍可调用。

chat mode prompt 保持现有文件工具说明和写后验证要求。

## Tests And Acceptance Criteria

DeepAgents contract tests:

- 继续锁定 DeepAgents filesystem middleware 默认会注册 `write_file` 和 `edit_file`。
- 新增或调整测试，说明 read-only permissions 不等价于模型工具不可见。

Agent builder tests:

- plan mode 会装配 Roc model tool exposure middleware。
- chat mode 不装配 plan-only exposure middleware。
- Roc shell path policy 仍在 RTK middleware 前执行。

Executor tests:

- plan mode build input 使用 read-only filesystem permissions。
- plan mode Roc 自定义 tools 仍包含 `web_read`、`ask_user`、`session_search`。
- plan mode 捕获到的模型可见工具包含 `ls`、`read_file`、`glob`、`grep`、`web_read`、`ask_user`、`session_search`。
- plan mode 捕获到的模型可见工具不包含 `write_file`、`edit_file`、`delete_file`、`run_shell_command`、`execute`、`task`、`write_todos`、MCP 工具或后台任务工具。
- chat mode 仍能看到现有 chat 工具面，包括 Roc 自定义 mutation 工具和 DeepAgents 文件写入工具。

Prompt tests:

- plan prompt 包含 read-only inspection wording。
- plan prompt 不包含 `Do not call write_file`、`Do not call edit_file`、`Do not call delete_file` 或 `Do not call run_shell_command`。
- chat prompt 仍包含写文件后的 `read_file` 或 `ls` 验证要求。

Verification:

- `pnpm test -- tests/main/plugins/agent/deep-agent-executor-tools.test.ts`
- `pnpm test -- tests/main/services/deep-agent/deep-agent-official-contracts.test.ts`
- `pnpm test -- tests/main/services/deep-agent/context/prompt-blocks.test.ts`
- `pnpm test -- tests/main/deep-agent-build-wiring.test.ts`
- `pnpm typecheck`
- `git diff --check`

## Non-Goals

- 不 fork DeepAgents。
- 不用 prompt-only 方案修复工具边界。
- 不为 plan mode 增加新的写入、删除、shell、MCP、后台任务或子代理能力。
- 不改变 chat mode 的现有能力。
- 不改 renderer UI。
- 不改后台任务创建、调度或历史隔离逻辑。
- 不改 DeepAgents `/workspace/` 与 Windows shell cwd 的既有路径语义。

## Risks

- 如果只测试 Roc 自定义 `runTools`，会漏掉 DeepAgents 默认 middleware 注入的 `write_file` 和 `edit_file`。测试必须覆盖模型最终可见工具面。
- 如果把 `write_file` 和 `edit_file` 加进全局 harness profile 的 `excludedTools`，chat mode 会被误伤。
- 如果 plan mode 保留 `task`，子代理可能重新获得 DeepAgents 默认 filesystem middleware。本设计通过不暴露 `task` 避免该绕行路径。
- 如果 prompt 仍提到被屏蔽工具，模型可能生成无效工具调用，用户也会误解真实工具面。
