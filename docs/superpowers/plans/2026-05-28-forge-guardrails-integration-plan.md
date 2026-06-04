# Forge Guardrails Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 forge 全部护栏思想（rescue parsing、retry nudge、unknown tool nudge、step enforcement、prerequisite、tool resolution、tiered compaction、合成 `respond` 工具、采样默认值、错误预算）作为 LangChain v1 `AgentMiddleware` 引入 Roc 的 `deepagents` 链路；同步完成 propose_background_task 拆三步、`read_background_task` + 取消预注入、`confirm_with_user` terminal tool、`workflowHint` 信号通路，并对既有 `llama_cpp` Provider 接入本地采样默认值。

**Architecture:** 不引入 forge Python 包；所有逻辑用 TypeScript 复刻为 LangChain v1 middleware，通过 `createDeepAgent({ middleware: [...] })` 注入 deepagents 既有循环。复用 LangChain `contextEditingMiddleware` 承载 TieredCompact 三阶段；deepagents `createSummarizationMiddleware` 保留不动。八条护栏的执行顺序按 `chainToolCallHandlers` 的"列表首项最外层"语义编排。

**Tech Stack:** TypeScript / Electron IPC / React 19 / Deep Agents 1.10.2 / LangChain 1.4.1 / LangGraph 1.3.2 / SQLite task events / Vitest / Playwright smoke

**Spec:** `docs/superpowers/specs/2026-05-28-forge-guardrails-integration-design.md` —— 必须先读完。本 plan 不重述 spec 决策依据；任何与 spec 冲突的地方应**先改 spec 再改 plan**，不允许在 plan 阶段擅自变更设计。

---

## Plan Revision Notes (2026-05-28 第二轮)

第一轮 plan 评审定位出 6 类必修/强烈建议项，本轮已对齐 LangChain v1 / LangGraph / deepagents JS 最新文档全部修正。修订要点如下：

### A 类（必修，已修正）

