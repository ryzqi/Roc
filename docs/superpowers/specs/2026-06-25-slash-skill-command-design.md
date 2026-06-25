# 输入框 `/skill` 显式加载设计

## Goal

在聊天输入框新增 `/skill <skill-id> <prompt>` 命令。该命令只影响当前提交：显式加载指定 skill 的 `SKILL.md` 到本轮 agent 上下文，不覆盖、不追加、不持久化 `enabledCapabilities.skills`。

## Current Facts

- Roc 当前输入框在 `src/renderer/chat/chat-composer.tsx`，发送路径经 `src/renderer/chat/chat-view.tsx` 到 `src/renderer/app/use-app-task-runs.ts`。
- `enabledCapabilities.skills` 当前表示用户通过 UI 选择的技能集合。它会进入 run payload，并决定 DeepAgents 的 `/skills/` 后端可见范围。
- `assembleContextHarness()` 当前仅在 `enabledCapabilities.skills.length > 0` 时传入 `skillSources: ['/skills/']`，让 DeepAgents 按需发现和读取 skills。
- `SkillService` 已能校验、列出和读取 skill 文件；`skills.file.read` 可读取 `SKILL.md`。
- Codex 源码中 `/name rest` 是 slash command 解析；skill 使用 mention binding 明确绑定目标。Roc 本次沿用“明确绑定目标”的语义，但触发形式按用户要求使用 `/skill`。

## Non-Goals

- 不把 `/skill` 解释为选择或覆盖 `enabledCapabilities.skills`。
- 不把 `SKILL.md` 内容注入用户消息正文。
- 不新增持久 skill 选择状态。
- 不实现多级命令体系、命令历史、别名、插件 mention 或 Codex 完整 composer 复刻。
- 不改变后台任务既有 MCP/skill 继承语义。

## User Experience

输入：

```text
/skill python-expert 优化这段代码
```

发送行为：

- 用户消息正文为 `优化这段代码`。
- 本轮请求携带 `explicitSkillIds: ['python-expert']`。
- `enabledCapabilities.skills` 保持用户当前 UI 选择，原样传递。
- 指定 skill 的 `SKILL.md` 在 main 侧读取并注入本轮 system prompt。
- 其他可用 skills 仍只通过 DeepAgents skills catalog 暴露 name/description，模型需要时再按需读取。

错误行为：

- `/skill` 缺少 id、缺少正文、id 不存在、skill disabled、skill invalid、`SKILL.md` 不可读时，不启动 run。
- 错误展示在输入框附近，文案指向用户可修复动作。
- 输入框内容保留，方便用户修改。

## Request Contract

在 `ChatStartRunRequest` 增加可选字段：

```typescript
explicitSkillIds?: string[];
```

约束：

- 只接受非空字符串数组。
- renderer 只负责从输入解析出 id。
- main 侧是权威校验方。
- resume run 不重新解析用户输入；是否保留 `explicitSkillIds` 由 pending interrupt 元数据决定。当前设计优先保留，保证 HITL resume 前后上下文一致。

## Parsing Rules

仅当输入第一行从 `/skill` 开始时触发命令解析。

有效形式：

```text
/skill <skill-id> <prompt>
```

规则：

- command name 精确匹配 `skill`。
- `<skill-id>` 取第一个空白分隔 token。
- `<prompt>` 是 id 后去掉前导空白后的剩余文本。
- `<prompt>` 不能为空；否则不启动 run。
- 普通文本中的 `/skill` 不触发。
- 第一行不是 `/skill` 时完全沿用现有发送行为。

## Context Injection

main 侧新增 request-scoped prompt block，例如 `explicit_skills`。

每个显式 skill 注入格式：

```xml
<skill>
<name>python-expert</name>
<path>/skills/python-expert/SKILL.md</path>
...SKILL.md content...
</skill>
```

约束：

- 注入内容来自 main 侧读取的 `SKILL.md`。
- 校验 skill 必须 installed、enabled、ready。
- 对 `SKILL.md` 内容保持现有规则：read silently；不要在回答中引用、转述或总结 skill 原文。
- 该 block 标记为 request stability，避免被误认为长期 memory 或全局能力。

## Data Flow

1. Renderer 输入框提交前解析 `/skill`。
2. 解析成功后构造 `ChatTaskSubmitPayload`：`input` 为去除命令前缀后的正文，`explicitSkillIds` 为指定 id。
3. `useAppTaskRuns.startChatRun()` 把 `explicitSkillIds` 透传到 `chatFeature.startRun()`。
4. agent plugin schema 校验 `explicitSkillIds`。
5. `AgentPluginRuntime.startRun()` 保存用户正文，不保存命令前缀。
6. `AgentDeepAgentExecutor` 根据 `request.explicitSkillIds` 调用 skills 能力读取 `SKILL.md`。
7. `assembleContextHarness()` 接收已加载 skill block，拼入 system prompt。
8. DeepAgent 运行时仍接收原有 `enabledCapabilities.skills` 和 `skillSources`。

## Validation And Errors

Renderer validation:

- 只做格式检查：缺少 id、缺少正文。
- 不根据本地 stale `state.skills` 做最终判定。

Main validation:

- `skill_not_found`：找不到 skill。
- `skill_disabled`：skill 未启用。
- `skill_invalid`：skill 非 ready。
- `explicit_skill_read_failed`：`SKILL.md` 读取失败或不是 text。

Main 返回的错误沿用现有 `chatRun.setError()` 展示路径。

## Testing

Focused tests:

- renderer parser：`/skill python-expert 优化` -> `{ input: '优化', explicitSkillIds: ['python-expert'] }`。
- renderer parser：普通 `/skills` 或正文中 `/skill` 不触发。
- chat submit：带 `/skill` 时 run request 保留当前 `enabledCapabilities.skills`，同时携带 `explicitSkillIds`。
- agent schema：接受 `explicitSkillIds`，拒绝空 id。
- executor/context：显式 skill 的 `SKILL.md` 出现在 system prompt；非显式 skill 只出现在 catalog/description，不预读全文。
- error path：disabled/invalid/missing skill 不启动 run，并返回明确错误。

Verification:

```powershell
pnpm test -- tests/renderer/chat-composer.test.ts tests/renderer/chat-view.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/plugins/agent/plugin.test.ts
pnpm typecheck
git diff --check
```

## References

- Local Roc context: `src/renderer/chat/chat-composer.tsx`, `src/renderer/app/use-app-task-runs.ts`, `src/main/plugins/agent/deep-agent-executor.ts`, `src/main/services/deep-agent/context/context-assembler.ts`, `src/main/services/skill-service.ts`.
- Codex source reference: `openai/codex` at `c38b2e9ba69cb57d197c6e5ba78b5e52ae0870f9`, especially `codex-rs/tui/src/bottom_pane/prompt_args.rs`, `slash_commands.rs`, and `chat_composer.rs`.
- Deep Agents reference: skills are configured as directories and loaded on demand; explicit command loading must therefore be request-scoped context injection in Roc.