- **A-1 / `jumpTo` 的真实签名**：`jumpTo` 是 LangChain v1 `createMiddleware` hook 的合法返回字段，但必须以 `{ canJumpTo: [...], hook: (state) => ... }` 对象形态包装；合法目标仅 `'end' | 'tools' | 'model'`。本 plan 内所有用到 `jumpTo` 的 middleware（response-validation、step-enforcement）已统一为对象形态并显式声明 `canJumpTo: ['model']`。不需要 jumpTo 的 hook（rescue-parsing、tool-resolution、error-budget.afterModel）保持纯函数形态。来源：[`docs.langchain.com/oss/javascript/langchain/middleware/custom`](https://docs.langchain.com/oss/javascript/langchain/middleware/custom)
- **A-2 / `wrapToolCall` 同时更新 state 与返回 ToolMessage**：唯一合法写法是返回 `Command({ update: { messages: [toolMessage], forge_*_tracker: {...} } })`。本 plan `error-budget.ts` 与 `step-enforcement.ts` 的 `wrapToolCall` 已统一为 `Command` 返回。来源：[`docs.langchain.com/oss/javascript/langchain/tools`](https://docs.langchain.com/oss/javascript/langchain/tools)（Tool 返回 Command 示例）+ [`docs.langchain.com/oss/javascript/langchain/middleware/custom`](https://docs.langchain.com/oss/javascript/langchain/middleware/custom)（wrapModelCall 返回 Command 示例同构）
- **A-3 / `RemoveMessage` 导入路径**：`import { RemoveMessage } from '@langchain/core/messages'`；删全部用 `REMOVE_ALL_MESSAGES from '@langchain/langgraph'`。配合 deepagents 默认的 `MessagesValue` reducer 工作。本 plan `afterAgent` 清理已使用正确导入。来源：[`docs.langchain.com/oss/javascript/langgraph/add-memory`](https://docs.langchain.com/oss/javascript/langgraph/add-memory)
- **B-2 / `beforeAgent` sticky `requiredSteps`**：resume 时 workflowHint 为 null，会让 `beforeAgent` 把 `requiredSteps / terminalTools` 错误覆盖为空。本 plan 已改为 sticky 初始化（仅在首次 turn 写入）。

### C 类（强烈建议，已修正）

- **B-1 / 显式 `iterationIndex` 入 state**：`forge_step_tracker.iterationIndex: number` 由 `beforeModel` 每次自增；TieredCompact 通过 message 的 `additional_kwargs.forge_iteration_index` 而非 AIMessage 位置计数定位 keepRecent 边界。这才符合 forge 原则 2.3 "control flow ≠ memory"。
- **C-1 / 用官方 `toolRetryMiddleware` 替代 LangGraph 节点级 `RetryPolicy`**：deepagents 不暴露 tool node 的 retryPolicy；LangChain v1 已经有官方 `toolRetryMiddleware({ maxRetries, tools, retryOn, backoffFactor })`。本 plan 把它放在 middleware 列表**首位**（最外层），吸收 `web_read` / `schedule_background_task` / `update_background_task` / `cancel_background_task` 的网络瞬时错误，避免被 forge `consecutive_tool_errors` 错误占用。来源：[`docs.langchain.com/oss/javascript/langchain/middleware/built-in`](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in)（Tool retry）+ [`docs.langchain.com/oss/javascript/deepagents/going-to-production`](https://docs.langchain.com/oss/javascript/deepagents/going-to-production)
- **C-2 / tokenCountMethod**：本地 `langchain@1.4.1` 中 `ContextEditingMiddlewareConfig.tokenCountMethod?: 'approx' | 'model'` 是真实字段，默认值为 `'approx'`。本 plan 显式使用 `tokenCountMethod: 'approx'`，并让每个 `ContextEdit.apply` 通过传入的 `countTokens` 计算实际 token 数。budget 默认 7168（8192 减 12% safety margin）。
- **D / 跨护栏集成测试**：Phase 7 / Phase 10 已新增三例测试：(a) rescue → step_tracker 累加；(b) TieredCompact 后 step_tracker 与 error_tracker 不丢；(c) HITL 中断 resume 后 workflow sticky 续跑（B-2 回归保护）。

### `ContextEdit` 接口真实签名

经核对本地 `langchain@1.4.1`：

```typescript
interface ContextEdit {
  apply(params: {
    messages: BaseMessage[];                                       // 就地修改
    countTokens: (messages: BaseMessage[]) => Promise<number>;     // 自动注入
    model?: BaseLanguageModel;                                     // 可选
  }): void | Promise<void>;
}
```

来源：`node_modules/langchain/dist/agents/middleware/contextEditing.d.ts`。不需要返回 token 数（in-place mutation）。本 plan `ForgeDropNudgesEdit` / `ForgeTruncateToolResultsEdit` / `ForgeDropToolResultsEdit` / `ForgeDropReasoningTextEdit` 全部对齐此接口。

---

## Issue Frame

### Goal

让 Roc 在面对**本地小模型**与**云端大模型**时都能：

- 把"野生格式"工具调用（Mistral `[TOOL_CALLS]` / Qwen XML / JSON fence / rehearsal）救回结构化 tool_calls；
- 把"调错工具名"喂回模型让它纠正而非整轮失败；
- 把"该调工具时输出裸文本"通过 nudge 矫正；
- 把"工具参数对不上数据"（HTTP 4xx 类）与"工具崩溃"（5xx 类）分别计数；
- 在严肃工作流（propose background task）里强制步骤顺序与前置依赖（`read → edit`、`read_background_task → update/cancel`）；
- 在小模型上注入合成 `respond` 工具规避"文本/工具二选一"的开放式抉择；
- 在多轮长对话中用 forge 风格三阶段确定性压缩保留 reasoning 优先于 tool_result；
- 在长对话之间过滤掉 transient nudge 消息避免污染下一轮 context。

### Root Cause

Roc 当前不存在任何 forge 风格护栏：

- `error-mapping.ts` 把 `tool_input_schema_invalid` 直接当作 RunFailure 终结，模型没有自纠机会；
- `propose_background_task` 是"一步到位 create+register"，没有可强制的步骤序列；
- `openBackgroundTaskInChat` 通过 `pendingThreadContexts.enqueue` 把 task JSON 预注入到 input 前面，违背 forge "control flow ≠ memory" 哲学；
- `ProviderConfig.options` 让用户自填采样参数，没有 family 默认表；
- `ChatStartRunRequest` 无法区分"propose 流程"与"普通 chat"，无法承载 step enforcement workflow 选择；
- 上下文压缩走 deepagents `createSummarizationMiddleware`（LLM 摘要），缺少 forge 风格的"reasoning 优先于 tool_result 保留"的确定性裁剪策略；
- 本地 LangChain 执行面已有 `llama_cpp` Provider；本批不新增 Provider 分支。

### Scope

In scope:

- 新增 `src/main/services/forge-guardrails/` 目录及其 19 个文件（8 个基础数据/函数 + 8 个 middleware（含 forge-cleanup）+ 1 个 preview-store + index/barrel）；
- 改造 `deep-agent/agent-builder.ts`、`deep-agent/session.ts`、`deep-agent/tools.ts`、`deep-agent/background-task-tools.ts`、`deep-agent/stream-consumers.ts`、`deep-agent/error-mapping.ts`、`deep-agent-runtime-service.ts`、`task-service.ts`、`langchain-model-factory.ts`；
- 扩展 `ChatStartRunRequest` 加 `workflowHint` 字段并贯穿 preload / ipc / runtime / session / agent-builder；
- 新增三个工具：`schedule_background_task`、`read_background_task`、`confirm_with_user`；改造 `propose_background_task` 不再创建 DB 记录；
- 删除 `openBackgroundTaskInChat` 中的 `pendingThreadContexts.enqueue` 注入；
- `TasksView.submitTaskDescription` 改为传 `workflowHint: 'propose_background_task'`，input 不再用 `buildTaskProposalPrompt` 包装；
- 新增 task event 类型 `'guardrail_nudge'`，nudge 消息跨 turn 过滤；
- 对既有 `llama_cpp` Provider 接入 sampling defaults 与 `contextBudgetTokens`；
- 对应单元测试与少量集成测试。

Out of scope:

- forge 26 场景 eval harness、ablation 评测；
- vLLM Provider；
- Llamafile prompt-injected fallback；
- SlotWorker（多会话 GPU 抢占）；
- `BudgetMode` 自动 VRAM 探测——`contextBudgetTokens` 默认 8192，可由 `ProviderConfig.options` 覆盖；
- forge `cache_control` 保留——deepagents `anthropicPromptCachingMiddleware` 已经在做等价工作；
- `buildTaskProposalPrompt` 的彻底删除——本批仅标记 `@deprecated`；
- 任何向 deepagents / LangChain monkey-patch；
- UI 重设计——只在 TaskWorkbench 的现有面板基础上做最小渲染补丁。

### Acceptance Criteria

详见 spec `§Acceptance Criteria` 与新增 `§3.5 验收增量`。本 plan 在每个 Phase 末尾给出该 Phase 的具体可执行验收命令，最后在 `Phase 12: Verification Matrix` 汇总。

---

## File Structure

### Create

```text
src/main/services/forge-guardrails/
├── index.ts                                # barrel
├── errors.ts                               # RocToolResolutionError
├── message-tags.ts                         # forge_message_type 读写 + transient/compaction 集合
├── state-schema.ts                         # LangGraph StateSchema + ReducedValue
├── nudge-templates.ts                      # 翻译 forge nudges.py
├── rescue-parser.ts                        # 翻译 forge templates.py 的 4 种格式
├── sampling-defaults.ts                    # MODEL_SAMPLING_DEFAULTS + apply 函数
├── prerequisites-config.ts                 # ROC_PREREQUISITES + ROC_WORKFLOWS
├── respond-tool.ts                         # 合成 respond ClientTool
├── preview-store.ts                        # session 范围 Map<previewId, BackgroundTaskPreview>
├── workflow-resolver.ts                    # workflowResolver(context) -> WorkflowSpec | null
├── middleware/
│   ├── rescue-parsing.ts
│   ├── respond-tool-injection.ts
│   ├── response-validation.ts
│   ├── step-enforcement.ts                 # 同时承载 prerequisite 检查
│   ├── tool-resolution.ts
│   ├── error-budget.ts
│   ├── forge-tiered-compaction.ts          # 4 个 ContextEdit + contextEditingMiddleware 包装
│   └── forge-cleanup.ts                    # afterAgent 清理 transient nudge（第二轮新增）
└── README.md                               # 模块顶层文档：8 条护栏与 hook 落点表

tests/main/services/forge-guardrails/
├── errors.test.ts
├── message-tags.test.ts
├── nudge-templates.test.ts
├── rescue-parser.test.ts                   # 4 种格式各 2-3 个 case
├── sampling-defaults.test.ts
├── prerequisites-config.test.ts
├── preview-store.test.ts
├── workflow-resolver.test.ts
├── middleware/
│   ├── rescue-parsing.test.ts
│   ├── respond-tool-injection.test.ts
│   ├── response-validation.test.ts
│   ├── step-enforcement.test.ts
│   ├── tool-resolution.test.ts
│   ├── error-budget.test.ts
│   ├── forge-tiered-compaction.test.ts
│   └── forge-cleanup.test.ts               # 第二轮新增
└── integration/
    ├── propose-workflow.test.ts            # propose -> schedule -> confirm 完整链 + 跳步骤回退 + 跨护栏 rescue→tracker（第二轮新增 2 例）
    ├── background-task-change.test.ts      # read -> update / cancel 完整链 + 漏 read 回退 + B-2 resume sticky 回归（第二轮新增 1 例）
    └── full-stack.test.ts                  # 端到端：本地 Provider rescue + step nudge + 错误预算耗尽（Phase 10）

tests/main/services/deep-agent/
├── background-task-tools-propose-schedule.test.ts
├── read-background-task.test.ts
└── confirm-with-user.test.ts
```

### Modify

```text
src/shared/types/chat.ts
  ChatStartRunRequest 加 workflowHint 字段、新增 WorkflowHint 联合类型

src/shared/types/task.ts
  TaskEvent['type'] 加 'guardrail_nudge'

src/shared/types.ts (barrel)
  re-export WorkflowHint

src/preload/index.ts
  chat.startRun 透传 workflowHint

src/main/ipc/register-ipc.ts
  透传 workflowHint 到 DeepAgentRuntimeService.startRun

src/main/services/langchain-model-factory.ts
  - 对 llama_cpp 调 resolveSamplingProfile + applyProviderOverride
  - runtime 加 contextBudgetTokens

src/shared/types/settings.ts
  ProviderConfig.options 加 contextBudgetTokens、samplingProfileOverrides

src/main/services/deep-agent-runtime-service.ts
  - RunExecutionContext 加 workflowHint、previewStore
  - executeRun / executeResume 透传
  - consumeSessionStreams 接受新事件类型 guardrail_nudge

src/main/services/deep-agent/types.ts
  扩展 RunExecutionContext、DeepAgentBuildInput

src/main/services/deep-agent/session.ts
  - 创建 previewStore（按 run 一份）
  - 把 workflowHint、providerType、contextBudgetTokens 传给 buildDeepAgent
  - 在 initial_messages 重放前过滤 forge transient 标签消息

src/main/services/deep-agent/agent-builder.ts
  编排 8 条 forge guardrails 注入 createDeepAgent({middleware:[...]})

src/main/services/deep-agent/tools.ts
  - createReadBackgroundTaskTool
  - createConfirmWithUserTool
  - createRunTools 集合中暴露上述工具

src/main/services/deep-agent/background-task-tools.ts
  - propose_background_task callable 改为只生成 preview 入 previewStore
  - 新增 schedule_background_task callable
  - 业务级失败（taskId 不存在 / previewId 不存在）抛 RocToolResolutionError
  - update / cancel 工具描述与 schema 保留不变

src/main/services/deep-agent/stream-consumers.ts
  识别 forge_message_type 标签、分流 'guardrail_nudge' 事件、保留 reasoning chunk 通道

src/main/services/deep-agent/error-mapping.ts
  补 RocToolResolutionError 识别分支与 forge_*_exhausted 错误代码分类

src/main/services/task-service.ts
  openBackgroundTaskInChat 删除 pendingThreadContexts.enqueue 调用、保留事件记录与 {threadId} 返回

src/main/services/agent-service.ts
  createBackgroundTaskCard 增加 schedule_background_task、read_background_task、confirm_with_user 三张卡片

src/main/services/deep-agent/prompt.ts
  在 buildSystemPrompt 中根据 workflowHint 追加工作流概述（仅声明工具集与可用动作，不告诉模型 prereq / required_steps）

src/shared/background-task-tool-contract.ts
  buildTaskProposalPrompt 加 @deprecated JSDoc

src/renderer/views/tasks/TasksView.tsx
  submitTaskDescription 改为传 workflowHint: 'propose_background_task'，input 用用户原话

src/renderer/App.tsx
  startTaskRun 接受 workflowHint 入参

src/main/services/task-service.ts （二次修改）
  recordEvent / recordEvents 允许 'guardrail_nudge' 类型

src/shared/types.ts
  扩展 ChatRunEvent 增加 guardrail_nudge 子类型（如需 UI 显示则加；否则纯审计可不加）
```

### Tests To Modify

```text
tests/main/deep-agent-runtime-service.test.ts
  - 增加 workflowHint 透传到 session 的测试
  - 增加 guardrail_nudge 事件被 recordTaskEvent 接受的测试

tests/main/app-services.tasks.test.ts
  增加 propose -> schedule -> confirm 跑通 vs 漏 schedule 的回归

tests/renderer/tasks-view.test.ts
tests/renderer/tasks-view.interaction.test.ts
  TasksView submitTaskDescription 传 workflowHint 的回归

tests/smoke/electron-smoke.mjs
  smoke 中新增"propose -> schedule -> confirm 链路"的最小验证
```

---

## Phase 0: Module Scaffold

**Goal:** 创建 `forge-guardrails/` 目录骨架与空 README，建立后续 Phase 的工作场；不新增 Provider 依赖。

**Files:**
- Create: `src/main/services/forge-guardrails/README.md`、`src/main/services/forge-guardrails/index.ts`（空 barrel）

- [ ] **Step 1: 创建模块骨架与 README**

创建 `src/main/services/forge-guardrails/README.md`：

```markdown
# Forge Guardrails

把 forge 的护栏思想以 LangChain v1 AgentMiddleware 形式接入 Roc 的 deepagents 链路。

详细设计见 `docs/superpowers/specs/2026-05-28-forge-guardrails-integration-design.md`。

## 模块布局

- `errors.ts` — RocToolResolutionError
- `message-tags.ts` — forge_message_type 标签
- `state-schema.ts` — LangGraph state schema
- `nudge-templates.ts` — nudge 文案
- `rescue-parser.ts` — 4 种野生格式解析
- `sampling-defaults.ts` — 采样默认值
- `prerequisites-config.ts` — prereq + workflow 配置
- `respond-tool.ts` — 合成 respond ClientTool
- `preview-store.ts` — propose preview session-scoped 缓存
- `workflow-resolver.ts` — workflowHint -> WorkflowSpec
- `middleware/*` — 7 个 LangChain middleware
```

创建空 barrel `src/main/services/forge-guardrails/index.ts`：

```ts
// 后续 Phase 逐步填充导出
export {};
```

- [ ] **Step 2: 验证并提 Phase 0 PR**

```powershell
pnpm typecheck
```

```powershell
git checkout -b feat/forge-guardrails-phase-0
git add src/main/services/forge-guardrails/
git commit -m "chore(forge-guardrails): Phase 0 - module scaffold"
```

Expected: PR 通过 `pnpm typecheck` 与既有 `pnpm test` 全套——本 Phase 不引入业务逻辑、不应回归任何测试。

---

## Phase 1: 基础层（纯数据 / 函数 / LangGraph StateSchema）

**Goal:** 实现 8 个纯函数 / 数据模块。无 middleware、无 deepagents 依赖、无 LangChain runtime 依赖（除了 zod 与 `@langchain/core` 类型）。建立后续 Phase 可消费的基础设施。

**Dependencies:** Phase 0 完成。

**Files:**
- Create: `errors.ts`、`message-tags.ts`、`state-schema.ts`、`nudge-templates.ts`、`rescue-parser.ts`、`sampling-defaults.ts`、`prerequisites-config.ts`、`respond-tool.ts`、`preview-store.ts`、`workflow-resolver.ts`
- Create: 对应 10 个单元测试文件
- Modify: `forge-guardrails/index.ts` 加入导出

### Step 1.1: `errors.ts` — `RocToolResolutionError`

```ts
// src/main/services/forge-guardrails/errors.ts
/**
 * 工具调用合法但参数对不上数据（HTTP 4xx 类）。
 *
 * 工具作者抛出后，wrapToolCall 中间件把它转为 ToolMessage
 * 喂回模型，不计入 consecutive_tool_errors，不记录步骤完成。
 *
 * 故意不继承 RocDomainError——这是工具作者契约，不是框架错误。
 * 见 forge ADR-010。
 */
export class RocToolResolutionError extends Error {
  readonly toolName: string | null;

  constructor(message: string, options?: { toolName?: string }) {
    super(message);
    this.name = 'RocToolResolutionError';
    this.toolName = options?.toolName ?? null;
  }
}

/**
 * 八条 forge 护栏耗尽时使用的错误代码命名空间。
 * RocDomainError 用以下 code，由 error-mapping.ts 识别后转为 RunFailure。
 */
export const FORGE_EXHAUSTED_CODES = {
  retries: 'forge_retries_exhausted',
  toolErrors: 'forge_tool_errors_exhausted',
  stepEnforcement: 'forge_step_enforcement_exhausted',
  prerequisite: 'forge_prerequisite_exhausted',
} as const;

export type ForgeExhaustedCode = (typeof FORGE_EXHAUSTED_CODES)[keyof typeof FORGE_EXHAUSTED_CODES];
```

测试 `tests/main/services/forge-guardrails/errors.test.ts`：

- `new RocToolResolutionError('x')` instanceof Error；`name === 'RocToolResolutionError'`；不 instanceof RocDomainError；`toolName === null`。
- 传 `{toolName: 'read_file'}` → `toolName === 'read_file'`。
- `FORGE_EXHAUSTED_CODES` 全部四项落在 `'forge_*_exhausted'` 字面量。

### Step 1.2: `message-tags.ts` — 消息标签读写

```ts
// src/main/services/forge-guardrails/message-tags.ts
import type { BaseMessage } from '@langchain/core/messages';

export type ForgeMessageType =
  | 'forge:retry_nudge'
  | 'forge:unknown_tool_nudge'
  | 'forge:step_nudge'
  | 'forge:prerequisite_nudge'
  | 'forge:tool_resolution'
  | 'forge:reasoning'
  | 'forge:context_warning'
  | 'forge:respond_synthetic';

const TAG_KEY = 'forge_message_type';

export function tagForgeMessage<M extends BaseMessage>(message: M, type: ForgeMessageType): M {
  // additional_kwargs 是 plain object，直接 mutate 在 LangChain v1 安全（消息对象在 graph 内是不可变拷贝）
  const kwargs = (message.additional_kwargs ??= {});
  kwargs[TAG_KEY] = type;
  return message;
}

export function readForgeMessageTag(message: BaseMessage): ForgeMessageType | null {
  const value = message.additional_kwargs?.[TAG_KEY];
  return isForgeMessageType(value) ? value : null;
}

function isForgeMessageType(value: unknown): value is ForgeMessageType {
  return (
    value === 'forge:retry_nudge' ||
    value === 'forge:unknown_tool_nudge' ||
    value === 'forge:step_nudge' ||
    value === 'forge:prerequisite_nudge' ||
    value === 'forge:tool_resolution' ||
    value === 'forge:reasoning' ||
    value === 'forge:context_warning' ||
    value === 'forge:respond_synthetic'
  );
}

/**
 * 跨 turn 应过滤的 transient 标签集合。
 * forge USER_GUIDE.md "Long-Running Sessions: Filtering Transient Messages" 章节定义。
 */
export const FORGE_TRANSIENT_TYPES: ReadonlySet<ForgeMessageType> = new Set([
  'forge:retry_nudge',
  'forge:unknown_tool_nudge',
  'forge:step_nudge',
  'forge:prerequisite_nudge',
  'forge:context_warning',
]);

export function isForgeTransientMessage(message: BaseMessage): boolean {
  const tag = readForgeMessageTag(message);
  return tag !== null && FORGE_TRANSIENT_TYPES.has(tag);
}

/**
 * TieredCompact 各阶段读取的 cut-priority。
 * 数字越小越先被丢；从 1 开始。
 */
export const FORGE_COMPACTION_PRIORITY: Record<ForgeMessageType, number> = {
  'forge:retry_nudge': 1,
  'forge:step_nudge': 1,
  'forge:prerequisite_nudge': 1,
  'forge:context_warning': 1,
  // tool_result 在 message-tags 这里不打 tag——它通过 LangChain ToolMessage 类识别。
  'forge:tool_resolution': 2,    // 软错误工具结果，按 tool_result 同优先级
  'forge:respond_synthetic': 3,  // 已经是终止信号，TieredCompact 不主动丢
  'forge:reasoning': 4,           // 保留到 phase 3
  'forge:unknown_tool_nudge': 1,
};
```

测试 `message-tags.test.ts`：

- `tagForgeMessage(new HumanMessage('x'), 'forge:retry_nudge')` 后 `readForgeMessageTag(msg) === 'forge:retry_nudge'`。
- `readForgeMessageTag(new HumanMessage('x'))` 无 tag 时 `=== null`。
- `additional_kwargs.forge_message_type = 'invalid'` 时 `readForgeMessageTag === null`（不抛错）。
- `isForgeTransientMessage` 在 5 个 transient 类型上返回 true、在 reasoning / tool_resolution / respond_synthetic 上返回 false。
- 多次 `tagForgeMessage` 覆盖同一 message：最后一次写的值生效。
- `tag` 后写入的 `additional_kwargs` 引用与原对象同（不重建 message）。

### Step 1.3: `state-schema.ts` — LangGraph state schema

```ts
// src/main/services/forge-guardrails/state-schema.ts
import type { BaseMessage } from '@langchain/core/messages';
import { ReducedValue, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';

const stepTrackerSchema = z.object({
  executedTools: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).default(() => ({})),
  requiredSteps: z.array(z.string()).default(() => []),
  terminalTools: z.array(z.string()).default(() => []),
  // forge 原则 2.3 "control flow ≠ memory"：iteration 计数独立于消息历史。
  // 每次 beforeModel 自增；TieredCompact 通过它定位 keepRecent 边界，而非数 AIMessage。
  iterationIndex: z.number().int().nonnegative().default(0),
  prematureAttempts: z.number().int().nonnegative().default(0),
  prereqViolations: z.number().int().nonnegative().default(0),
});

const stepTrackerUpdateSchema = stepTrackerSchema.partial();

const errorTrackerSchema = z.object({
  consecutiveRetries: z.number().int().nonnegative().default(0),
  consecutiveToolErrors: z.number().int().nonnegative().default(0),
  maxRetries: z.number().int().positive().default(3),
  maxToolErrors: z.number().int().positive().default(2),
  maxPrematureAttempts: z.number().int().positive().default(3),
  maxPrereqViolations: z.number().int().positive().default(2),
});

const errorTrackerUpdateSchema = errorTrackerSchema.partial();

function defaultStepTracker(): z.infer<typeof stepTrackerSchema> {
  return stepTrackerSchema.parse({});
}

function defaultErrorTracker(): z.infer<typeof errorTrackerSchema> {
  return errorTrackerSchema.parse({});
}

function mergeStepTracker(
  current: z.infer<typeof stepTrackerSchema> | undefined,
  update: z.infer<typeof stepTrackerUpdateSchema> | undefined,
): z.infer<typeof stepTrackerSchema> {
  const base = { ...defaultStepTracker(), ...current };
  if (update === undefined) return base;
  return {
    ...base,
    ...update,
    executedTools: {
      ...base.executedTools,
      ...(update.executedTools ?? {}),
    },
  };
}

function mergeErrorTracker(
  current: z.infer<typeof errorTrackerSchema> | undefined,
  update: z.infer<typeof errorTrackerUpdateSchema> | undefined,
): z.infer<typeof errorTrackerSchema> {
  return { ...defaultErrorTracker(), ...current, ...update };
}

export const forgeGuardrailsStateSchema = new StateSchema({
  forge_step_tracker: new ReducedValue(stepTrackerSchema.default(defaultStepTracker), {
    inputSchema: stepTrackerUpdateSchema,
    reducer: mergeStepTracker,
  }),
  forge_error_tracker: new ReducedValue(errorTrackerSchema.default(defaultErrorTracker), {
    inputSchema: errorTrackerUpdateSchema,
    reducer: mergeErrorTracker,
  }),
});

export type ForgeStepTrackerState = z.infer<typeof stepTrackerSchema>;
export type ForgeErrorTrackerState = z.infer<typeof errorTrackerSchema>;
export type ForgeGuardrailsState = typeof forgeGuardrailsStateSchema.State;
export type ForgeGuardrailsUpdate = typeof forgeGuardrailsStateSchema.Update;

/**
 * StepTracker 工具方法：根据 prereq 规则判定是否满足。
 */
export type PrereqRule =
  | { kind: 'nameOnly'; tool: string }
  | { kind: 'argMatched'; tool: string; matchArg: string };

export function checkPrerequisitesMet(
  state: ForgeStepTrackerState,
  toolName: string,
  args: Record<string, unknown>,
  rules: PrereqRule[]
): { satisfied: true } | { satisfied: false; missing: string[] } {
  const missing: string[] = [];
  for (const rule of rules) {
    const executions = state.executedTools[rule.tool] ?? [];
    if (rule.kind === 'nameOnly') {
      if (executions.length === 0) {
        missing.push(rule.tool);
      }
      continue;
    }
    // argMatched: 历史执行中存在某一次 args[matchArg] === current args[matchArg]
    const currentValue = args[rule.matchArg];
    const matched = executions.some((prevArgs) => prevArgs[rule.matchArg] === currentValue);
    if (!matched) {
      missing.push(`${rule.tool}(${rule.matchArg}=${JSON.stringify(currentValue)})`);
    }
  }
  return missing.length === 0 ? { satisfied: true } : { satisfied: false, missing };
}

export function recordToolExecution(
  state: ForgeStepTrackerState,
  toolName: string,
  args: Record<string, unknown>
): ForgeStepTrackerState {
  const previous = state.executedTools[toolName] ?? [];
  return {
    ...state,
    executedTools: {
      ...state.executedTools,
      [toolName]: [...previous, args],
    },
  };
}

/**
 * 自增 iterationIndex。由 step-enforcement.beforeModel 在每次进入 model 前调用。
 * 与 messages.length 无关，是 forge 原则 2.3 的承重点。
 */
export function bumpIteration(state: ForgeStepTrackerState): ForgeStepTrackerState {
  return { ...state, iterationIndex: state.iterationIndex + 1 };
}

/**
 * 把当前 iterationIndex 标到 message.additional_kwargs，供 TieredCompact 后续定位
 * keepRecent 边界。返回原 message（mutated in place，LangChain v1 安全）。
 */
export function markIterationOnMessage(message: BaseMessage, iterationIndex: number): BaseMessage {
  const kwargs = (message.additional_kwargs ??= {});
  kwargs.forge_iteration_index = iterationIndex;
  return message;
}

export function readIterationFromMessage(message: BaseMessage): number | null {
  const value = message.additional_kwargs?.forge_iteration_index;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function areRequiredStepsSatisfied(state: ForgeStepTrackerState): boolean {
  return state.requiredSteps.every((step) => (state.executedTools[step] ?? []).length > 0);
}

export function pendingRequiredSteps(state: ForgeStepTrackerState): string[] {
  return state.requiredSteps.filter((step) => (state.executedTools[step] ?? []).length === 0);
}
```

测试 `state-schema.test.ts`：

- `StateSchema.isInstance(forgeGuardrailsStateSchema)` 为 true；`forge_step_tracker` / `forge_error_tracker` 都是 `ReducedValue`。
- `defaultStepTracker()` / `defaultErrorTracker()` 应填充默认值，所有计数器为 0、`iterationIndex === 0`、max 字段为默认。
- `mergeStepTracker` 应在两个 update 分别写入不同 `executedTools` 时保留两者，避免并行 tool batch 下最后一次写入覆盖前一次。
- `recordToolExecution` 不变更原 state（immutable），返回新 state 中 `executedTools.read_file` 长度 +1。
- `checkPrerequisitesMet` 在 nameOnly 规则下：未调过 → `satisfied: false`、`missing: ['read_file']`；调过 → satisfied。
- argMatched 规则下:调过 `read_file(path='/a')` 但 current `args.path='/b'` → 不满足；current `args.path='/a'` → 满足。
- `areRequiredStepsSatisfied` 与 `pendingRequiredSteps` 在空 requiredSteps 下 `true` / 空列表；要求 `['A','B']` 但只调过 A → false / `['B']`。
- `bumpIteration({iterationIndex: 0, ...})` → `iterationIndex === 1`；连续 3 次后 `=== 3`；原 state 不变（immutable）。
- `markIterationOnMessage(msg, 7)` 后 `readIterationFromMessage(msg) === 7`；写入 message.additional_kwargs.forge_iteration_index === 7。
- `readIterationFromMessage` 对无标签 message 返回 `null`；对非数字 / 负数 / 小数返回 `null`。

### Step 1.4: `nudge-templates.ts` — nudge 文案

按 `forge/src/forge/prompts/nudges.py` 翻译。所有文案中文化以适配 Roc 的语言策略（forge 是英文，Roc 强制中文响应；nudge 给模型看，但 system prompt 是中文，nudge 用中文更不容易让模型切换语言）。

```ts
// src/main/services/forge-guardrails/nudge-templates.ts

export function retryNudge(rawResponse: string): string {
  return [
    '你上一条回复不是合法的工具调用。',
    '在当前回合中必须用工具调用回应，不要输出自由文本。',
    '请重新生成一条合法的工具调用。',
  ].join('\n');
}

export function unknownToolNudge(toolName: string, availableTools: readonly string[]): string {
  return [
    `工具 ${toolName} 不存在。`,
    `当前可用工具：${availableTools.join('、')}。`,
    '请从上述工具中选择一个调用。',
  ].join('\n');
}

export function stepNudge(
  attemptedTerminal: string,
  pendingSteps: readonly string[],
  tier: 1 | 2 | 3
): string {
  const steps = pendingSteps.join('、');
  if (tier === 1) {
    return [
      `还不能调用 ${attemptedTerminal}。`,
      `必须先完成这些步骤：${steps}。`,
      '请立即调用其中之一。',
    ].join('\n');
  }
  if (tier === 2) {
    return [`必须立刻调用以下工具之一：${steps}。请选择一个。`].join('\n');
  }
  return [
    `停止。必须调用以下工具之一：${steps}。`,
    `不要调用 ${attemptedTerminal}。`,
    `下一条回复必须是上述工具之一的调用。`,
  ].join('\n');
}

export function prerequisiteNudge(toolName: string, missingPrereqs: readonly string[]): string {
  return [
    `还不能调用 ${toolName}。`,
    `必须先调用：${missingPrereqs.join('、')}。`,
    '请立即调用前置工具。',
  ].join('\n');
}

/**
 * Context 水位告警（forge context/manager.py default_context_warning 中文版）
 */
export function contextWarning(tokens: number, budget: number): string | null {
  if (budget <= 0) {
    return null;
  }
  const pct = tokens / budget;
  if (pct >= 0.8) {
    return `[Context usage: ${(pct * 100).toFixed(0)}% (${tokens} / ${budget} tokens). 上下文接近上限。旧的工具结果与推理可能很快被压缩——请尽快总结关键发现并优先完成当前任务。]`;
  }
  if (pct >= 0.65) {
    return `[Context usage: ${(pct * 100).toFixed(0)}% (${tokens} / ${budget} tokens). 上下文使用增高。压缩触发后旧的工具结果与推理会被精简。请简洁回应、优先表达重要信息。]`;
  }
  return null;  // 阈值未到，不告警
}
```

测试 `nudge-templates.test.ts`：

- 每个函数对一组样例输入返回稳定字符串（snapshot）。
- `stepNudge` 三个 tier 文案不同；tier 越高越紧迫（包含"STOP"等关键词）。
- `prerequisiteNudge(['read_file'])` 输出中含 `read_file`。
- `contextWarning(800, 1000)` 返回 80% 告警；`(700, 1000)` 返回 70% 告警（中等）；`(600, 1000)` 返回 null。

### Step 1.5: `rescue-parser.ts` — 4 种野生格式解析

按 `forge/src/forge/prompts/templates.py:rescue_tool_call` 翻译。要点：先剥 think tag、再按 4 种策略尝试。

```ts
// src/main/services/forge-guardrails/rescue-parser.ts

export type RescueResult = {
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
  strategy: 'json_fence' | 'rehearsal' | 'qwen_xml' | 'mistral_bracket' | null;
  reasoningText: string | null;  // 剥离的 think tag 内容，供 reasoning chunk 通道
};

const THINK_TAG_RE = /\[THINK\][\s\S]*?\[\/THINK\]|<think>[\s\S]*?<\/think>/g;
const REHEARSAL_RE = /(\w+)\[ARGS\](\{[\s\S]*?\})/g;
const QWEN_FUNCTION_RE = /<function=([^>\s]+)>([\s\S]*?)<\/function>/g;
const QWEN_PARAMETER_RE = /<parameter=([^>\s]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|(?=<\/function>)|$)/g;
const MISTRAL_BRACKET_RE = /\[TOOL_CALLS\](\w+)\s*(?=\{)/g;

export function rescueToolCall(text: string, availableTools: readonly string[]): RescueResult {
  // Step 1: 提取并剥离 think 标签
  const reasoningChunks: string[] = [];
  const cleaned = text.replace(THINK_TAG_RE, (match) => {
    reasoningChunks.push(stripThinkTagWrapper(match));
    return '';
  }).trim();

  const reasoningText = reasoningChunks.length === 0 ? null : reasoningChunks.join('\n').trim();

  if (cleaned.length === 0) {
    return { toolCalls: [], strategy: null, reasoningText };
  }

  // Strategy 1: JSON fence + inline JSON brace-balance scan
  const jsonResults = extractJsonToolCalls(cleaned, availableTools);
  if (jsonResults.length > 0) {
    return { toolCalls: jsonResults, strategy: 'json_fence', reasoningText };
  }

  // Strategy 2: rehearsal syntax
  const rehearsalResults = extractRehearsalToolCalls(cleaned, availableTools);
  if (rehearsalResults.length > 0) {
    return { toolCalls: rehearsalResults, strategy: 'rehearsal', reasoningText };
  }

  // Strategy 3: Qwen XML
  const qwenResults = extractQwenXmlToolCalls(cleaned, availableTools);
  if (qwenResults.length > 0) {
    return { toolCalls: qwenResults, strategy: 'qwen_xml', reasoningText };
  }

  // Strategy 4: Mistral bracket
  const mistralResults = extractMistralBracketToolCalls(cleaned, availableTools);
  if (mistralResults.length > 0) {
    return { toolCalls: mistralResults, strategy: 'mistral_bracket', reasoningText };
  }

  return { toolCalls: [], strategy: null, reasoningText };
}

function stripThinkTagWrapper(raw: string): string {
  return raw
    .replace(/^\[THINK\]/i, '')
    .replace(/\[\/THINK\]$/i, '')
    .replace(/^<think>/i, '')
    .replace(/<\/think>$/i, '')
    .trim();
}

function extractJsonToolCalls(text: string, availableTools: readonly string[]): Array<{ tool: string; args: Record<string, unknown> }> {
  // 剥离 ```json / ``` 围栏
  const stripped = text.replace(/```(?:json)?\s*\n?/g, '').replace(/```/g, '');
  const found: Array<{ tool: string; args: Record<string, unknown> }> = [];

  let i = 0;
  while (i < stripped.length) {
    if (stripped[i] === '{') {
      let depth = 0;
      let inString = false;
      let escape = false;
      let end = -1;
      for (let j = i; j < stripped.length; j += 1) {
        const ch = stripped[j];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) { end = j; break; }
        }
      }
      if (end === -1) { i += 1; continue; }
      const candidate = stripped.slice(i, end + 1);
      const parsed = tryParseToolCall(candidate, availableTools);
      if (parsed !== null) {
        found.push(parsed);
        i = end + 1;
        continue;
      }
      i += 1;
    } else {
      i += 1;
    }
  }
  return found;
}

function tryParseToolCall(json: string, availableTools: readonly string[]): { tool: string; args: Record<string, unknown> } | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const obj = data as Record<string, unknown>;
  const toolName = typeof obj.tool === 'string' ? obj.tool : typeof obj.name === 'string' ? obj.name : null;
  if (toolName === null || !availableTools.includes(toolName)) {
    return null;
  }
  const argsRaw = obj.args ?? obj.arguments ?? {};
  if (typeof argsRaw !== 'object' || argsRaw === null || Array.isArray(argsRaw)) {
    return null;
  }
  return { tool: toolName, args: argsRaw as Record<string, unknown> };
}

function extractRehearsalToolCalls(text: string, availableTools: readonly string[]): Array<{ tool: string; args: Record<string, unknown> }> {
  const found: Array<{ tool: string; args: Record<string, unknown> }> = [];
  for (const match of text.matchAll(REHEARSAL_RE)) {
    const [, toolName, argsStr] = match;
    if (!availableTools.includes(toolName)) continue;
    try {
      const args = JSON.parse(argsStr);
      if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
        found.push({ tool: toolName, args: args as Record<string, unknown> });
      }
    } catch {
      // ignore
    }
  }
  return found;
}

function extractQwenXmlToolCalls(text: string, availableTools: readonly string[]): Array<{ tool: string; args: Record<string, unknown> }> {
  const found: Array<{ tool: string; args: Record<string, unknown> }> = [];
  for (const fnMatch of text.matchAll(QWEN_FUNCTION_RE)) {
    const toolName = fnMatch[1].trim();
    if (!availableTools.includes(toolName)) continue;
    const body = fnMatch[2];
    const args: Record<string, string> = {};
    // 重新创建一个 regex 实例，否则跨循环状态会污染 lastIndex
    const paramRe = new RegExp(QWEN_PARAMETER_RE.source, 'g');
    for (const paramMatch of body.matchAll(paramRe)) {
      const key = paramMatch[1].trim();
      let value = paramMatch[2];
      if (value.startsWith('\n')) value = value.slice(1);
      if (value.endsWith('\n')) value = value.slice(0, -1);
      args[key] = value;
    }
    found.push({ tool: toolName, args });
  }
  return found;
}

function extractMistralBracketToolCalls(text: string, availableTools: readonly string[]): Array<{ tool: string; args: Record<string, unknown> }> {
  const found: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const re = new RegExp(MISTRAL_BRACKET_RE.source, 'g');
  for (const match of text.matchAll(re)) {
    const toolName = match[1];
    if (!availableTools.includes(toolName)) continue;
    let i = match.index! + match[0].length;
    if (i >= text.length || text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) continue;
    const candidate = text.slice(i, end + 1);
    try {
      const args = JSON.parse(candidate);
      if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
        found.push({ tool: toolName, args: args as Record<string, unknown> });
      }
    } catch {
      // ignore
    }
  }
  return found;
}
```

测试 `rescue-parser.test.ts`：

| 用例 | 输入 | 期望 strategy | 期望 toolCalls |
|---|---|---|---|
| JSON fence | `` `\`\`\`json\n{"tool":"get_weather","args":{"city":"Paris"}}\n\`\`\`` `` | `json_fence` | `[{tool:'get_weather', args:{city:'Paris'}}]` |
| OpenAI-style JSON | `{"name":"get_weather","arguments":{"city":"NYC"}}` | `json_fence` | `[{tool:'get_weather', args:{city:'NYC'}}]` |
| 嵌入文本中的 JSON | `Sure, let me try: {"tool":"get_weather","args":{"city":"X"}} ok?` | `json_fence` | 一条 |
| Rehearsal | `get_weather[ARGS]{"city":"Paris"}` | `rehearsal` | 一条 |
| Qwen XML | `<function=get_weather><parameter=city>Paris</parameter></function>` | `qwen_xml` | `[{tool:'get_weather', args:{city:'Paris'}}]` |
| Mistral bracket | `[TOOL_CALLS]get_weather{"city":"Paris"}` | `mistral_bracket` | 一条 |
| Multiple Mistral bracket | `[TOOL_CALLS]A{"x":1}[TOOL_CALLS]B{"y":2}` | `mistral_bracket` | 两条 |
| think 包裹的 JSON | `<think>let me</think>\n{"tool":"x","args":{}}` | `json_fence` | 一条；`reasoningText === 'let me'` |
| 工具名不在 list | `{"tool":"unknown","args":{}}` | `null` | `[]` |
| 自由聊天文本 | `Hello, I am thinking about it.` | `null` | `[]` |
| 仅 think 无 JSON | `<think>thinking only</think>` | `null` | `[]`；`reasoningText === 'thinking only'` |
| JSON 中嵌套字符串含括号 | `{"tool":"x","args":{"q":"hello {world}"}}` | `json_fence` | `[{tool:'x', args:{q:'hello {world}'}}]` |

`availableTools` 在每个 case 中按需提供。

### Step 1.6: `sampling-defaults.ts` — 采样默认值

按 `forge/src/forge/clients/sampling_defaults.py` 翻译核心 family。本批仅录入有 HF card / 厂商文档直接出处的 family；未覆盖的 family 返回 null（行为同 forge "off, model unknown"）。

```ts
// src/main/services/forge-guardrails/sampling-defaults.ts

export type SamplingProfile = {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  repeatPenalty?: number;
};

/**
 * Family 默认表。每条记录都需要在注释中给出 HF card / 厂商文档 URL。
 * 翻译自 forge/src/forge/clients/sampling_defaults.py 的 MODEL_SAMPLING_DEFAULTS。
 */
const FAMILY_DEFAULTS = {
  // https://huggingface.co/Qwen/Qwen3-8B-Instruct
  qwen3: { temperature: 0.6, topP: 0.95, topK: 20 },
  // https://huggingface.co/Qwen/Qwen3.5-27B-A3B-Instruct
  'qwen3.5': { temperature: 1.0, topP: 0.95, topK: 20 },
  // https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct
  'qwen3-coder': { temperature: 0.7, topP: 0.8, topK: 20 },
  // https://huggingface.co/mistralai/Ministral-3B-Instruct-2410
  'ministral-3': { temperature: 0.05 },
  // https://huggingface.co/ibm-granite/granite-4.0-2b-instruct
  'granite-4': { temperature: 0, topP: 1, topK: 0 },
  // https://huggingface.co/google/gemma-4-it (示例占位，正式发布时更新)
  'gemma-4': { temperature: 0.7, topP: 0.95, topK: 50 },
} as const satisfies Record<string, SamplingProfile>;

type FamilyKey = keyof typeof FAMILY_DEFAULTS;

const FAMILY_RESOLVERS: ReadonlyArray<{ pattern: RegExp; family: FamilyKey }> = [
  { pattern: /Qwen3-Coder/i, family: 'qwen3-coder' },
  { pattern: /Qwen3\.5/i, family: 'qwen3.5' },
  { pattern: /Qwen3/i, family: 'qwen3' },
  { pattern: /Ministral-3/i, family: 'ministral-3' },
  { pattern: /granite-4/i, family: 'granite-4' },
  { pattern: /gemma-4/i, family: 'gemma-4' },
];

/**
 * 按 model id（GGUF stem、HF repo id）识别 family。
 * 未识别返回 null。
 */
export function resolveSamplingProfile(modelId: string): SamplingProfile | null {
  for (const resolver of FAMILY_RESOLVERS) {
    if (resolver.pattern.test(modelId)) {
      return { ...FAMILY_DEFAULTS[resolver.family] };
    }
  }
  return null;
}

/**
 * 用户在 ProviderConfig.options 中的 override 覆盖 family default。
 * 仅当 override 字段为非 undefined 时覆盖（字段级合并）。
 */
export function applyProviderOverride(
  base: SamplingProfile,
  override: Partial<SamplingProfile>
): SamplingProfile {
  const merged: SamplingProfile = { ...base };
  for (const key of ['temperature', 'topP', 'topK', 'minP', 'presencePenalty', 'repeatPenalty'] as const) {
    if (override[key] !== undefined) {
      (merged as Record<string, number | undefined>)[key] = override[key];
    }
  }
  return merged;
}
```

测试 `sampling-defaults.test.ts`：

- `resolveSamplingProfile('Qwen3-Coder-480B')` → `{temperature: 0.7, topP: 0.8, topK: 20}`。
- `resolveSamplingProfile('Qwen3.5-27B-Instruct')` → `{temperature: 1.0, topP: 0.95, topK: 20}`（Qwen3-Coder pattern 不能误中 Qwen3.5）。
- `resolveSamplingProfile('Qwen3-8B-Instruct')` → `{temperature: 0.6, topP: 0.95, topK: 20}`（先 Coder、再 3.5、再 3 的 fall-through 顺序）。
- `resolveSamplingProfile('Ministral-3-8B-Instruct-2512-Q8_0')` → `{temperature: 0.05}`。
- `resolveSamplingProfile('llama-3.1-70b-instruct')` → `null`。
- `applyProviderOverride({temperature: 0.6, topP: 0.95, topK: 20}, {temperature: 0.8})` → `{temperature: 0.8, topP: 0.95, topK: 20}`。
- override 中 `temperature: 0` 视为有效覆盖（不被当 falsy 跳过）——加专门用例。

### Step 1.7: `prerequisites-config.ts` — prereq 与 workflow 配置

```ts
// src/main/services/forge-guardrails/prerequisites-config.ts
import type { PrereqRule } from './state-schema';

export type PrerequisitesConfig = {
  prerequisites: Record<string, PrereqRule[]>;
};

export const ROC_PREREQUISITES: PrerequisitesConfig = {
  prerequisites: {
    edit_file: [{ kind: 'argMatched', tool: 'read_file', matchArg: 'path' }],
    delete_file: [{ kind: 'argMatched', tool: 'read_file', matchArg: 'relativePath' }],
    write_file: [{ kind: 'argMatched', tool: 'read_file', matchArg: 'path' }],
    schedule_background_task: [{ kind: 'nameOnly', tool: 'propose_background_task' }],
    update_background_task: [{ kind: 'argMatched', tool: 'read_background_task', matchArg: 'taskId' }],
    cancel_background_task: [{ kind: 'argMatched', tool: 'read_background_task', matchArg: 'taskId' }],
  },
};

export type WorkflowSpec = {
  name: string;
  requiredSteps: string[];
  terminalTools: string[];
};

export const ROC_WORKFLOWS = {
  propose_background_task: {
    name: 'propose_background_task',
    requiredSteps: ['propose_background_task', 'schedule_background_task'],
    terminalTools: ['confirm_with_user'],
  },
  background_task_change: {
    name: 'background_task_change',
    requiredSteps: [],   // 仅 prereq 生效
    terminalTools: [],   // HITL 卡片自然中断
  },
} as const satisfies Record<string, WorkflowSpec>;

export type RocWorkflowName = keyof typeof ROC_WORKFLOWS;
```

测试 `prerequisites-config.test.ts`：

- 两个 workflow 的 `requiredSteps` 与 `terminalTools` 配置匹配 spec §3.1 §3.2。
- 三个文件相关 prereq、三个 background_task 相关 prereq、一个 schedule 相关 prereq 共 7 条规则全部声明。

### Step 1.8: `respond-tool.ts` — 合成 respond ClientTool

```ts
// src/main/services/forge-guardrails/respond-tool.ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

export const RESPOND_TOOL_NAME = 'respond';

const respondSchema = z.object({
  message: z.string().min(1).describe('要返回给用户的消息正文。'),
});

const RESPOND_DESCRIPTION = [
  '当不需要再调其他工具、想给用户发文字时调用本工具。',
  '它把你的回复转化为一次结构化调用，框架会把它转回普通文本展示给用户。',
  '当你需要：',
  '- 用对话方式回应用户（如打招呼、答澄清问题），',
  '- 完成所有工作后给用户做总结，',
  '请调用本工具，而不是直接输出自由文本。',
].join('\n');

export function createRespondTool(): DynamicStructuredTool<typeof respondSchema, z.infer<typeof respondSchema>, z.infer<typeof respondSchema>, string> {
  return new DynamicStructuredTool({
    name: RESPOND_TOOL_NAME,
    description: RESPOND_DESCRIPTION,
    schema: respondSchema,
    func: async ({ message }) => message,
  });
}
```

测试 `respond-tool.test.ts`：

- `createRespondTool()` 返回的 tool `name === 'respond'`。
- schema 接受 `{message:'x'}`、拒绝 `{message:''}`、拒绝缺字段。
- 调用 callable 返回 `message` 原文（异步）。

### Step 1.9: `preview-store.ts` — propose preview 缓存

```ts
// src/main/services/forge-guardrails/preview-store.ts
import { randomUUID } from 'node:crypto';
import type { BackgroundTaskPreview } from '../../../shared/types';

/**
 * Session 范围（per agent run）的 previewId → BackgroundTaskPreview map。
 * propose_background_task 写入；schedule_background_task 读取并删除。
 *
 * 不持久化到 DB——避免半成品脏数据。run 结束时 GC。
 */
export class PreviewStore {
  private readonly entries = new Map<string, BackgroundTaskPreview>();

  generatePreviewId(): string {
    return `preview_${randomUUID()}`;
  }

  put(previewId: string, preview: BackgroundTaskPreview): void {
    this.entries.set(previewId, preview);
  }

  take(previewId: string): BackgroundTaskPreview | null {
    const value = this.entries.get(previewId);
    if (value === undefined) {
      return null;
    }
    this.entries.delete(previewId);
    return value;
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
```

测试 `preview-store.test.ts`：

- `put` 后 `size === 1`、`take` 后 `size === 0`；连续 `take` 同 id 第二次返回 null。
- `generatePreviewId` 返回 `preview_` 前缀；两次调用不同。
- `clear` 清空所有。

### Step 1.10: `workflow-resolver.ts`

```ts
// src/main/services/forge-guardrails/workflow-resolver.ts
import { ROC_WORKFLOWS, type WorkflowSpec } from './prerequisites-config';

export type WorkflowHint = 'propose_background_task' | 'background_task_change' | null;

export function resolveWorkflow(hint: WorkflowHint): WorkflowSpec | null {
  if (hint === 'propose_background_task') return ROC_WORKFLOWS.propose_background_task;
  if (hint === 'background_task_change') return ROC_WORKFLOWS.background_task_change;
  return null;
}
```

测试 `workflow-resolver.test.ts`：3 个 case 覆盖。

### Step 1.11: 更新 barrel & 提 PR

```ts
// src/main/services/forge-guardrails/index.ts
export * from './errors';
export * from './message-tags';
export * from './state-schema';
export * from './nudge-templates';
export * from './rescue-parser';
export * from './sampling-defaults';
export * from './prerequisites-config';
export * from './respond-tool';
export * from './preview-store';
export * from './workflow-resolver';
```

```powershell
pnpm vitest run tests/main/services/forge-guardrails/
pnpm typecheck
```

Expected: 所有 Phase 1 单测通过；typecheck 全绿。

提 PR：

```powershell
git checkout -b feat/forge-guardrails-phase-1
git add src/main/services/forge-guardrails/ tests/main/services/forge-guardrails/
git commit -m "feat(forge-guardrails): Phase 1 - base data and pure functions"
```

---

## Phase 2: 采样默认值接入 LangChainModelFactory

**Goal:** 在创建 `llama_cpp` ChatModel 时叠加 family 默认采样 + ProviderConfig override。

**Dependencies:** Phase 1 完成（`sampling-defaults` 可用）。

**Files:**
- Modify: `src/main/services/langchain-model-factory.ts`、`src/shared/types/settings.ts`
- Create: `tests/main/services/langchain-model-factory.sampling.test.ts`

### Step 2.1: 扩展 `ProviderConfig.options`

```ts
// src/shared/types/settings.ts (增量)
export type ProviderOptions = {
  // ... 既有字段保留
  contextBudgetTokens?: number;  // forge TieredCompact budget；默认 8192
  samplingProfileOverrides?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    minP?: number;
    presencePenalty?: number;
    repeatPenalty?: number;
  };
};
```

### Step 2.2: LangChainModelFactory 接入采样

在 `createModelForProvider()` 中，对 `llama_cpp` 调 `resolveSamplingProfile(modelId)` + `applyProviderOverride()`，把结果传给 ChatOpenAI 构造器。

**关键约束**：

- 仅 `llama_cpp` 启用 family lookup；云端 Provider（openai_compatible / anthropic_compatible / nvidia）不查 family 表（云端模型自身有合理默认，不能用 family pattern 误击）。
- override 中 `temperature: 0` 必须能覆盖（不能被 `?? base.temperature` 这种 falsy 兜底跳过）。
- 未识别 family 时**写一行 INFO log**（不抛错）：`provider_local_family_unknown: modelId=<X>`，并把 sampling profile 留空让 backend default 生效。

代码骨架：

```ts
// 在 createModelForProvider 中，处于 llama_cpp 分支：
const familyProfile = resolveSamplingProfile(modelId);
const overrides = provider.options?.samplingProfileOverrides ?? {};
const profile = familyProfile === null ? overrides : applyProviderOverride(familyProfile, overrides);

if (familyProfile === null && Object.keys(overrides).length === 0) {
  this.logService.append({
    level: 'info',
    message: 'provider_local_family_unknown',
    data: { providerId: provider.id, modelId },
  });
}

// 把 profile 字段映射到 ChatOpenAI 构造器参数
const samplingFields = {
  temperature: profile.temperature,
  topP: profile.topP,
  // ChatOpenAI 用 modelKwargs.top_k、top_p 等 backend 参数。
};
```

测试 `langchain-model-factory.sampling.test.ts`：

- 用 `llama_cpp` Provider + `modelId='Qwen3-8B-Instruct.Q8_0.gguf'` 创建 → 构造器收到 `temperature=0.6, top_p=0.95, top_k=20`。
- `samplingProfileOverrides: {temperature: 0.8}` → 收到 `temperature=0.8`、其余 family 默认。
- `samplingProfileOverrides: {temperature: 0}` → 收到 `temperature=0`（不被跳过）。
- `modelId='llama-3.1'`（未识别）且无 override → INFO log 被写、构造器 temperature 不出现。
- 云端 Provider（`openai_compatible` + `gpt-4o`）→ 不调 `resolveSamplingProfile`、不写 INFO log。

### Step 2.3: 测试 + PR

```powershell
pnpm vitest run tests/main/services/langchain-model-factory.sampling.test.ts
pnpm typecheck
```

提 PR：`feat(forge-guardrails): Phase 2 - sampling defaults`。

---

## Phase 3: propose 三步链 + read_background_task + confirm_with_user + 取消预注入

**Goal:** 把 `propose_background_task` 拆为"propose 出 preview / schedule 落地 / confirm 终止"三步；新增 `read_background_task` 与 `confirm_with_user`；取消 `openBackgroundTaskInChat` 的预注入。

**Dependencies:** Phase 1 完成（`preview-store`、`errors`、`prerequisites-config` 可用）。

**Files:**
- Modify: `src/main/services/deep-agent/background-task-tools.ts`、`src/main/services/deep-agent/tools.ts`、`src/main/services/task-service.ts`、`src/main/services/agent-service.ts`、`src/main/services/deep-agent/session.ts`、`src/main/services/deep-agent/types.ts`、`src/shared/background-task-tool-contract.ts`
- Create: `tests/main/services/deep-agent/background-task-tools-propose-schedule.test.ts`、`tests/main/services/deep-agent/read-background-task.test.ts`、`tests/main/services/deep-agent/confirm-with-user.test.ts`

### Step 3.1: Failing 测试先写

`background-task-tools-propose-schedule.test.ts`：

```ts
describe('propose_background_task callable (after Phase 3 refactor)', () => {
  it('propose 仅生成 preview，不创建 DB 记录', async () => {
    const previewStore = new PreviewStore();
    const tools = createBackgroundTaskTools({
      taskService: mockTaskService,
      schedulerService: mockSchedulerService,
      previewStore,
    });
    const propose = tools.find(t => t.name === 'propose_background_task');
    const result = JSON.parse(await propose.func({ goal: 'X', trigger: { type: 'manual', description: 'M' }, workspacePath: tmpRoot }));
    expect(result.previewId).toMatch(/^preview_/);
    expect(result.preview.goal).toBe('X');
    expect(mockTaskService.createBackgroundTask).not.toHaveBeenCalled();
    expect(mockSchedulerService.registerTask).not.toHaveBeenCalled();
    expect(previewStore.size()).toBe(1);
  });

  it('schedule 用 previewId 取出 preview、创建并 register', async () => {
    const previewStore = new PreviewStore();
    const previewId = previewStore.generatePreviewId();
    previewStore.put(previewId, samplePreview);
    const tools = createBackgroundTaskTools({ ..., previewStore });
    const schedule = tools.find(t => t.name === 'schedule_background_task');
    const result = JSON.parse(await schedule.func({ previewId }));
    expect(result.ok).toBe(true);
    expect(result.taskId).toBeDefined();
    expect(mockTaskService.createBackgroundTask).toHaveBeenCalledWith(samplePreview);
    expect(mockSchedulerService.registerTask).toHaveBeenCalled();
    expect(previewStore.size()).toBe(0);  // 一次性
  });

  it('schedule 用未知 previewId 抛 RocToolResolutionError', async () => {
    const previewStore = new PreviewStore();
    const tools = createBackgroundTaskTools({ ..., previewStore });
    const schedule = tools.find(t => t.name === 'schedule_background_task');
    await expect(schedule.func({ previewId: 'preview_unknown' })).rejects.toThrow(RocToolResolutionError);
  });
});
```

`read-background-task.test.ts`：

```ts
it('返回完整 task JSON', async () => {
  const tool = createReadBackgroundTaskTool(mockTaskService);
  mockTaskService.findBackgroundTask.mockReturnValueOnce(sampleTask);
  const result = await tool.func({ taskId: sampleTask.id });
  expect(JSON.parse(result)).toEqual(sampleTask);
});

it('找不到 taskId 抛 RocToolResolutionError', async () => {
  const tool = createReadBackgroundTaskTool(mockTaskService);
  mockTaskService.findBackgroundTask.mockReturnValueOnce(null);
  await expect(tool.func({ taskId: 'unknown' })).rejects.toThrow(RocToolResolutionError);
});
```

`confirm-with-user.test.ts`：

```ts
it('返回 {ok:true, summary}、无副作用', async () => {
  const tool = createConfirmWithUserTool();
  const result = JSON.parse(await tool.func({ summary: '已为你创建任务，每天 19:40 抓取新闻。' }));
  expect(result).toEqual({ ok: true, summary: '已为你创建任务，每天 19:40 抓取新闻。' });
});
```

```powershell
pnpm vitest run tests/main/services/deep-agent/background-task-tools-propose-schedule.test.ts tests/main/services/deep-agent/read-background-task.test.ts tests/main/services/deep-agent/confirm-with-user.test.ts
```

Expected: 全部 FAIL（工具未实现）。

### Step 3.2: 改造 `background-task-tools.ts`

将 `propose_background_task` callable 改为仅生成 preview 并写入 previewStore：

```ts
// background-task-tools.ts (修改 propose 部分)
type BackgroundTaskToolDependencies = {
  taskService: TaskService;
  schedulerService: TaskSchedulerService;
  enabledCapabilities?: EnabledCapabilities;
  previewStore: PreviewStore;  // 新增
};

function buildProposeCallable(input: BackgroundTaskToolDependencies) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = proposeToolInputSchema.parse(rawInput);
    validateTrigger(parsed.trigger);
    validateWorkspacePath(parsed.workspacePath);
    const preview = input.taskService.createBackgroundTaskPreview({
      goal: parsed.goal,
      trigger: parsed.trigger,
      workspacePath: parsed.workspacePath,
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations',
      enabledCapabilities: input.enabledCapabilities === undefined ? null : input.enabledCapabilities,
    });
    const previewId = input.previewStore.generatePreviewId();
    input.previewStore.put(previewId, { ...preview, requiresConfirmation: false });
    return JSON.stringify({ previewId, preview });
  };
}
```

新增 `schedule_background_task`：

```ts
const scheduleInputSchema = z.strictObject({
  previewId: z.string().min(1).describe('propose_background_task 返回的 previewId。'),
});

function buildScheduleCallable(input: BackgroundTaskToolDependencies) {
  return async (rawInput: unknown): Promise<string> => {
    const { previewId } = scheduleInputSchema.parse(rawInput);
    const preview = input.previewStore.take(previewId);
    if (preview === null) {
      throw new RocToolResolutionError(
        `Unknown previewId ${previewId}. 请先调用 propose_background_task 生成新的 preview。`,
        { toolName: 'schedule_background_task' }
      );
    }
    const task = input.taskService.createBackgroundTask(preview);
    input.schedulerService.registerTask(task);
    return JSON.stringify({ ok: true, taskId: task.id, threadId: task.threadId, scheduledNextRunAt: task.nextRunAt });
  };
}
```

`createBackgroundTaskTools` 返回的工具列表加入 `schedule_background_task`：

```ts
return [
  new DynamicStructuredTool({ name: 'propose_background_task', description: PROPOSE_TOOL_DESCRIPTION, schema: proposeToolInputSchema, func: buildProposeCallable(input) }),
  new DynamicStructuredTool({ name: 'schedule_background_task', description: SCHEDULE_TOOL_DESCRIPTION, schema: scheduleInputSchema, func: buildScheduleCallable(input) }),
  new DynamicStructuredTool({ name: 'update_background_task', ... }),  // 保留
  new DynamicStructuredTool({ name: 'cancel_background_task', ... }),  // 保留
];
```

`SCHEDULE_TOOL_DESCRIPTION`：

```ts
export const SCHEDULE_TOOL_DESCRIPTION = [
  '把 propose_background_task 返回的 preview 实际落地为后台任务并加入调度。',
  '必须先调用过 propose_background_task 拿到 previewId。',
  '本工具会创建任务、注册调度器，并返回真实 taskId。',
].join('\n');
```

`PROPOSE_TOOL_DESCRIPTION` 同步改写：

```ts
// shared/background-task-tool-contract.ts (修改)
export const PROPOSE_TOOL_DESCRIPTION = [
  '为后台或定时任务生成 preview（草稿），但不实际创建。',
  '只填写 goal、trigger、workspacePath。',
  '不要填写 allowedActions、forbiddenActions、notificationPolicy、enabledCapabilities 或 failurePolicy。',
  'trigger.type 只能是 manual、once 或 cron。',
  'cron trigger 使用五段 cronExpression 和 UTC ISO nextRunAt。',
  '无法确定触发方式时使用 manual。',
  '本工具返回 previewId 与 preview 内容；要实际创建任务，必须随后调用 schedule_background_task(previewId)。',
].join('\n');
```

把 `buildTaskProposalPrompt` 加 `@deprecated` JSDoc，但保留实现（兼容性）：

```ts
/**
 * @deprecated 自 2026-05-28 forge guardrails Phase 3 起，TasksView 应直接传用户描述作为 input，
 * 同时在 ChatStartRunRequest 中设置 workflowHint='propose_background_task'。
 * 本函数保留兼容期，但不再被推荐用于新代码路径。Plan 阶段确定何时删除。
 */
export function buildTaskProposalPrompt(input: { description: string; workspacePath: string }): string {
  // ... 实现不变
}
```

**HITL 边界**：

- `schedule_background_task` 按当前 Roc 任务创建口径直接创建 BackgroundTask 并注册 scheduler；不得加入 `interruptOn`，不得生成审批卡，不调用 `applyBackgroundTaskToolDecision`。
- `confirm_with_user` 只是 terminal signal；不得触发 HITL，不修改 task，不写审批状态，只返回 `{ok:true, summary}` 让 step enforcement 判断本轮完成。
- `update_background_task` / `cancel_background_task` 继续保留现有 HITL 卡片与 resume 路径。

### Step 3.3: 新增 `read_background_task` 与 `confirm_with_user`

`tools.ts`（增量）：

```ts
import { RocToolResolutionError } from '../forge-guardrails';

export function createReadBackgroundTaskTool(taskService: TaskService): DynamicStructuredTool<...> {
  const schema = z.object({
    taskId: z.string().min(1).describe('要读取的后台任务 ID。'),
  });
  return new DynamicStructuredTool({
    name: 'read_background_task',
    description: [
      '读取一个后台任务的完整定义（goal、trigger、workspacePath、status、capabilities 等）。',
      '在 update_background_task / cancel_background_task 之前必须先调用本工具读取目标任务。',
    ].join('\n'),
    schema,
    func: async ({ taskId }) => {
      const task = taskService.findBackgroundTask(taskId);
      if (task === null) {
        throw new RocToolResolutionError(
          `Background task with id ${taskId} does not exist.`,
          { toolName: 'read_background_task' }
        );
      }
      return JSON.stringify(task, null, 2);
    },
  });
}

export function createConfirmWithUserTool(): DynamicStructuredTool<...> {
  const schema = z.object({
    summary: z.string().min(1).max(1000).describe(
      '用面向用户的语气总结刚才做了什么、任务的关键参数与下一步预期。'
    ),
  });
  return new DynamicStructuredTool({
    name: 'confirm_with_user',
    description: [
      '在创建后台任务的最后一步调用，把刚才完成的工作总结成一句话给用户。',
      '这是工作流的终止信号——调用之后本轮 agent run 结束。',
    ].join('\n'),
    schema,
    func: async ({ summary }) => JSON.stringify({ ok: true, summary }),
  });
}
```

`createRunTools` 中暴露新工具：

```ts
async function createRunTools(input: { ... }): Promise<{ tools: ClientTool[]; webReadTool: ... }> {
  const webReadTool = createWebReadTool(input.webReadService);
  const deleteFileTool = createDeleteFileTool(input.fileService);
  const readBackgroundTaskTool = createReadBackgroundTaskTool(input.taskService);
  const confirmWithUserTool = createConfirmWithUserTool();
  const backgroundTaskTools = createBackgroundTaskTools({ ... });
  const runTools: ClientTool[] = [
    webReadTool, deleteFileTool,
    readBackgroundTaskTool, confirmWithUserTool,
    ...backgroundTaskTools,
  ];
  // ... 其他
}
```

### Step 3.4: 取消 `openBackgroundTaskInChat` 的预注入

```ts
// task-service.ts (修改 openBackgroundTaskInChat)
openBackgroundTaskInChat(taskId: string): { threadId: string } {
  const task = requireBackgroundTask(this.database, taskId);
  // 不再向 pendingThreadContexts.enqueue 预注入 task JSON。
  // 改为只记录一条事件，告诉 task 历史"用户准备修改该 task"。
  // 实际的 read 由模型主动调 read_background_task 完成。
  this.recordEvent({
    threadId: task.threadId,
    runId: task.runId,
    type: 'message',
    payload: {
      role: 'system',
      content: `[系统] 用户准备修改后台任务 ${task.id}。`,
    },
  });
  return { threadId: task.threadId };
}
```

`prependPendingThreadContext` 在 `deep-agent-runtime-service.ts` 中的调用保留，但因为 `pendingThreadContexts` 不再被 `openBackgroundTaskInChat` enqueue 而调用方仍可能 enqueue 其他东西，**保留**该机制本身。

### Step 3.5: session 创建 previewStore

```ts
// deep-agent/session.ts (修改)
import { PreviewStore } from '../forge-guardrails';

export type DeepAgentSession = {
  // ... 既有字段
  previewStore: PreviewStore;
};

export async function createDeepAgentSession(input: {...}): Promise<DeepAgentSession> {
  // ...
  const previewStore = new PreviewStore();
  input.context.previewStore = previewStore;  // 也存到 context 供 background-task-tools 使用

  const runTools = await createRunTools({
    ...,
    taskService: input.taskService,
    previewStore,
  });
  // ...
  return {
    // ...
    previewStore,
  };
}
```

`createBackgroundTaskTools` 调用点同步传入 previewStore。`RunExecutionContext` 类型加 `previewStore?: PreviewStore`。

`closers` 数组在 run 结束时 `previewStore.clear()`，确保不跨 run 泄漏（虽然 GC 通常足够）。

### Step 3.6: 集成测试 + PR

`tests/main/app-services.tasks.test.ts` 加：

```ts
it('propose 不再创建 DB 记录，schedule 才创建', async () => {
  // 通过真正的 createDeepAgentSession 或 createBackgroundTaskTools 单独测试
});
```

`tests/main/task-service.openBackgroundTaskInChat.test.ts` 加：

```ts
it('不再向 pendingThreadContexts 预注入 task JSON', async () => {
  const result = taskService.openBackgroundTaskInChat(taskId);
  expect(taskService.takePendingThreadContext(taskThreadId)).toBeNull();
  expect(result.threadId).toBe(taskThreadId);
});
```

```powershell
pnpm vitest run tests/main/services/deep-agent/ tests/main/services/forge-guardrails/
pnpm vitest run tests/main/task-service.openBackgroundTaskInChat.test.ts
pnpm typecheck
```

Expected: 全部通过。

提 PR：`feat(forge-guardrails): Phase 3 - propose three-step + read_background_task + confirm_with_user`。

---

## Phase 4: `workflowHint` 信号通路

**Goal:** 在 `ChatStartRunRequest` 加入 `workflowHint?` 字段，贯穿 preload / ipc / runtime / session / agent-builder。Renderer 在 TasksView 和 openBackgroundTaskInChat 后续 chat 中显式传 hint。

**Dependencies:** Phase 3 完成（previewStore 与新工具已就绪）。

**Files:**
- Modify: `src/shared/types/chat.ts`、`src/preload/index.ts`、`src/main/ipc/register-ipc.ts`、`src/main/services/deep-agent-runtime-service.ts`、`src/main/services/deep-agent/types.ts`、`src/main/services/deep-agent/session.ts`、`src/renderer/views/tasks/TasksView.tsx`、`src/renderer/App.tsx`
- Modify tests: `tests/main/deep-agent-runtime-service.test.ts`、`tests/renderer/tasks-view.test.ts`

### Step 4.1: 类型

```ts
// shared/types/chat.ts
export type WorkflowHint = 'propose_background_task' | 'background_task_change' | null;

export type ChatStartRunRequest = {
  input: string;
  mode: ChatRunMode;
  enabledCapabilities: EnabledCapabilities;
  threadId?: string | null;
  workflowHint?: WorkflowHint;  // 新增
};
```

### Step 4.2: preload + IPC 透传

```ts
// preload/index.ts (chat.startRun)
startRun: (request: ChatStartRunRequest) => ipcRenderer.invoke(ipcChannels.chatStartRun, request),
```

不需要改 preload——`ChatStartRunRequest` 是 plain object，序列化自动透传新字段。但需要验证 IPC schema validator（如果存在）是否拒绝未知字段。

```ts
// main/ipc/register-ipc.ts
timedHandle(ipcChannels.chatStartRun, async (_event, request: ChatStartRunRequest) =>
  await services.deepAgentRuntimeService.startRun(request)
);
```

### Step 4.3: RunExecutionContext 携带 workflowHint

```ts
// deep-agent/types.ts (修改)
export type RunExecutionContext = {
  // ... 既有字段
  workflowHint: WorkflowHint;
};
```

`deep-agent-runtime-service.ts` 的 `startRun` 在 `activeRun` 与 `context` 中携带 `request.workflowHint ?? null`。`executeResume` 走 task 已有的 `taskRun.workflowHint` ——**等等**，spec §Resolved Item 2 明确说 workflowHint 不持久化。resume 路径不传 hint（用 LangGraph state 内已有的 forge_step_tracker 续跑），所以 RunExecutionContext.workflowHint 在 resume 时是 null。这是允许的——`workflowResolver` 也允许 null（返回 null = 无 workflow）。

### Step 4.4: TasksView 改造

```ts
// renderer/views/tasks/TasksView.tsx (修改 submitTaskDescription)
async function submitTaskDescription(description: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const workspacePath = getCurrentWorkspacePath(state);
  if (workspacePath === null || workspacePath.trim().length === 0) {
    return { ok: false, error: '当前没有可用于任务的工作区路径。' };
  }
  return await onSubmitTaskPrompt({
    input: description,  // 用户原话，不再 wrap buildTaskProposalPrompt
    workflowHint: 'propose_background_task',
    workspacePath,
  });
}
```

`TasksView` 的 `onSubmitTaskPrompt` 签名从 `(input: string) => ...` 改为 `(payload: { input: string; workflowHint: WorkflowHint; workspacePath: string }) => ...`。

`App.tsx` 的 `startTaskRun` 同步调整：

```ts
const startTaskRun = useCallback(
  async (payload: { input: string; workflowHint?: WorkflowHint; workspacePath?: string }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const result = await window.roc.chat.startRun({
      input: payload.input,
      mode: 'task',
      threadId: selectedThreadId,
      enabledCapabilities: {
        mcpServers: currentSelectedMcpServers,
        skills: currentSelectedSkills,
      },
      workflowHint: payload.workflowHint ?? null,
    });
    // ...
  },
  [/* ... */]
);
```

ChatView / FloatingEntry 等其他调用 `window.roc.chat.startRun` 的入口**保持不传 workflowHint**（自动 undefined → 落入 null）。

### Step 4.5: openBackgroundTaskInChat 后续 chat 传 hint

`openBackgroundTaskInChat` 的调用方（task-workbench 中"在聊天里修改"按钮）在 IPC 调返回后跳转到 chat 视图，此时用户输入将作为 startRun 的 input。**关键改动**：

- 跳转到 chat 后，UI 需要知道"当前会话是 background_task_change 模式"。
- 实现方式：在 ChatView 维护一个 `pendingWorkflowHint` state，由"修改后台任务"按钮通过 setter 设置；下一次用户在该 chat 中发送消息时，`startRun` 带上 `workflowHint: 'background_task_change'`；发送后 reset 为 null。
- 仅当前 thread 内首次 startRun 携带 hint；后续 turn 不再携带（让 LangGraph state 中的 step_tracker 续走）。

**这一改动相对复杂，且涉及 chat 视图状态管理**。Phase 4 内只做 wiring 与 type 通路；UI 状态机的具体实现作为 Phase 4 的 "Step 4.6" 单独做。

### Step 4.6: ChatView 中的 pendingWorkflowHint 状态

```tsx
// renderer/chat/chat-view.tsx (增量)
const [pendingWorkflowHint, setPendingWorkflowHint] = useState<WorkflowHint>(null);

// 暴露 setter 给"修改后台任务"按钮:
useImperativeHandle(ref, () => ({
  setPendingWorkflowHint: (hint: WorkflowHint) => setPendingWorkflowHint(hint),
}));

// 在 sendMessage 时:
async function sendMessage(input: string) {
  const result = await onStartRun({
    input,
    workflowHint: pendingWorkflowHint ?? null,
  });
  setPendingWorkflowHint(null);  // 一次性
  return result;
}
```

TaskWorkbench 的"在聊天里修改"按钮在跳转后调 `chatViewRef.current?.setPendingWorkflowHint('background_task_change')`。

### Step 4.7: 测试 + PR

`tests/main/deep-agent-runtime-service.test.ts` 加：

```ts
it('workflowHint 透传到 RunExecutionContext', async () => {
  await runtime.startRun({ input: 'x', mode: 'task', enabledCapabilities: { mcpServers: [], skills: [] }, workflowHint: 'propose_background_task' });
  const session = (capturedSession as DeepAgentSession);
  expect(session.context.workflowHint).toBe('propose_background_task');
});

it('未传 workflowHint 时透传为 null', async () => {
  await runtime.startRun({ input: 'x', mode: 'chat', enabledCapabilities: { mcpServers: [], skills: [] } });
  expect(capturedSession.context.workflowHint).toBeNull();
});
```

`tests/renderer/tasks-view.test.ts` 加：

```ts
it('submitTaskDescription 传 workflowHint=propose_background_task 与用户原话', async () => {
  const onSubmitTaskPrompt = vi.fn().mockResolvedValue({ ok: true });
  render(<TasksView ... onSubmitTaskPrompt={onSubmitTaskPrompt} />);
  // 模拟用户输入并提交
  await userEvent.type(screen.getByLabelText(/新建任务/), '每天 19:40 抓新闻');
  await userEvent.click(screen.getByText(/提交/));
  expect(onSubmitTaskPrompt).toHaveBeenCalledWith({
    input: '每天 19:40 抓新闻',  // 不再用 buildTaskProposalPrompt
    workflowHint: 'propose_background_task',
    workspacePath: 'F:\\Code\\Roc',  // 或固定测试路径
  });
});
```

```powershell
pnpm vitest run tests/main/deep-agent-runtime-service.test.ts -t workflowHint
pnpm vitest run tests/renderer/tasks-view.test.ts
pnpm typecheck
```

Expected: 全部通过。

提 PR：`feat(forge-guardrails): Phase 4 - workflowHint signal pipeline`.

---

## Phase 5: Rescue Parsing + Respond Tool Injection middleware

**Goal:** 落地 `createRescueParsingMiddleware` 与 `createRespondToolInjectionMiddleware`，挂入 `agent-builder.ts`。本 Phase 后，模型即使输出野生格式工具调用、或本地 Provider 的合成 respond 调用都能正确处理。

**Dependencies:** Phase 1（rescue-parser、respond-tool）、Phase 4（workflowHint 已通路）完成。

**Files:**
- Create: `src/main/services/forge-guardrails/middleware/rescue-parsing.ts`、`src/main/services/forge-guardrails/middleware/respond-tool-injection.ts`
- Create: `tests/main/services/forge-guardrails/middleware/rescue-parsing.test.ts`、`tests/main/services/forge-guardrails/middleware/respond-tool-injection.test.ts`
- Modify: `src/main/services/deep-agent/agent-builder.ts`

### Step 5.1: `createRescueParsingMiddleware`

```ts
// forge-guardrails/middleware/rescue-parsing.ts
import { createMiddleware } from 'langchain';
import { AIMessage, RemoveMessage } from '@langchain/core/messages';
import { rescueToolCall } from '../rescue-parser';
import { tagForgeMessage } from '../message-tags';

export function createRescueParsingMiddleware(opts: { availableTools: () => string[] }) {
  return createMiddleware({
    name: 'ForgeRescueParsingMiddleware',
    afterModel: (state) => {
      const messages = state.messages;
      if (messages.length === 0) return undefined;
      const last = messages[messages.length - 1];
      if (!AIMessage.isInstance(last)) return undefined;

      // 已有 tool_calls 时不动
      if (last.tool_calls && last.tool_calls.length > 0) return undefined;

      // 抽出文本 content
      const content = typeof last.content === 'string' ? last.content : extractTextFromBlocks(last.content);
      if (content.trim().length === 0) return undefined;

      const available = opts.availableTools();
      const result = rescueToolCall(content, available);
      if (result.toolCalls.length === 0) return undefined;

      // 构造新的 AIMessage 替换 last：清空 content、填 tool_calls
      const rescuedTC = result.toolCalls.map((tc, idx) => ({
        name: tc.tool,
        args: tc.args,
        id: `call_rescued_${last.id ?? 'msg'}_${idx}`,
        type: 'tool_call' as const,
      }));
      const rebuilt = new AIMessage({
        id: last.id,
        content: '',
        tool_calls: rescuedTC,
        additional_kwargs: {
          ...last.additional_kwargs,
          forge_rescue: { strategy: result.strategy },
          forge_reasoning_text: result.reasoningText ?? undefined,
        },
        response_metadata: last.response_metadata,
        usage_metadata: last.usage_metadata,
      });

      // deepagents 默认 messages reducer 是 MessagesValue（等价 messagesStateReducer）：
      // 收到 RemoveMessage 时按 id 删除原 message；普通 message 按 id 合并 / append。
      // 因此返回 [RemoveMessage(old.id), rebuilt(same id)] 等价于"就地替换"。
      // 来源：docs.langchain.com/oss/javascript/langgraph/add-memory
      return {
        messages: [
          new RemoveMessage({ id: last.id! }),
          rebuilt,
        ],
      };
    },
  });
}
```

> **API 注释**：`RemoveMessage` 从 `@langchain/core/messages` 导入；删全部 messages 用 `REMOVE_ALL_MESSAGES from '@langchain/langgraph'` 配合 `new RemoveMessage({ id: REMOVE_ALL_MESSAGES })`。deepagents 的 messages 字段已使用兼容 reducer，无需额外配置。来源：[`docs.langchain.com/oss/javascript/langgraph/add-memory`](https://docs.langchain.com/oss/javascript/langgraph/add-memory)。

测试 `rescue-parsing.test.ts`：

| 用例 | 输入 last AIMessage | 期望 |
|---|---|---|
| Mistral bracket → rescue | content `[TOOL_CALLS]get_weather{"city":"NYC"}` | last.tool_calls 含 `get_weather`；strategy 标 'mistral_bracket' |
| 无 rescue 可做 | content `Hello, just chatting` | messages 不变 |
| 已有 tool_calls | content `''`、tool_calls 已有 | messages 不变 |
| think tag 剥离 | content `<think>thinking</think>{"tool":"get_weather","args":{"city":"X"}}` | tool_calls 含 get_weather、`forge_reasoning_text == 'thinking'` |

### Step 5.2: `createRespondToolInjectionMiddleware`

```ts
// forge-guardrails/middleware/respond-tool-injection.ts
import { createMiddleware } from 'langchain';
import { AIMessage } from '@langchain/core/messages';
import { createRespondTool, RESPOND_TOOL_NAME } from '../respond-tool';
import { tagForgeMessage } from '../message-tags';

export function createRespondToolInjectionMiddleware(opts: { enabled: boolean }) {
  return createMiddleware({
    name: 'ForgeRespondToolInjection',
    async wrapModelCall(request, handler) {
      if (!opts.enabled) {
        return handler(request);
      }

      // Step 1: 在 tools 列表末尾注入 respond
      const respondTool = createRespondTool();
      const augmentedTools = [...request.tools, respondTool];

      // Step 2: 调用 inner handler 拿到 AIMessage
      const response = await handler({ ...request, tools: augmentedTools });

      if (!AIMessage.isInstance(response)) return response;

      const toolCalls = response.tool_calls ?? [];
      const respondCalls = toolCalls.filter((tc) => tc.name === RESPOND_TOOL_NAME);
      if (respondCalls.length === 0) return response;

      if (respondCalls.length > 1) {
        // 多个 respond 调用 — 取第一条，其余忽略，打告警
        console.warn('[ForgeRespondToolInjection] Multiple respond calls in one AIMessage; using first.');
      }

      const respondCall = respondCalls[0];
      const respondMessage = (respondCall.args as { message?: unknown }).message;
      const message = typeof respondMessage === 'string' ? respondMessage : '';

      // 剥离 respond，保留其他 tool_calls
      const otherCalls = toolCalls.filter((tc) => tc.name !== RESPOND_TOOL_NAME);

      const rebuilt = new AIMessage({
        id: response.id,
        content: message,
        tool_calls: otherCalls.length > 0 ? otherCalls : undefined,
        additional_kwargs: { ...response.additional_kwargs },
        response_metadata: response.response_metadata,
        usage_metadata: response.usage_metadata,
      });
      tagForgeMessage(rebuilt, 'forge:respond_synthetic');

      return rebuilt;
    },
  });
}
```

测试 `respond-tool-injection.test.ts`：

| 用例 | enabled | 模型返回 | 期望 |
|---|---|---|---|
| 启用 + 模型调 respond | true | tool_calls: [{respond, args: {message: '你好'}}] | AIMessage.content === '你好'、tool_calls 不含 respond、tag 'forge:respond_synthetic' |
| 启用 + 模型调其他工具 | true | tool_calls: [{get_weather, ...}] | AIMessage 不变（content 空、tool_calls 保留 get_weather） |
| 启用 + 模型多 respond | true | tool_calls: [{respond, msg:A}, {respond, msg:B}] | AIMessage.content === A、log warn |
| 启用 + 模型 respond + 其他工具 | true | tool_calls: [{respond, msg:Hi}, {get_weather, ...}] | AIMessage.content === Hi、tool_calls 保留 get_weather |
| 禁用 | false | tool_calls: [{respond, ...}] | 直接 handler 调用、tools 列表不含 respond（云端 Provider） |
| 禁用 + bare text | false | content 'Hello' | 不动 |

### Step 5.3: agent-builder.ts wiring

`createRescueParsingMiddleware` 已经在 Step 5.1 把 `availableTools: () => string[]` 作为闭包参数；本步只需在 `agent-builder.ts` 构造时把工具名集合注入。注意 deepagents 会自动挂载 filesystem / todo / subagent 工具，`input.tools` 里**没有**它们——`knownToolNames` 必须显式补齐这部分，否则 rescue 会把合法的内置工具调用判为 unknown。

### Step 5.4: agent-builder.ts 中挂入两条 middleware

```ts
// agent-builder.ts (增量)
import { createRescueParsingMiddleware, createRespondToolInjectionMiddleware } from '../forge-guardrails';

export function buildDeepAgent(input: DeepAgentBuildInput): ReturnType<typeof createDeepAgent> {
  const providerType = input.providerType;  // 由 session.ts 传入
  const isLocalProvider = providerType === 'llama_cpp';

  // 已知工具名集合（含 deepagents 内置 filesystem + memory + skills 等）
  const knownToolNames = (): string[] => [
    ...input.tools.map((t) => t.name),
    'ls', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'execute',  // filesystem
    'write_todos',                                                              // todo
    'task',                                                                     // subagent
    ...(isLocalProvider ? ['respond'] : []),
  ];

  const guardrails = [
    createRespondToolInjectionMiddleware({ enabled: isLocalProvider }),
    createRescueParsingMiddleware({ availableTools: knownToolNames }),
    // ... 后续 Phase 加更多 middleware
  ];

  return createDeepAgent({
    model: input.model,
    systemPrompt: input.systemPrompt,
    backend: input.backend,
    store: input.store,
    memory: input.memorySources,
    skills: input.skillSources,
    subagents: input.subagents,
    tools: input.tools,
    permissions: input.filesystemPermissions,
    interruptOn: input.interruptOn,
    checkpointer: input.checkpointer,
    middleware: guardrails,
  });
}
```

`DeepAgentBuildInput` 加 `providerType: ProviderType` 字段；`session.ts` 从 `context.modelHandle.runtime.providerType` 取值传入。

### Step 5.5: 验证 + PR

```powershell
pnpm vitest run tests/main/services/forge-guardrails/middleware/rescue-parsing.test.ts tests/main/services/forge-guardrails/middleware/respond-tool-injection.test.ts
pnpm vitest run tests/main/deep-agent-runtime-service.test.ts
pnpm typecheck
```

Expected: 新增测试全过；既有 deep-agent-runtime-service 测试无回归。

提 PR：`feat(forge-guardrails): Phase 5 - rescue parsing + respond tool injection`.

---

## Phase 6: Response Validation + Tool Resolution + Error Budget middleware

**Goal:** 落地三条护栏 middleware：
- `createResponseValidationMiddleware`（含 retry nudge / unknown tool nudge）
- `createToolResolutionMiddleware`（`RocToolResolutionError` 拦截）
- `createErrorBudgetMiddleware`（双计数器、耗尽抛错）

**Dependencies:** Phase 5 完成（rescue parsing 已在前；validation 才能在 rescue 后看到 tool_calls 是否合法）。

**Files:**
- Create: 3 个 middleware 文件 + 对应测试

### Step 6.1: `createErrorBudgetMiddleware`

```ts
// forge-guardrails/middleware/error-budget.ts
import { createMiddleware } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { forgeGuardrailsStateSchema } from '../state-schema';
import { readForgeMessageTag, FORGE_TRANSIENT_TYPES } from '../message-tags';
import { RocDomainError } from '../../errors';
import { FORGE_EXHAUSTED_CODES } from '../errors';

export function createErrorBudgetMiddleware(opts: { maxRetries?: number; maxToolErrors?: number } = {}) {
  const maxRetries = opts.maxRetries ?? 3;
  const maxToolErrors = opts.maxToolErrors ?? 2;

  return createMiddleware({
    name: 'ForgeErrorBudgetMiddleware',
    stateSchema: forgeGuardrailsStateSchema,

    /**
     * 仅在首次进入 agent 时初始化 max 字段；不重置 consecutive 计数器
     * （resume 路径会带着 checkpoint 进来，覆盖会清零误判）。
     */
    beforeAgent: (state) => {
      const existing = state.forge_error_tracker;
      if (existing && existing.maxRetries !== undefined) {
        // 已经初始化过，sticky
        return undefined;
      }
      return {
        forge_error_tracker: {
          consecutiveRetries: 0,
          consecutiveToolErrors: 0,
          maxRetries,
          maxToolErrors,
          maxPrematureAttempts: 3,
          maxPrereqViolations: 2,
        },
      };
    },

    /**
     * 进入模型前判定上一轮是否产生了 nudge：
     * - 若最后一条带 transient 标签 → consecutiveRetries++
     * - 否则 → 重置 consecutiveRetries 为 0
     * 耗尽则抛 forge_retries_exhausted。
     */
    beforeModel: (state) => {
      const tracker = state.forge_error_tracker;
      const last = state.messages[state.messages.length - 1];
      if (last === undefined) return undefined;
      const tag = readForgeMessageTag(last);
      const isNudge = tag !== null && FORGE_TRANSIENT_TYPES.has(tag);

      if (!isNudge) {
        // 上一轮没有 nudge → 重置
        if ((tracker?.consecutiveRetries ?? 0) === 0) return undefined;
        return {
          forge_error_tracker: { ...tracker, consecutiveRetries: 0 },
        };
      }

      // 上一轮是 nudge → 累加
      const next = (tracker?.consecutiveRetries ?? 0) + 1;
      if (next > (tracker?.maxRetries ?? maxRetries)) {
        throw new RocDomainError({
          code: FORGE_EXHAUSTED_CODES.retries,
          message: `连续 ${next} 次 nudge 后模型仍未给出合法工具调用，停止运行。`,
          category: 'external',
          retryable: true,
          userAction: '请检查模型 / prompt 配置后重试。',
        });
      }
      return {
        forge_error_tracker: { ...tracker, consecutiveRetries: next },
      };
    },

    /**
     * 工具执行后判定硬错误，并通过 Command({ update }) 携带 state 更新。
     * 软错误（ToolResolutionError 转出的 ToolMessage）由 ToolResolutionMiddleware 已经标 'forge:tool_resolution'，
     * 这里不计入硬错误，但仍重置计数器为 0（视为成功的探索性试错）。
     */
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      if (!ToolMessage.isInstance(result)) return result;

      const tracker = request.state.forge_error_tracker;
      const isSoftError = readForgeMessageTag(result) === 'forge:tool_resolution';
      const isHardError = result.status === 'error' && !isSoftError;

      if (isHardError) {
        const next = (tracker?.consecutiveToolErrors ?? 0) + 1;
        if (next > (tracker?.maxToolErrors ?? maxToolErrors)) {
          throw new RocDomainError({
            code: FORGE_EXHAUSTED_CODES.toolErrors,
            message: `连续工具失败 ${next} 次，停止运行。`,
            category: 'external',
            retryable: true,
            userAction: '请检查工具实现或 Provider 状态后重试。',
          });
        }
        return new Command({
          update: {
            messages: [result],
            forge_error_tracker: { ...tracker, consecutiveToolErrors: next },
          },
        });
      }

      // 工具成功或软错误 → 重置 toolErrors 计数
      if ((tracker?.consecutiveToolErrors ?? 0) > 0) {
        return new Command({
          update: {
            messages: [result],
            forge_error_tracker: { ...tracker, consecutiveToolErrors: 0 },
          },
        });
      }
      return result;
    },
  });
}
```

> **API 注释**：`createMiddleware` 的 hook 既可以是纯函数 `(state) => ...`，也可以是对象 `{ canJumpTo: [...], hook: (state) => ... }`。本 middleware 所有 hook 都不需要 `jumpTo`，因此用纯函数形态；只有在需要从 hook 内部跳转到 `'model' | 'tools' | 'end'` 时才必须包对象。`wrapToolCall` 返回 `Command({ update })` 是更新 state 的唯一合法方式（裸返回 ToolMessage 会丢掉 state 修改）。

### Step 6.2: `createToolResolutionMiddleware`

```ts
// forge-guardrails/middleware/tool-resolution.ts
import { createMiddleware } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';
import { RocToolResolutionError } from '../errors';
import { tagForgeMessage } from '../message-tags';

export function createToolResolutionMiddleware() {
  return createMiddleware({
    name: 'ForgeToolResolutionMiddleware',
    wrapToolCall: async (request, handler) => {
      try {
        return await handler(request);
      } catch (error) {
        if (error instanceof RocToolResolutionError) {
          const toolMessage = new ToolMessage({
            tool_call_id: request.toolCall.id ?? `unknown_${request.toolCall.name}`,
            name: request.toolCall.name,
            content: `[ToolResolutionError] ${error.message}`,
            status: 'success',  // 故意不标 error——不计入硬错误
          });
          tagForgeMessage(toolMessage, 'forge:tool_resolution');
          return toolMessage;
        }
        throw error;  // 让其它异常透传给 ErrorBudget 处理
      }
    },
  });
}
```

测试 `tool-resolution.test.ts`：

- 工具抛 `RocToolResolutionError` → 返回 ToolMessage、content 含 `[ToolResolutionError]`、status === 'success'、tag 'forge:tool_resolution'。
- 工具抛其它错误 → 透传（throw）。
- 工具正常返回 → 透传。

### Step 6.3: `createResponseValidationMiddleware`

```ts
// forge-guardrails/middleware/response-validation.ts
import { createMiddleware } from 'langchain';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { retryNudge, unknownToolNudge } from '../nudge-templates';
import { tagForgeMessage, readForgeMessageTag } from '../message-tags';

export function createResponseValidationMiddleware(opts: { knownToolNames: () => string[] }) {
  return createMiddleware({
    name: 'ForgeResponseValidation',
    afterModel: {
      canJumpTo: ['model'],
      hook: (state) => {
        const messages = state.messages;
        if (messages.length === 0) return undefined;
        const last = messages[messages.length - 1];
        if (!AIMessage.isInstance(last)) return undefined;

        // respond 合成 → 放行
        if (readForgeMessageTag(last) === 'forge:respond_synthetic') return undefined;

        const toolCalls = last.tool_calls ?? [];
        const content = typeof last.content === 'string' ? last.content : '';
        const available = opts.knownToolNames();

        // unknown tool 检测
        const unknown = toolCalls.filter((tc) => !available.includes(tc.name));
        if (unknown.length > 0) {
          const toolMessages = unknown.map((tc) => {
            const msg = new ToolMessage({
              tool_call_id: tc.id ?? `unknown_${tc.name}`,
              name: tc.name,
              content: `[UnknownTool] ${unknownToolNudge(tc.name, available)}`,
              status: 'error',
            });
            tagForgeMessage(msg, 'forge:unknown_tool_nudge');
            return msg;
          });
          return {
            messages: toolMessages,
            jumpTo: 'model' as const,
          };
        }

        // bare text 检测：无 tool_calls 且 content 非空
        if (toolCalls.length === 0 && content.trim().length > 0) {
          const nudge = new HumanMessage(retryNudge(content));
          tagForgeMessage(nudge, 'forge:retry_nudge');
          return {
            messages: [nudge],
            jumpTo: 'model' as const,
          };
        }

        return undefined;
      },
    },
  });
}
```

> **API 注释**：本 hook 需要从 afterModel 跳回 model 节点让模型重新生成，因此必须用 `{ canJumpTo: ['model'], hook }` 对象形态。`jumpTo` 字段的合法值仅 `'end' | 'tools' | 'model'`，且必须先在 `canJumpTo` 中声明。来源：[`docs.langchain.com/oss/javascript/langchain/middleware/custom`](https://docs.langchain.com/oss/javascript/langchain/middleware/custom)。

测试 `response-validation.test.ts`：

- bare text + 工具未注 → 注入 retry_nudge HumanMessage + jumpTo='model'。
- unknown tool → 每个未知 call 一条 ToolMessage + jumpTo='model'。
- 合法 tool_calls → 不动。
- respond 合成 → 不动（即使 content 非空、tool_calls 空，因为 tag）。
- 同时有 unknown + valid tool_calls → unknown 优先、其他不动（或全部拒绝）——按 forge 设计，整批拒绝；spec §3.5 测试 5 已规定每个未知 call 一条 ToolMessage、batch 整体回退。

### Step 6.4: agent-builder.ts 中挂入三条 middleware

> **中间阶段**：本 Phase 完成后的 guardrails 数组只含 5 条（不含 stepEnforcement / tieredCompaction / cleanup / toolRetryMiddleware）；最终版本见 Phase 10 §Step 10.3。

```ts
// agent-builder.ts (Phase 6 中间状态)
const guardrails = [
  createErrorBudgetMiddleware(),          // beforeAgent 初始化、wrapToolCall 计数
  createRespondToolInjectionMiddleware({ enabled: isLocalProvider }),
  createRescueParsingMiddleware({ availableTools: knownToolNames }),
  createResponseValidationMiddleware({ knownToolNames }),
  createToolResolutionMiddleware(),
];
```

### Step 6.5: 验证 + PR

```powershell
pnpm vitest run tests/main/services/forge-guardrails/middleware/
pnpm typecheck
```

提 PR：`feat(forge-guardrails): Phase 6 - response validation + tool resolution + error budget`.

---

## Phase 7: Step Enforcement + Prerequisite middleware

**Goal:** 落地 `createStepEnforcementMiddleware`，同时承载 prerequisite 检查。配置 `workflowResolver`、`prerequisitesConfig`。

**Dependencies:** Phase 4（workflowHint）、Phase 6（middleware 链）完成。

**Files:**
- Create: `src/main/services/forge-guardrails/middleware/step-enforcement.ts`、`tests/.../step-enforcement.test.ts`

### Step 7.1: `createStepEnforcementMiddleware`

```ts
// forge-guardrails/middleware/step-enforcement.ts
import { createMiddleware } from 'langchain';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import {
  forgeGuardrailsStateSchema,
  checkPrerequisitesMet,
  recordToolExecution,
  areRequiredStepsSatisfied,
  pendingRequiredSteps,
  bumpIteration,
  markIterationOnMessage,
} from '../state-schema';
import { stepNudge, prerequisiteNudge } from '../nudge-templates';
import { tagForgeMessage } from '../message-tags';
import { resolveWorkflow, type WorkflowHint } from '../workflow-resolver';
import type { PrerequisitesConfig } from '../prerequisites-config';
import { RocDomainError } from '../../errors';
import { FORGE_EXHAUSTED_CODES } from '../errors';

export function createStepEnforcementMiddleware(opts: {
  resolveWorkflowFromContext: () => WorkflowHint;
  prerequisitesConfig: PrerequisitesConfig;
}) {
  return createMiddleware({
    name: 'ForgeStepEnforcement',
    stateSchema: forgeGuardrailsStateSchema,

    /**
     * Sticky 初始化：只有当 state.forge_step_tracker 缺失 / 未带 requiredSteps 时
     * 才从 workflowHint 写入；resume 路径 workflowHint 为 null 但 checkpoint 已经存了
     * tracker，保留不覆盖（forge 原则 2.3）。
     */
    beforeAgent: (state) => {
      const existing = state.forge_step_tracker;
      const alreadyInitialized = existing && (existing.requiredSteps?.length > 0 || existing.terminalTools?.length > 0 || existing.iterationIndex > 0);
      if (alreadyInitialized) {
        return undefined;
      }
      const wf = resolveWorkflow(opts.resolveWorkflowFromContext());
      return {
        forge_step_tracker: {
          executedTools: existing?.executedTools ?? {},
          requiredSteps: wf?.requiredSteps ?? [],
          terminalTools: wf?.terminalTools ?? [],
          iterationIndex: 0,
          prematureAttempts: 0,
          prereqViolations: 0,
        },
      };
    },

    /**
     * 每次进入 model 前 iteration++；并把当前 iteration 标到上一条 AIMessage
     * 的 additional_kwargs 以备 TieredCompact 在边界定位时使用。
     */
    beforeModel: (state) => {
      const tracker = state.forge_step_tracker;
      if (!tracker) return undefined;
      const bumped = bumpIteration(tracker);
      const lastAi = [...state.messages].reverse().find((m) => AIMessage.isInstance(m));
      if (lastAi !== undefined) {
        markIterationOnMessage(lastAi, bumped.iterationIndex);
      }
      return { forge_step_tracker: bumped };
    },

    /**
     * 检测 premature terminal / prerequisite 违规；nudge + jumpTo 'model'。
     */
    afterModel: {
      canJumpTo: ['model'],
      hook: (state) => {
        const tracker = state.forge_step_tracker;
        if (!tracker) return undefined;
        const messages = state.messages;
        const last = messages[messages.length - 1];
        if (!AIMessage.isInstance(last) || !last.tool_calls || last.tool_calls.length === 0) return undefined;

        const toolCalls = last.tool_calls;

        // 1) Premature terminal check
        const terminalCalls = toolCalls.filter((tc) => tracker.terminalTools.includes(tc.name));
        const stepsSatisfied = areRequiredStepsSatisfied(tracker);
        if (terminalCalls.length > 0 && !stepsSatisfied) {
          const nextAttempts = tracker.prematureAttempts + 1;
          const tier = (Math.min(nextAttempts, 3) as 1 | 2 | 3);
          const maxAttempts = state.forge_error_tracker?.maxPrematureAttempts ?? 3;
          if (nextAttempts > maxAttempts) {
            throw new RocDomainError({
              code: FORGE_EXHAUSTED_CODES.stepEnforcement,
              message: `模型连续 ${nextAttempts} 次过早调用终止工具。`,
              category: 'external',
              retryable: true,
              userAction: '请检查 workflow 设置或模型行为。',
            });
          }
          const nudgeMessages = terminalCalls.map((tc) => {
            const msg = new ToolMessage({
              tool_call_id: tc.id ?? `step_${tc.name}`,
              name: tc.name,
              content: `[StepEnforcementError] ${stepNudge(tc.name, pendingRequiredSteps(tracker), tier)}`,
              status: 'error',
            });
            tagForgeMessage(msg, 'forge:step_nudge');
            return msg;
          });
          return {
            messages: nudgeMessages,
            forge_step_tracker: { ...tracker, prematureAttempts: nextAttempts },
            jumpTo: 'model' as const,
          };
        }

        // 2) Prerequisite check（整批）
        const violating = toolCalls.filter((tc) => {
          const rules = opts.prerequisitesConfig.prerequisites[tc.name];
          if (!rules || rules.length === 0) return false;
          return !checkPrerequisitesMet(tracker, tc.name, tc.args as Record<string, unknown>, rules).satisfied;
        });

        if (violating.length > 0) {
          const nextViolations = tracker.prereqViolations + 1;
          const maxViolations = state.forge_error_tracker?.maxPrereqViolations ?? 2;
          if (nextViolations > maxViolations) {
            throw new RocDomainError({
              code: FORGE_EXHAUSTED_CODES.prerequisite,
              message: `模型连续 ${nextViolations} 次违反前置依赖。`,
              category: 'external',
              retryable: true,
              userAction: '请检查 prereq 设置或模型行为。',
            });
          }
          const nudgeMessages = violating.map((tc) => {
            const rules = opts.prerequisitesConfig.prerequisites[tc.name]!;
            const result = checkPrerequisitesMet(tracker, tc.name, tc.args as Record<string, unknown>, rules);
            const missing = result.satisfied ? [] : result.missing;
            const msg = new ToolMessage({
              tool_call_id: tc.id ?? `prereq_${tc.name}`,
              name: tc.name,
              content: `[PrerequisiteError] ${prerequisiteNudge(tc.name, missing)}`,
              status: 'error',
            });
            tagForgeMessage(msg, 'forge:prerequisite_nudge');
            return msg;
          });
          return {
            messages: nudgeMessages,
            forge_step_tracker: { ...tracker, prereqViolations: nextViolations },
            jumpTo: 'model' as const,
          };
        }

        return undefined;
      },
    },

    /**
     * 成功的 tool 执行 → 记录到 executedTools。
     * 通过 Command({ update }) 同时携带 ToolMessage 与 state 更新。
     */
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      if (!ToolMessage.isInstance(result)) return result;
      if (result.status === 'error') return result;  // 失败 / 软错误不记录

      const tracker = request.state.forge_step_tracker;
      if (!tracker) return result;

      const args = (request.toolCall.args ?? {}) as Record<string, unknown>;
      const updatedTracker = recordToolExecution(tracker, request.toolCall.name, args);

      return new Command({
        update: {
          messages: [result],
          forge_step_tracker: updatedTracker,
        },
      });
    },
  });
}
```

> **API 注释**：`Command` 从 `@langchain/langgraph` 导入；`wrapToolCall` 返回 `Command({ update: { messages, forge_step_tracker } })` 才能让 state 更新和 ToolMessage 一起被 deepagents 的 messages reducer 与 stateSchema reducer 合并。`afterModel` 用对象形态 `{ canJumpTo: ['model'], hook }` 是 LangChain v1 要求的——任何会 `jumpTo` 的 hook 必须先在 `canJumpTo` 中声明合法目标。来源：[`docs.langchain.com/oss/javascript/langchain/middleware/custom`](https://docs.langchain.com/oss/javascript/langchain/middleware/custom) + [`docs.langchain.com/oss/javascript/langgraph/use-graph-api`](https://docs.langchain.com/oss/javascript/langgraph/use-graph-api)。

测试 `step-enforcement.test.ts`：

| 用例 | tracker.executedTools | tool_calls | 期望 |
|---|---|---|---|
| 调 confirm 未完成 propose/schedule | `{}` | `[confirm_with_user]` | step_nudge tier=1、prematureAttempts=1、jumpTo='model' |
| 再次过早调 | prematureAttempts=1 | `[confirm_with_user]` | tier=2、prematureAttempts=2 |
| 第三次过早 | prematureAttempts=2 | `[confirm_with_user]` | tier=3、prematureAttempts=3 |
| 第四次（超过 max=3） | prematureAttempts=3 | `[confirm_with_user]` | 抛 RocDomainError `forge_step_enforcement_exhausted` |
| 调 edit_file 未先 read_file | `{}` | `[edit_file(path:/a)]` | prereq_nudge、prereqViolations=1 |
| 调 read 后再调 edit 同路径 | `{read_file:[{path:/a}]}` | `[edit_file(path:/a)]` | 不动（满足） |
| 调 read 后再调 edit 异路径 | `{read_file:[{path:/a}]}` | `[edit_file(path:/b)]` | prereq_nudge |
| propose 已完成、schedule 已完成、调 confirm | `{propose:[...], schedule:[...]}` | `[confirm_with_user]` | 不动 |
| **sticky beforeAgent**：tracker 已带 requiredSteps + iterationIndex>0，workflowHint=null | `{propose:[{...}]}`、iterationIndex=3 | resume 状态 | beforeAgent 返回 undefined（不覆盖 requiredSteps）|
| **首轮 beforeAgent**：tracker 缺失、workflowHint='propose_background_task' | n/a | n/a | requiredSteps=['propose','schedule']、terminalTools=['confirm_with_user']、iterationIndex=0 |
| **beforeModel 自增 iterationIndex**：连续两轮 model 调用 | iterationIndex=2 | n/a | 第二轮 beforeModel 返回 forge_step_tracker.iterationIndex=3；上一条 AIMessage 的 additional_kwargs.forge_iteration_index=3 |
| **wrapToolCall 用 Command 同步 state**：模型成功调 propose | `{}` | `[propose_background_task(...)]` | 返回 `Command({ update: { messages, forge_step_tracker } })`、executedTools.propose_background_task.length=1 |
| **wrapToolCall 失败不记录**：propose 抛错 | `{}` | `[propose_background_task(...)]` | 直接返回 error ToolMessage（不 Command）、executedTools.propose_background_task 不存在 |

### Step 7.2: agent-builder.ts 中挂入

> **中间阶段**：本 Phase 完成后的 guardrails 数组只含 6 条（不含 tieredCompaction / cleanup / toolRetryMiddleware）；最终版本见 Phase 10 §Step 10.3。

```ts
// agent-builder.ts (Phase 7 中间状态)
const guardrails = [
  createErrorBudgetMiddleware(),
  createStepEnforcementMiddleware({
    resolveWorkflowFromContext: () => input.workflowHint,
    prerequisitesConfig: ROC_PREREQUISITES,
  }),
  createRespondToolInjectionMiddleware({ enabled: isLocalProvider }),
  createRescueParsingMiddleware({ availableTools: knownToolNames }),
  createResponseValidationMiddleware({ knownToolNames }),
  createToolResolutionMiddleware(),
];
```

`DeepAgentBuildInput` 加 `workflowHint: WorkflowHint`；`session.ts` 从 `context.workflowHint` 透传。

### Step 7.3: 集成测试

`tests/main/services/forge-guardrails/integration/propose-workflow.test.ts`：

```ts
describe('propose workflow integration', () => {
  it('完整链：propose -> schedule -> confirm', async () => {
    const { agent, previewStore } = await buildTestAgent({
      workflowHint: 'propose_background_task',
      modelScript: [
        // turn 1: 调 propose
        { tool_calls: [{ name: 'propose_background_task', args: { goal: 'X', trigger: { type: 'manual', description: 'M' }, workspacePath: '/r' }, id: 'c1' }] },
        // turn 2: 调 schedule
        { tool_calls: [{ name: 'schedule_background_task', args: { previewId: '@previewId' }, id: 'c2' }] },
        // turn 3: 调 confirm
        { tool_calls: [{ name: 'confirm_with_user', args: { summary: '已创建' }, id: 'c3' }] },
      ],
    });
    const result = await agent.invoke({ messages: [new HumanMessage('X')] });
    // 验证 final message 含 '已创建'
    // 验证 mockTaskService.createBackgroundTask 被调用 1 次
    // 验证 previewStore.size() === 0
  });

  it('跳过 schedule 直接调 confirm → step nudge tier=1; 三次后耗尽', async () => {
    // ...
  });

  it('schedule 用错 previewId → ToolResolutionError 喂回、模型重 propose', async () => {
    // ...
  });

  // 跨护栏集成（本轮新增）

  it('[跨护栏] rescue → step_tracker 累加：模型用 Mistral bracket 输出 propose → rescue 整流 → 进入 tools 节点 → wrapToolCall 记录 executedTools.propose_background_task.length=1', async () => {
    const { agent } = await buildTestAgent({
      workflowHint: 'propose_background_task',
      modelScript: [
        // turn 1: 野生格式
        { content: '[TOOL_CALLS]propose_background_task{"goal":"X","trigger":{"type":"manual","description":"M"},"workspacePath":"/r"}', tool_calls: [] },
        // turn 2: 正常 schedule
        { tool_calls: [{ name: 'schedule_background_task', args: { previewId: '@previewId' }, id: 'c2' }] },
        // turn 3: confirm
        { tool_calls: [{ name: 'confirm_with_user', args: { summary: '已创建' }, id: 'c3' }] },
      ],
    });
    const result = await agent.invoke({ messages: [new HumanMessage('X')] });
    // 关键断言：rescue 后下游 step-enforcement 看到的是规范 tool_calls，executedTools 累加正确
    expect(result.forge_step_tracker.executedTools.propose_background_task).toHaveLength(1);
    expect(result.forge_step_tracker.executedTools.schedule_background_task).toHaveLength(1);
  });

  it('[跨护栏] TieredCompact 后 step_tracker / error_tracker 不丢：触发 phase 1/2 压缩后 executedTools 与 prematureAttempts 数值保持不变', async () => {
    const { agent } = await buildTestAgent({
      workflowHint: 'propose_background_task',
      contextBudgetTokens: 500,   // 极小，强制触发压缩
      modelScript: [/* 模拟一个产生大量 nudge + tool_result 的工作流 */],
    });
    const result = await agent.invoke({ messages: [new HumanMessage('X')] });
    // 关键断言：control flow 不被 memory 压缩波及
    expect(result.forge_step_tracker.executedTools).toMatchObject({
      propose_background_task: expect.any(Array),
      schedule_background_task: expect.any(Array),
    });
    expect(result.forge_step_tracker.iterationIndex).toBeGreaterThan(0);
  });
});
```

`tests/main/services/forge-guardrails/integration/background-task-change.test.ts`：

```ts
describe('background_task_change workflow', () => {
  it('完整链：read -> update', async () => { /* ... */ });
  it('漏 read 直接 update → prereq nudge; 三次后耗尽', async () => { /* ... */ });
  it('read 用错 taskId → ToolResolutionError', async () => { /* ... */ });

  // 跨护栏 / sticky 集成（本轮新增）

  it('[B-2 回归] HITL 中断 resume 后 workflow 续跑：update_background_task 触发 HITL 卡 → 用户批准 resume → checkpoint 中的 forge_step_tracker.requiredSteps 与 executedTools 不被覆盖', async () => {
    const checkpointer = new MemorySaver();
    const config = { configurable: { thread_id: 'session-resume-1' } };

    // 1. 首轮：workflowHint='background_task_change'，调 read → update（触发 HITL）
    const agentFirst = await buildTestAgent({
      workflowHint: 'background_task_change',
      checkpointer,
      modelScript: [
        { tool_calls: [{ name: 'read_background_task', args: { taskId: 'T1' }, id: 'c1' }] },
        { tool_calls: [{ name: 'update_background_task', args: { taskId: 'T1', updates: {...} }, id: 'c2' }] },
      ],
    });
    const firstResult = await agentFirst.invoke({ messages: [new HumanMessage('改成每两天一次')] }, config);
    expect(firstResult.__interrupt__).toBeDefined();   // HITL 卡触发

    // 2. Resume：workflowHint 不再传（按 spec §Resolved Item 2）
    const agentResume = await buildTestAgent({
      workflowHint: null,   // <-- 关键：resume 时 workflowHint=null
      checkpointer,
      modelScript: [/* user 批准后无需 model 二次调用 */],
    });
    const resumed = await agentResume.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), config);

    // 关键断言：sticky beforeAgent 没把 requiredSteps 覆盖为 []，且 executedTools.read_background_task 保留
    const finalState = await agentResume.getState(config);
    expect(finalState.values.forge_step_tracker.executedTools.read_background_task).toHaveLength(1);
    // 如果 B-2 没修，这里 read_background_task 会被丢，因为 beforeAgent 会用 workflowHint=null 重置 requiredSteps 并把 executedTools 也清空（早期实现）
  });
});
```

### Step 7.4: 验证 + PR

```powershell
pnpm vitest run tests/main/services/forge-guardrails/
pnpm typecheck
```

提 PR：`feat(forge-guardrails): Phase 7 - step enforcement + prerequisite`.

---

## Phase 8: Forge TieredCompact via contextEditingMiddleware

**Goal:** 用 LangChain `contextEditingMiddleware` 注入 4 个自定义 `ContextEdit`，实现 forge 三阶段压缩（drop nudges → truncate tool_result → drop tool_result → drop reasoning + text）。

**Dependencies:** Phase 1（message-tags）完成。Phase 7（middleware 链）不强依赖（compact 与其他护栏正交），但放在 Phase 8 让 PR 顺序清晰。

**Files:**
- Create: `src/main/services/forge-guardrails/middleware/forge-tiered-compaction.ts`、对应测试

### Step 8.1: 4 个 ContextEdit

```ts
// forge-guardrails/middleware/forge-tiered-compaction.ts
import { contextEditingMiddleware, type ContextEdit } from 'langchain';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { isForgeTransientMessage, readForgeMessageTag } from '../message-tags';
import { readIterationFromMessage } from '../state-schema';

const PROTECTED_HEADER_COUNT = 2;  // system_prompt + initial user_input

/**
 * 用 message.additional_kwargs.forge_iteration_index 定位边界——
 * 由 step-enforcement.beforeModel 在每次进入 model 前打到上一条 AIMessage 上。
 *
 * keepRecent 表示"保留最近 N 个 iteration 的消息"；
 * 返回值 cutoff 是最早需保留的 message 的索引——cutoff 之前可以被压缩。
 *
 * 如果消息没有任何 iteration 标签（首轮或 message-tags 写入失败），
 * 退化为保留全部消息（cutoff = PROTECTED_HEADER_COUNT，不压缩）。
 */
function findEligibleEnd(messages: BaseMessage[], keepRecent: number): number {
  let maxIteration = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const idx = readIterationFromMessage(messages[i]);
    if (idx !== null && idx > maxIteration) maxIteration = idx;
  }
  if (maxIteration < 0) return PROTECTED_HEADER_COUNT;

  const keepThreshold = maxIteration - keepRecent;
  if (keepThreshold < 0) return PROTECTED_HEADER_COUNT;

  // 找到第一个 iterationIndex > keepThreshold 的 message 索引
  for (let i = PROTECTED_HEADER_COUNT; i < messages.length; i += 1) {
    const idx = readIterationFromMessage(messages[i]);
    if (idx !== null && idx > keepThreshold) return i;
  }
  return messages.length;
}

class ForgeDropNudgesEdit implements ContextEdit {
  constructor(private readonly keepRecent: number) {}
  async apply(params: { messages: BaseMessage[]; countTokens: (m: BaseMessage[]) => Promise<number> }): Promise<void> {
    const cutoff = findEligibleEnd(params.messages, this.keepRecent);
    for (let i = cutoff - 1; i >= PROTECTED_HEADER_COUNT; i -= 1) {
      if (isForgeTransientMessage(params.messages[i])) {
        params.messages.splice(i, 1);
      }
    }
  }
}

class ForgeTruncateToolResultsEdit implements ContextEdit {
  static readonly TRUNCATE_CHARS = 200;
  constructor(private readonly keepRecent: number) {}
  async apply(params: { messages: BaseMessage[]; countTokens: (m: BaseMessage[]) => Promise<number> }): Promise<void> {
    const cutoff = findEligibleEnd(params.messages, this.keepRecent);
    for (let i = PROTECTED_HEADER_COUNT; i < cutoff; i += 1) {
      const msg = params.messages[i];
      if (ToolMessage.isInstance(msg) && typeof msg.content === 'string' && msg.content.length > ForgeTruncateToolResultsEdit.TRUNCATE_CHARS) {
        const kept = msg.content.slice(0, ForgeTruncateToolResultsEdit.TRUNCATE_CHARS);
        const removed = msg.content.length - ForgeTruncateToolResultsEdit.TRUNCATE_CHARS;
        params.messages[i] = new ToolMessage({
          ...msg,
          content: `${kept}\n[Truncated — ${removed} chars removed]`,
        });
      }
    }
  }
}

class ForgeDropToolResultsEdit implements ContextEdit {
  constructor(private readonly keepRecent: number) {}
  async apply(params: { messages: BaseMessage[]; countTokens: (m: BaseMessage[]) => Promise<number> }): Promise<void> {
    const cutoff = findEligibleEnd(params.messages, this.keepRecent);
    for (let i = cutoff - 1; i >= PROTECTED_HEADER_COUNT; i -= 1) {
      const msg = params.messages[i];
      // 软错误 tool_resolution 不动（保留供模型理解）；硬 ToolMessage 全删
      if (ToolMessage.isInstance(msg) && readForgeMessageTag(msg) !== 'forge:tool_resolution') {
        params.messages.splice(i, 1);
      }
    }
  }
}

class ForgeDropReasoningTextEdit implements ContextEdit {
  constructor(private readonly keepRecent: number) {}
  async apply(params: { messages: BaseMessage[]; countTokens: (m: BaseMessage[]) => Promise<number> }): Promise<void> {
    const cutoff = findEligibleEnd(params.messages, this.keepRecent);
    for (let i = cutoff - 1; i >= PROTECTED_HEADER_COUNT; i -= 1) {
      const msg = params.messages[i];
      const tag = readForgeMessageTag(msg);
      if (tag === 'forge:reasoning') {
        params.messages.splice(i, 1);
        continue;
      }
      // 失败的 text_response（AIMessage 空 tool_calls 且非 respond_synthetic）
      if (AIMessage.isInstance(msg) && (!msg.tool_calls || msg.tool_calls.length === 0) && tag !== 'forge:respond_synthetic') {
        params.messages.splice(i, 1);
      }
    }
  }
}

/**
 * 阈值触发的三阶段压缩。每个 ContextEdit 在 apply 入口先用 countTokens 自检；
 * 未达阈值时直接 return，避免对正常会话造成不必要 mutation。
 *
 * countTokens 由 contextEditingMiddleware 自动注入。tokenCountMethod 是真实配置字段；
 * 本批显式使用 "approx"，budget 默认值已经留好 12% safety margin
 * （8192 ctx 给到 7168 budget）。
 */
export function createForgeTieredCompactionMiddleware(opts: {
  budgetTokens: number;
  keepRecent?: number;
  phaseThresholds?: [number, number, number];
}) {
  const keepRecent = opts.keepRecent ?? 2;
  const [t1, t2, t3] = opts.phaseThresholds ?? [0.6, 0.75, 0.9];

  const phase1: ContextEdit = {
    async apply(params) {
      // 检查是否已执行过此 phase（通过 state.forge_tier_compact_phase）
      const state = params.state as ForgeGuardrailsState;
      if (state.forge_tier_compact_phase >= 1) return;
      
      const tokens = await params.countTokens(params.messages);
      if (tokens < opts.budgetTokens * t1) return;
      
      await new ForgeDropNudgesEdit(keepRecent).apply(params);
      await new ForgeTruncateToolResultsEdit(keepRecent).apply(params);
      
      // 标记已执行 phase 1
      return Command({
        update: { forge_tier_compact_phase: 1 }
      });
    },
  };

  const phase2: ContextEdit = {
    async apply(params) {
      const state = params.state as ForgeGuardrailsState;
      if (state.forge_tier_compact_phase >= 2) return;
      
      const tokens = await params.countTokens(params.messages);
      if (tokens < opts.budgetTokens * t2) return;
      
      await new ForgeDropToolResultsEdit(keepRecent).apply(params);
      
      return Command({
        update: { forge_tier_compact_phase: 2 }
      });
    },
  };

  const phase3: ContextEdit = {
    async apply(params) {
      const state = params.state as ForgeGuardrailsState;
      if (state.forge_tier_compact_phase >= 3) return;
      
      const tokens = await params.countTokens(params.messages);
      if (tokens < opts.budgetTokens * t3) return;
      
      await new ForgeDropReasoningTextEdit(keepRecent).apply(params);
      
      return Command({
        update: { forge_tier_compact_phase: 3 }
      });
    },
  };

  return contextEditingMiddleware({
    edits: [phase1, phase2, phase3],
    tokenCountMethod: 'approx',
  });
}
```

> **API 注释**：
> - `ContextEdit` 是 interface（不是 abstract class），`apply(params: { messages, countTokens, model? }): void | Promise<void>` 就地修改 `messages` 数组，不返回新数组。来源：本地 `node_modules/langchain/dist/agents/middleware/contextEditing.d.ts`。
> - `tokenCountMethod?: 'approx' | 'model'` 是 contextEditingMiddleware 的真实配置字段，默认 `'approx'`；本批显式设为 `'approx'`。
> - 阈值触发判定下沉到每个 ContextEdit 内部——`contextEditingMiddleware` 的 `edits` 数组会按顺序调用每个 edit.apply，这样 plan 的三阶段语义就成立。
> - budget 默认 7168（8192 ctx 留 12% safety margin），由 `contextBudgetTokens` ProviderConfig 字段覆盖。

测试 `forge-tiered-compaction.test.ts`：

构造一系列 messages（带不同 tag 与长度），用三组 budget × trigger 数据：

| 用例 | tokens / budget | 期望 |
|---|---|---|
| 0.5 → 无操作 | 500/1000 | messages 不变，`forge_tier_compact_phase = 0` |
| 0.65 → Phase 1 | 700/1000 | 旧 nudge 删除、旧 ToolMessage 被截断到 200 字符，`forge_tier_compact_phase = 1` |
| 0.8 → Phase 2 | 850/1000 | 旧 nudge + 旧 ToolMessage 全删；reasoning / text 保留，`forge_tier_compact_phase = 2` |
| 0.95 → Phase 3 | 980/1000 | 旧 nudge + 旧 ToolMessage + 旧 reasoning + 旧 text 全删；仅 tool_call AIMessage 保留，`forge_tier_compact_phase = 3` |
| **phase 单调性**：state.forge_tier_compact_phase = 2，tokens 触发 phase 1 | 700/1000 | phase 1 跳过（已执行过更高 phase），messages 不变，`forge_tier_compact_phase` 保持 2 |
| 保留窗口 | keepRecent=2 | 最后 2 个 AIMessage 及其相关消息不动 |
| system_prompt + user_input 永不删 | 任何阶段 | messages[0] / messages[1] 保留 |
| forge:tool_resolution 不被当作 tool_result 删 | phase 2/3 | 标 tool_resolution 的 ToolMessage 保留 |
| forge:respond_synthetic 不被当作 text_response 删 | phase 3 | 标 respond_synthetic 的 AIMessage 保留 |
| **iterationIndex 边界**：messages 中没有 forge_iteration_index 标签 | 任何阶段 | cutoff 退化到 PROTECTED_HEADER_COUNT，不压缩（fail-safe）|
| **iterationIndex 边界**：keepRecent=2、当前 iterationIndex=5 | phase 1 | 仅 iterationIndex ∈ {0,1,2,3} 的 message 可被压缩；{4,5} 完整保留 |

### Step 8.2: agent-builder.ts 集成 + PR

```ts
// agent-builder.ts (增量)
import { toolRetryMiddleware } from 'langchain';
import { createForgeTieredCompactionMiddleware } from '../forge-guardrails';

const NETWORK_SENSITIVE_TOOLS = [
  'web_read',
  'schedule_background_task',
  'update_background_task',
  'cancel_background_task',
];

const guardrails = [
  // 最外层：网络瞬时错误 retry 在 forge error budget 之前吸收
  toolRetryMiddleware({
    maxRetries: 2,
    tools: NETWORK_SENSITIVE_TOOLS,
    backoffFactor: 1.5,
    // retryOn 不指定 → 默认对 TimeoutError / 5xx / network failure 重试
  }),
  createErrorBudgetMiddleware(),
  createStepEnforcementMiddleware({...}),
  createForgeTieredCompactionMiddleware({
    budgetTokens: input.contextBudgetTokens ?? 7168,   // 8192 ctx - 12% safety margin
    keepRecent: 2,
    phaseThresholds: [0.6, 0.75, 0.9],
  }),
  createRespondToolInjectionMiddleware({...}),
  createRescueParsingMiddleware({...}),
  createResponseValidationMiddleware({...}),
  createToolResolutionMiddleware(),
];
```

> **C-1 修复**：`toolRetryMiddleware` 是 LangChain v1 官方 retry middleware，放在 guardrails 数组**最外层**（最先执行）。它只对 `tools` 列表里的工具启用 retry，且在 retry 耗尽后才会让 ToolMessage 流入 forge `ErrorBudget` 计数器——避免网络抖动浪费 budget。来源：[`docs.langchain.com/oss/javascript/langchain/middleware/built-in`](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in)（Tool retry）+ [`docs.langchain.com/oss/javascript/deepagents/going-to-production`](https://docs.langchain.com/oss/javascript/deepagents/going-to-production)（同款示例）。

```powershell
pnpm vitest run tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts
pnpm typecheck
```

提 PR：`feat(forge-guardrails): Phase 8 - tiered compaction via contextEditingMiddleware`.

---

## Phase 9: 审计 wiring + 跨 turn 过滤

**Goal:** 把 forge nudge 消息分流到独立 `'guardrail_nudge'` 事件类型；在 `initial_messages` 重放前过滤 transient 标签消息。

**Dependencies:** Phase 5-8 完成（middleware 已注入消息标签）。

**Files:**
- Modify: `src/shared/types/task.ts`、`src/main/services/deep-agent/stream-consumers.ts`、`src/main/services/task-service.ts`、`src/main/services/deep-agent/session.ts`、`src/main/services/deep-agent-runtime-service.ts`、`src/main/services/deep-agent/error-mapping.ts`

### Step 9.1: TaskEvent type 扩展

```ts
// shared/types/task.ts (修改)
export type TaskEvent = {
  // ...
  type:
    | 'message'
    | 'message_delta'
    | 'reasoning_delta'
    | 'tool_call'
    | 'subagent_started'
    | 'subagent_completed'
    | 'guardrail_nudge'  // 新增
    // ... 其它既有类型
  ;
};

export type GuardrailNudgePayload = {
  nudgeKind: 'retry' | 'unknown_tool' | 'step' | 'prerequisite' | 'tool_resolution' | 'context_warning';
  tier?: number;
  content: string;
  toolCallId?: string;
  toolName?: string;
};
```

### Step 9.2: stream-consumers 识别 forge tag 并分流

```ts
// deep-agent/stream-consumers.ts (consumeMessageStream 中)
// 对每条流出的 message，检查 forge_message_type 标签：
const forgeTag = readForgeMessageTag(message);  // 需要 import
if (forgeTag !== null && FORGE_TRANSIENT_TYPES.has(forgeTag)) {
  // 不进 assistantChunks；写独立审计事件
  callbacks.recordTaskEvent('guardrail_nudge', {
    nudgeKind: forgeTagToNudgeKind(forgeTag),
    content: redact(typeof message.content === 'string' ? message.content : ''),
    // tier / toolCallId / toolName 按 message 类型抽取
  });
  continue;  // 不进入 assistantDelta 通道
}
// 其它消息走原路径
```

`forgeTagToNudgeKind` 工具函数把 `'forge:retry_nudge'` → `'retry'` 等。

`createBoundedTaskDeltaRecorder` 的 type 参数扩展接受 `'guardrail_nudge'`。

### Step 9.3: session 入口过滤 + ForgeCleanupMiddleware

**两套保险**：
- (a) 入口过滤：`createDeepAgentSession` 把 `initial_messages` 中的 transient 标签消息过滤掉，避免 checkpoint 中残留的 nudge 被当作历史发回模型。
- (b) `afterAgent` 清理：每次 agent run 结束前用 `RemoveMessage` 把 transient 消息从 state 中删除，让下次 checkpoint 写入时就已干净。

```ts
// deep-agent/session.ts (createDeepAgentSession 入口) — (a) 兜底
import { isForgeTransientMessage } from '../forge-guardrails';

const filteredInitialMessages = (input.initialMessages ?? []).filter(
  (msg) => !isForgeTransientMessage(msg)
);
// 把 filteredInitialMessages 喂给 agent.streamEvents 而不是原始数组
```

```ts
// src/main/services/forge-guardrails/middleware/forge-cleanup.ts — (b) 首选
import { createMiddleware } from 'langchain';
import { RemoveMessage } from '@langchain/core/messages';
import { isForgeTransientMessage } from '../message-tags';

/**
 * agent run 结束前清理 transient nudge 消息，保证 checkpoint 干净。
 *
 * forge 原则 2.3 "control flow ≠ memory" 的体现：
 * - executedTools / iterationIndex / consecutive* 由 forge_step_tracker / forge_error_tracker 承载，
 *   不依赖 messages 历史；
 * - 因此删除 transient nudge 不会破坏运行状态的正确性。
 *
 * 这种 checkpoint 中 messages 与 step_tracker 的"不一致"是**设计意图**，
 * 不是 bug——下游 reviewer 看到 step_tracker.executedTools.propose_background_task
 * 有记录但 messages 里看不到对应 tool_call AIMessage 时，应理解为 transient 清理后的预期状态。
 */
export function createForgeCleanupMiddleware() {
  return createMiddleware({
    name: 'ForgeCleanupMiddleware',
    afterAgent: (state) => {
      const toRemove = state.messages
        .filter(isForgeTransientMessage)
        .map((m) => new RemoveMessage({ id: m.id! }));
      if (toRemove.length === 0) return undefined;
      return { messages: toRemove };
    },
  });
}
```

> **API 注释**：`RemoveMessage` 从 `@langchain/core/messages` 导入。配合 deepagents 默认 messages reducer（兼容 `messagesStateReducer`）使用——收到 `RemoveMessage` 时按 id 删除原 message。不要从 `'langchain'` 包根重导出处导入；前者是公开 API、后者偶发版本漂移。来源：[`docs.langchain.com/oss/javascript/langgraph/add-memory`](https://docs.langchain.com/oss/javascript/langgraph/add-memory)。

`agent-builder.ts` 把 `createForgeCleanupMiddleware()` 放在 guardrails 数组最末位（最后执行 afterAgent，保证所有上游 middleware 写入的 transient 标签都被清理）。

### Step 9.4: error-mapping 补 forge_*_exhausted

```ts
// deep-agent/error-mapping.ts (toRunFailure 中加分支)
if (error instanceof RocDomainError) {
  if (error.code.startsWith('forge_') && error.code.endsWith('_exhausted')) {
    return {
      code: error.code,
      message: redact(error.message),
      retryable: error.retryable,
    };
  }
  // ... 既有逻辑
}
```

### Step 9.5: task-service.recordEvent 接受新类型

确认 `task-event-recorder.ts` 与 SQLite schema 不限制 `type` 字段值（应为 TEXT）。如果有 enum 约束，扩展之。

### Step 9.6: 测试 + PR

```ts
// tests/main/deep-agent-runtime-service.test.ts (新增)
it('forge:retry_nudge 消息被分流到 guardrail_nudge 事件、不进 assistantChunks', async () => {
  // 模拟 model script 让 response-validation 生成 retry_nudge
  // 断言 task_events 表中存在 type='guardrail_nudge' 一行
  // 断言 ChatRunEvent message_delta 不含 nudge 内容
});

it('afterAgent 清理 transient 消息', async () => {
  // 运行 agent 一轮，注入 nudge；run 结束后查 checkpoint state 不含 forge:retry_nudge 标签消息
});
```

```powershell
pnpm vitest run tests/main/deep-agent-runtime-service.test.ts -t "guardrail_nudge|afterAgent"
pnpm typecheck
```

提 PR：`feat(forge-guardrails): Phase 9 - audit wiring + transient filtering`.

---

## Phase 10: 系统提示重塑 + Final Integration

**Goal:** 在 `prompt.ts` 中根据 `workflowHint` 追加工作流概述（仅声明工具集与可用动作，不告诉模型 prereq / required_steps —— 这些靠 nudge 在违规时矫正）。完成 agent-builder.ts 最终编排，跑通端到端集成测试。

**Dependencies:** Phase 5-9 完成。

**Files:**
- Modify: `src/main/services/deep-agent/prompt.ts`、`src/main/services/agent-service.ts`、`src/main/services/deep-agent/agent-builder.ts`

### Step 10.1: prompt.ts 增量

```ts
// deep-agent/prompt.ts (修改 buildSystemPrompt)
export function buildSystemPrompt(input: {
  enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
  workspacePath: string | null;
  workflowHint: WorkflowHint;  // 新增
}): string {
  const base = [
    ROC_STATIC_SYSTEM_PROMPT,
    ...createWorkspaceBoundary(input.workspacePath),
    `Capabilities: ${createCapabilitySummary(input.enabledCapabilities)}`,
  ];

  if (input.workflowHint === 'propose_background_task') {
    base.push(
      '',
      '本轮工作流：创建后台任务。',
      '可用工具：propose_background_task / schedule_background_task / confirm_with_user。',
      'propose 仅生成草稿；schedule 才实际落地；confirm 通知用户工作完成。',
    );
  } else if (input.workflowHint === 'background_task_change') {
    base.push(
      '',
      '本轮工作流：修改已有后台任务。',
      '可用工具：read_background_task / update_background_task / cancel_background_task。',
      'update / cancel 会触发用户审批；read 用于先看清楚再改。',
    );
  }

  return base.join('\n');
}
```

> **关键约束**：**不**写"先 propose 再 schedule"、"先 read 再 update"这类强约束。forge 哲学："通过 nudge 在违规时矫正，而非在每次 prompt 中预防"。系统提示只列工具、不列约束。

### Step 10.2: agent-service.ts 增量

```ts
// agent-service.ts (createBackgroundTaskCard 调用)
const toolCards = [
  executeCard,
  webReadCard,
  deleteFileCard,
  this.createBackgroundTaskCard('propose_background_task', '生成后台任务 preview（不创建）。', false),
  this.createBackgroundTaskCard('schedule_background_task', '把 preview 落地为后台任务。', false),
  this.createBackgroundTaskCard('confirm_with_user', '工作流终止信号。', false),
  this.createBackgroundTaskCard('read_background_task', '读取后台任务详情。', false),
  this.createBackgroundTaskCard('update_background_task', '提议修改已有后台任务。', true),
  this.createBackgroundTaskCard('cancel_background_task', '提议取消已有后台任务。', true),
  ...selectedMcpCards,
];
```

### Step 10.3: agent-builder.ts 最终编排

把所有 middleware 按 spec §"八条护栏的接入点与执行顺序" 顺序放入。**外层吸收瞬时网络错误 → forge 错误预算 → 流程控制 → 模型回合改造 → 上下文压缩 → 模型输出整流 → 状态记录与软错误标识 → 出口清理**：

```ts
import { toolRetryMiddleware } from 'langchain';
import {
  createErrorBudgetMiddleware,
  createStepEnforcementMiddleware,
  createRespondToolInjectionMiddleware,
  createForgeTieredCompactionMiddleware,
  createRescueParsingMiddleware,
  createResponseValidationMiddleware,
  createToolResolutionMiddleware,
  createForgeCleanupMiddleware,
  ROC_PREREQUISITES,
} from '../forge-guardrails';

const NETWORK_SENSITIVE_TOOLS = [
  'web_read',
  'schedule_background_task',
  'update_background_task',
  'cancel_background_task',
];

const guardrails = [
  // 1. 网络瞬时错误的 retry 最外层吸收（C-1）
  toolRetryMiddleware({
    maxRetries: 2,
    tools: NETWORK_SENSITIVE_TOOLS,
    backoffFactor: 1.5,
  }),

  // 2. forge 双计数器（硬错误 + retry nudge），耗尽抛 RocDomainError
  createErrorBudgetMiddleware(),

  // 3. 流程控制（required_steps / prerequisites）+ iterationIndex 自增
  createStepEnforcementMiddleware({
    resolveWorkflowFromContext: () => input.workflowHint,
    prerequisitesConfig: ROC_PREREQUISITES,
  }),

  // 4. 本地 Provider 注入合成 respond 工具
  createRespondToolInjectionMiddleware({ enabled: isLocalProvider }),

  // 5. 三阶段上下文压缩（基于 iterationIndex 而非 AIMessage 位置）
  createForgeTieredCompactionMiddleware({
    budgetTokens: input.contextBudgetTokens ?? 7168,   // 8192 ctx - 12% safety margin
    keepRecent: 2,
  }),

  // 6. 模型输出野生格式整流（必须早于 response-validation）
  createRescueParsingMiddleware({ availableTools: knownToolNames }),

  // 7. 模型输出语义校验：unknown tool / bare text 矫正
  createResponseValidationMiddleware({ knownToolNames }),

  // 8. RocToolResolutionError 转 ToolMessage（不计入硬错误）
  createToolResolutionMiddleware(),

  // 9. agent run 结束前清理 transient nudge，让 checkpoint 干净
  createForgeCleanupMiddleware(),
];
```

> **顺序说明**：guardrails 数组顺序就是 middleware 执行顺序（首元素最外层）。关键不变量：
> - retry middleware 在 errorBudget 之前 → 网络抖动不消耗 forge 错误预算
> - stepEnforcement 在 respondInjection 之前 → step_tracker 不被 respond 工具污染
> - rescueParsing 在 responseValidation 之前 → 整流后的 tool_calls 进入下游校验
> - cleanup 在最末位 → 所有上游 middleware 写入的 transient 标签都被清理
> 来源：[`docs.langchain.com/oss/javascript/deepagents/going-to-production`](https://docs.langchain.com/oss/javascript/deepagents/going-to-production) middleware 排序示例。

### Step 10.4: 端到端集成测试

`tests/main/services/forge-guardrails/integration/propose-workflow.test.ts` 与 `background-task-change.test.ts` 在 Phase 7 已写；Phase 10 验证整个链路在所有 middleware 同时挂载的情况下行为正确。

新增 `tests/main/services/forge-guardrails/integration/full-stack.test.ts`：

```ts
describe('forge guardrails full stack', () => {
  it('本地 Provider + workflowHint=propose 跑通完整链', async () => {
    // 用 mock ChatModel 模拟本地模型行为：
    // turn 1: 返回 Mistral bracket 格式 propose → rescue 救回
    // turn 2: 返回正常 schedule
    // turn 3: 返回 respond 工具调用（被 respond middleware 剥离）→ 仍未调 confirm → step nudge
    // turn 4: 返回正常 confirm
    // 断言：5 个 task_events 中 1 个 guardrail_nudge（step nudge）、其余正常
  });

  it('云端 Provider + chat 模式无 workflow', async () => {
    // 验证 respond middleware 不注入 respond 工具；其余护栏依然生效
  });

  it('错误预算耗尽抛 RocDomainError 并通过 error-mapping 转 RunFailure', async () => {
    // 让模型连续抛 RuntimeError 3 次 → wrapToolCall 第 4 次抛 forge_tool_errors_exhausted
    // 验证 ChatRunEvent run_failed 的 code 字段
  });
});
```

```powershell
pnpm vitest run tests/main/services/forge-guardrails/integration/
pnpm typecheck
pnpm test
```

提 PR：`feat(forge-guardrails): Phase 10 - system prompt + final wiring + integration`.

---

## Phase 11: Renderer & Smoke

**Goal:** Renderer 端识别 `guardrail_nudge` 事件（仅用于审计 / 显示，无业务行为），smoke 包覆盖 propose workflow。

**Files:**
- Modify: `src/renderer/views/tasks/TaskDetailDrawer.tsx`（或对应 run-output 渲染）、`tests/smoke/electron-smoke.mjs`

### Step 11.1: Renderer 渲染 guardrail_nudge

在 task run output 面板的"事件列表"中渲染 guardrail_nudge 事件——用低调样式（灰色斜体）显示，标明`[护栏: <kind>]`。**不阻断用户视线**，只是审计可见。

```tsx
// renderer/views/tasks/TaskRunOutputPanel.tsx (增量)
function renderTaskEvent(event: TaskEvent): React.ReactNode {
  // ...
  if (event.type === 'guardrail_nudge') {
    const payload = event.payload as GuardrailNudgePayload;
    return (
      <li className="run-event run-event--guardrail" key={event.id}>
        <span className="run-event__label">[护栏: {payload.nudgeKind}]</span>
        <span className="run-event__content">{payload.content}</span>
      </li>
    );
  }
  // ...
}
```

CSS class `.run-event--guardrail` 用 `color: var(--muted-fg); font-style: italic`。

### Step 11.2: Smoke

`tests/smoke/electron-smoke.mjs` 新增："启动 propose workflow + 在中途模型模拟错误 → 看到 guardrail_nudge 事件被持久化"。

具体实现取决于 smoke harness 现有 mock 模型能力——若难以模拟 forge 触发条件，本 step 可降级为：

- 走完整 propose → schedule → confirm（用一个 mock 模型脚本完成）；
- 断言 `task_events` 中存在 type='message_delta'、type='tool_call' 等；
- 断言 `BackgroundTask` 表中存在新创建的 task。

```powershell
pnpm smoke:electron
```

Expected: PASS。

### Step 11.3: PR

提 PR：`feat(forge-guardrails): Phase 11 - renderer guardrail_nudge + smoke`.

---

## Phase 12: Verification Matrix

- [ ] **Step 1: 基础层单元测试**

```powershell
pnpm vitest run tests/main/services/forge-guardrails/ --reporter=verbose
```

Expected: 所有基础层（errors / message-tags / state-schema / nudge-templates / rescue-parser / sampling-defaults / prerequisites-config / preview-store / workflow-resolver / respond-tool）测试 PASS。

- [ ] **Step 2: Middleware 单元测试**

```powershell
pnpm vitest run tests/main/services/forge-guardrails/middleware/ --reporter=verbose
```

Expected: 8 个 middleware 各自的单元测试 PASS。

- [ ] **Step 3: Integration**

```powershell
pnpm vitest run tests/main/services/forge-guardrails/integration/ --reporter=verbose
```

Expected: propose-workflow / background-task-change / full-stack 集成测试 PASS。

- [ ] **Step 4: deep-agent 工具改造测试**

```powershell
pnpm vitest run tests/main/services/deep-agent/ --reporter=verbose
```

Expected: read-background-task / confirm-with-user / background-task-tools-propose-schedule 等 PASS。

- [ ] **Step 5: deep-agent-runtime-service 兼容性**

```powershell
pnpm vitest run tests/main/deep-agent-runtime-service.test.ts --reporter=verbose
```

Expected: 现有测试 0 回归 + 新增 workflowHint / guardrail_nudge 测试 PASS。

- [ ] **Step 6: LangChainModelFactory + sampling**

```powershell
pnpm vitest run tests/main/services/langchain-model-factory.sampling.test.ts
```

Expected: PASS。

- [ ] **Step 7: Renderer 回归**

```powershell
pnpm vitest run tests/renderer/tasks-view.test.ts tests/renderer/tasks-view.interaction.test.ts tests/renderer/chat-view.test.ts
```

Expected: 现有渲染测试 0 回归；新增 workflowHint UI 测试 PASS。

- [ ] **Step 8: Typecheck**

```powershell
pnpm typecheck
```

Expected: 0 errors.

- [ ] **Step 9: Full test suite**

```powershell
pnpm test
```

Expected: PASS。

- [ ] **Step 10: Smoke**

```powershell
pnpm smoke:electron
```

Expected: PASS。

- [ ] **Step 11: Manual scenario verification**

启动 Roc 开发模式（`pnpm dev`），执行以下手动验证清单：

1. **propose workflow**：在 TasksView 输入"每天 19:40 抓新闻"→ 提交 → 观察 task workbench 显示 propose / schedule / confirm 三个工具调用都被发起 → 任务被创建且加入 scheduler。
2. **propose workflow 跳步骤**：用本地 `llama_cpp` Provider + 一个"故意跳过 schedule"的指令 → 看到 task workbench 显示 `[护栏: step]` 灰色事件、之后模型纠正、完成 workflow。
3. **背景任务修改**：在 task workbench 选一个已有任务 → "在聊天里修改" → 跳到 chat view → 输入"改成每两天一次" → 看到模型调 read_background_task → update_background_task → HITL 卡 → 批准 → 任务更新。
4. **背景任务修改漏 read**：手动模拟模型直接调 update（用调试器或 mock 模型）→ 看到 `[护栏: prerequisite]` 事件 → 模型纠正。
5. **本地 Provider + 野生格式 rescue**：用 `llama_cpp` 本地模型或 mock 模型输出 `[TOOL_CALLS]get_weather{"city":"X"}` → 看到正常工具被执行（rescue 救回）。
6. **跨 turn 过滤**：完成一次有 nudge 的 task → 在同一 thread 发第二条 input → 检查模型上下文不含上一轮的 nudge（通过日志或 LangGraph state 查看）。

- [ ] **Step 12: 第二轮修订专项验证**（本轮新增）

```powershell
# B-1 / iterationIndex
pnpm vitest run tests/main/services/forge-guardrails/middleware/step-enforcement.test.ts -t "beforeModel 自增 iterationIndex"
pnpm vitest run tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts -t "iterationIndex 边界"

# B-2 / sticky beforeAgent
pnpm vitest run tests/main/services/forge-guardrails/middleware/step-enforcement.test.ts -t "sticky beforeAgent"
pnpm vitest run tests/main/services/forge-guardrails/integration/background-task-change.test.ts -t "B-2 回归"

# A-2 / wrapToolCall 返回 Command
pnpm vitest run tests/main/services/forge-guardrails/middleware/error-budget.test.ts -t "Command"
pnpm vitest run tests/main/services/forge-guardrails/middleware/step-enforcement.test.ts -t "wrapToolCall 用 Command 同步 state"

# A-1 / canJumpTo 对象形态
pnpm vitest run tests/main/services/forge-guardrails/middleware/response-validation.test.ts -t "jumpTo='model'"
pnpm vitest run tests/main/services/forge-guardrails/middleware/step-enforcement.test.ts -t "jumpTo='model'"

# C-1 / toolRetryMiddleware
pnpm vitest run tests/main/services/forge-guardrails/integration/full-stack.test.ts -t "网络瞬时错误不消耗 forge error budget"

# D / 跨护栏集成
pnpm vitest run tests/main/services/forge-guardrails/integration/propose-workflow.test.ts -t "跨护栏"
```

Expected: 全部 PASS。任何一项 fail 都意味着 plan 第二轮修订未正确落地，必须返回 spec / plan 重审。

---

## Review Checklist

- [ ] forge 8 条护栏（rescue / respond / response_validation / step_enforcement / prerequisite / tool_resolution / error_budget / tiered_compaction）全部实现并按 spec §"八条护栏的接入点与执行顺序"排序。
- [ ] `ChatStartRunRequest.workflowHint` 通路打通：renderer → preload → ipc → runtime → session → agent-builder。
- [ ] `propose_background_task` 被改为仅生成 preview;`schedule_background_task` 新增；`confirm_with_user` 新增；`read_background_task` 新增。
- [ ] `openBackgroundTaskInChat` 的 `pendingThreadContexts.enqueue` 调用已删除。
- [ ] `TasksView.submitTaskDescription` 不再用 `buildTaskProposalPrompt` 包装 input；改为传 `workflowHint: 'propose_background_task'`。
- [ ] `LangChainModelFactory` 对 `llama_cpp` Provider 自动叠加 family default + Provider override；未识别 family 写 INFO log 不抛错。
- [ ] `forge_message_type` 标签写入消息 `additional_kwargs`；`isForgeTransientMessage` 在 5 个 transient 类型上返回 true。
- [ ] `'guardrail_nudge'` 事件类型新增到 `TaskEvent['type']`；nudge 消息走独立审计通道、不进 assistant chunk。
- [ ] transient 消息通过 `ForgeCleanupMiddleware.afterAgent` 清理 + `initial_messages` 入口过滤两套保险。
- [ ] `error-mapping.ts` 识别 `forge_*_exhausted` 错误代码并正确转 RunFailure。
- [ ] 系统提示 `buildSystemPrompt` 根据 `workflowHint` 追加工具集声明，但**不**写 required_steps / prereq 顺序——按 forge 哲学，nudge 在违规时矫正。
- [ ] `buildTaskProposalPrompt` 标 `@deprecated`，本批保留兼容。
- [ ] `package.json` 不新增 Provider 依赖；无 LangChain 版本调整。
- [ ] **不**复制 forge 26 场景 eval harness、**不**做 ablation 评测、**不**在 UI / 代码中暴露护栏开关。
- [ ] 所有耗尽分支抛 `RocDomainError` 而非走 HITL；`schedule_background_task` direct-create/no HITL；`confirm_with_user` 只是 terminal signal；现有 update/cancel HITL 行为不变。
- [ ] vitest 全部新增测试 PASS；`pnpm typecheck` 0 error；`pnpm test` 全过；`pnpm smoke:electron` 通过。
- [ ] 12 处提交按 Phase 拆分，每个 Phase 一个 PR；每个 PR 在合并前跑过 Phase 内的目标测试。

### 第二轮修订专项 review 项（本轮新增）

- [ ] **A-1**：所有用 `jumpTo` 的 hook（response-validation / step-enforcement 的 afterModel）都用 `{ canJumpTo: ['model'], hook }` 对象形态；`jumpTo` 字段加 `as const` 确保类型推断。
- [ ] **A-2**：所有需要同时更新 state 与返回 ToolMessage 的 `wrapToolCall`（error-budget / step-enforcement）都返回 `Command({ update: { messages, forge_*_tracker } })` 而非裸 ToolMessage。
- [ ] **A-3**：`RemoveMessage` 从 `@langchain/core/messages` 导入（不从 `'langchain'` 重导出处导入）；rescue-parsing 替换消息用 `[RemoveMessage(id), rebuilt(sameId)]`；`createForgeCleanupMiddleware.afterAgent` 用 `RemoveMessage` 删 transient。
- [ ] **B-1**：`forge_step_tracker.iterationIndex` 字段存在；`step-enforcement.beforeModel` 自增；`markIterationOnMessage` 标到上一条 AIMessage 的 `additional_kwargs.forge_iteration_index`；`forge-tiered-compaction.findEligibleEnd` 用 iterationIndex 而非 AIMessage 位置定位边界。
- [ ] **B-2**：`step-enforcement.beforeAgent` 在 `state.forge_step_tracker.requiredSteps?.length > 0` 时返回 undefined（sticky 不覆盖）；resume 路径 workflowHint=null 时 checkpoint 中的 executedTools 与 iterationIndex 完整保留。
- [ ] **C-1**：`toolRetryMiddleware` 放在 guardrails 数组首位，`tools: NETWORK_SENSITIVE_TOOLS`（web_read / schedule / update / cancel）；forge ErrorBudget 看到的 ToolMessage 是 retry 耗尽后的最终结果。
- [ ] **C-2**：`tokenCountMethod: 'approx'` 是真实配置字段并显式保留；`ContextEdit.apply` 用 `await params.countTokens(params.messages)` 自检阈值；budget 默认 7168（8192 ctx - 12% safety margin）。
- [ ] **D**：跨护栏集成测试三例齐全：(a) rescue → executedTools 累加；(b) TieredCompact 后 step_tracker / error_tracker 不丢；(c) HITL resume 后 workflow sticky 续跑。

---

## Risk Mitigations During Implementation

| 风险 | 触发条件 | 处理 |
|---|---|---|
| ~~LangChain v1 Command / RemoveMessage API 与本 plan 假设不一致~~ | ~~Phase 5 / 9 实现时~~ | ✅ 已在 plan 第二轮对齐：`jumpTo` 用对象形态、`Command` 用于 wrapToolCall state 更新、`RemoveMessage` 从 `@langchain/core/messages` 导入；全部有官方文档示例支撑（见 Plan Revision Notes） |
| LangChain `contextEditingMiddleware` trigger 行为与 forge 三阶段不严格对应 | Phase 8 测试 | 把 trigger 判定下沉到每个 ContextEdit 内部（plan 已设计如此）；显式设置 `tokenCountMethod: 'approx'`，让 contextEditingMiddleware 自动注入 countTokens |
| forge-guardrails state 与 deepagents 内置 state（filesystem、todo）字段冲突 | typecheck / runtime | 用 `forge_` 前缀命名，避免与 deepagents 既有字段重名 |
| ~~嵌套 middleware 的 wrapToolCall 顺序导致计数器丢更新~~ | ~~集成测试~~ | ✅ 已在 plan 第二轮统一为 `Command({ update: {...} })` 返回；通过 stateSchema 注册的 reducer 累加 |
| 跨 turn 过滤误删合法消息 | Phase 9 测试 | 单测覆盖：reasoning / respond_synthetic / tool_resolution / 正常 ToolMessage 都不被误删 |
| 现有 task / chat 测试因 workflowHint 默认值变化而回归 | Phase 4 / 7 集成 | workflowHint 默认 null，所有现有调用点不带 hint = 无 workflow = 无 step enforcement；保证非 propose 路径行为零变化 |
| propose 拆三步后用户 UI 体验变化（看到三个工具卡而非一个） | Phase 11 手动验证 | UI 渲染保留各工具卡，但展示得当（"草稿"、"落地"、"完成"的语义清楚）；若 UX 不可接受，回退 Phase 3 设计，问用户重新决策 |
| LangGraph SQLite checkpoint 体积膨胀（nudge 持久化）| 长时运行 | `ForgeCleanupMiddleware.afterAgent` 清理 + 跨 turn 过滤双保险（Phase 9 已设计） |
| 既有 `buildTaskProposalPrompt` 调用点遗漏改造 | Phase 4 集成 | grep `buildTaskProposalPrompt` 找全所有调用点；保留兼容但用 `@deprecated` 标注、写 CHANGELOG |
| 网络瞬时错误占用 forge error budget | Phase 6 集成 | ✅ 已用官方 `toolRetryMiddleware` 在 guardrails 数组首位吸收（NETWORK_SENSITIVE_TOOLS）；forge ErrorBudget 看到的是 retry 后结果 |
| iterationIndex 标签丢失导致 TieredCompact 不压缩 | Phase 8 运行时 | findEligibleEnd 退化为 `PROTECTED_HEADER_COUNT`（fail-safe，不压缩好过误压缩）；单测覆盖"无标签 messages"情况 |
| Resume 时 beforeAgent 覆盖 checkpoint requiredSteps | Phase 4 / 7 集成 | ✅ 已用 sticky 写法（`if (existing.requiredSteps.length > 0) return undefined`）；专项测试覆盖（B-2 回归） |

---

## Out of Plan

- forge 26 场景 eval harness、ablation 评测——明确不做。本批每个 middleware 工厂未对外暴露 `enabled` 参数，将来若要补 ablation 需追加 API。
- vLLM Provider、Llamafile prompt-injected fallback——明确不做。
- SlotWorker（GPU 抢占）——后期增项。
- `BudgetMode` 自动 VRAM 探测——`contextBudgetTokens` 由用户 Provider 配置；后期补。
- `cache_control` 保留——deepagents 已有等价物。
- `buildTaskProposalPrompt` 彻底删除——后期 plan 决定。
- LangSmith trace / evaluator 接入——本批不做，Roc 已用 SQLite task event 承载审计；若后期需要远程可观测性再开 spec。
- 真实 Qwen3 GGUF 端到端 e2e harness——本批 smoke 用 mock 模型脚本；真实模型回归测试列为后期增项。
- `modelRetryMiddleware` / `modelFallbackMiddleware`（模型层 retry / 降级）——本批仅用 `toolRetryMiddleware`；模型层 retry 可后续追加。

任何超出本 plan 范围的需求，需另开 spec/plan。
