# DeepAgents 子代理重构设计

## 目标

重构 Roc 的子代理设计，使 DeepAgents 成为唯一的 agent harness 和子代理执行来源。Roc 不再实现第二套子代理 runtime，而是负责：

- 配置 DeepAgents `createDeepAgent()`
- 编译 Roc 内置和声明式子代理定义
- 校验工具、权限、能力和运行边界
- 全量消费 DeepAgents 流式输出
- 投影、持久化和回放结构化子代理事件
- 在 chat 和 task workbench 中展示一致的子代理执行树

这次重构接受大范围破坏性变更。不保留旧 `subagent_started` / `subagent_completed` 兼容路径，不迁移旧子代理事件展示，不保留双写或兼容壳。

## 权威来源

- 当前仓库安装的 `deepagents` 1.10.2 类型声明：`node_modules/deepagents/dist/index.d.ts`，尤其是 `CreateDeepAgentParams`、`AnySubAgent`、`SubAgent`、`CompiledSubAgent`、`AsyncSubAgent`、`AsyncTaskStatus`、`SubagentRunStream`、`DeepAgentRunStream` 和 `streamEvents(..., { version: 'v3' })` 的运行形态。
- DeepAgents JavaScript 官方文档：
  - https://docs.langchain.com/oss/javascript/deepagents/subagents
  - https://docs.langchain.com/oss/javascript/deepagents/async-subagents
- 当前 package 事实：`deepagents` 1.10.2、`@langchain/langgraph` 1.3.2、`zod` 4.4.3。
- 当前 Roc 执行链路：
  - `src/main/services/deep-agent/agent-builder.ts`
  - `src/main/plugins/agent/deep-agent-executor.ts`
  - `src/main/services/deep-agent/stream-consumers.ts`
  - `src/shared/types/chat.ts`
  - `src/shared/types/task.ts`
  - `src/renderer/chat-transcript.ts`

## 已验证的 DeepAgents 1.10.2 合同

- `createDeepAgent()` 是 batteries-included harness，默认装配 planning、filesystem、subagents、summarization 等标准 middleware；Roc 应配置这些能力，而不是重写 harness。
- `CreateDeepAgentParams.subagents` 接受同一个数组里的 `SubAgent`、`CompiledSubAgent` 和 `AsyncSubAgent`；`AsyncSubAgent` 通过 `graphId` 字段在运行时被识别并接入 async SubAgent middleware。
- `general-purpose` 子代理默认启用，拥有主代理全部 tools，并在主代理配置 skills 时继承主代理 skills；自定义子代理默认不继承主代理 skills，必须显式配置 `skills`。
- `SubagentRunStream` 当前字段是 `name`、`taskInput: Promise<string>`、`output: Promise<TOutput>`、`messages`、`toolCalls`、`subagents`。Roc 投影层必须递归消费这些字段，不能只等待 `output`。
- `DeepAgent.streamEvents(..., { version: 'v3' })` 返回 projection-oriented `DeepAgentRunStream`，包含 `run.messages`、`run.toolCalls`、`run.subagents`，但类型声明标记 v3 stream 为 experimental，后续 DeepAgents 升级必须先跑 contract guard。
- `AsyncTaskStatus` 当前为 `'pending' | 'running' | 'success' | 'error' | 'cancelled' | 'timeout' | 'interrupted'`。DeepAgents async task state 存在 `asyncTasks` state channel，`taskId` 与远端 `threadId` 相同。
- DeepAgents async task 工具名是 `start_async_task`、`check_async_task`、`update_async_task`、`cancel_async_task`、`list_async_tasks`。Roc 子代理名不得与这些工具名冲突。
- DeepAgents filesystem permissions 只覆盖 `ls`、`read_file`、`write_file`、`edit_file`、`glob`、`grep`，不覆盖 `execute`。Roc 当前通过 `RocNonExecutingCompositeBackend` 不向 DeepAgents backend 暴露 `execute`，shell 只走 Roc-owned `run_shell_command` / `shell.execute` guard；重构不得把 DeepAgents 原生 `execute` 暴露成绕过点。

## 当前状态

Roc 已经通过 `buildDeepAgent()` 调用 `createDeepAgent()`，并传入 `memory`、`skills`、`subagents`、`tools`、`permissions`、`interruptOn`、`checkpointer` 和 Roc 自有 guardrail middleware。

当前问题集中在子代理投影层：

- `createRunSubagents()` 只注册 `code-review` 和 `research` 两个同步子代理。
- `executeDeepAgentRun()` 使用 `agent.streamEvents(..., { version: 'v3' })`，但只把 `run.subagents` 当成 started/completed 事件源。
- `consumeSubagentStream()` 只读取 `name`、`taskInput` 和最终 `output`，没有递归消费 `subagent.messages`、`subagent.toolCalls`、`subagent.subagents`。
- `ChatRunEvent.subagent_event` 是扁平结构，只包含 `subagent`、`status`、`summary`。
- `TaskEvent` 仍有旧的 `subagent_started` 和 `subagent_completed` 类型。
- 任务详情和 chat transcript 只能展示简单子代理块，不能表达子代理内部 transcript、工具调用、嵌套子代理、异步状态、失败 partial transcript 或取消语义。
- `src/main/services/deep-agent/types.ts` 的 `DEEP_AGENT_BUILT_IN_TOOLS` 没有包含 DeepAgents 原生 `execute`，这符合 Roc shell 边界；但注释仍写“文件系统 7 件”，需要在实施时改成明确的 Roc allowlist，并用 contract test 防止漂移。

## 设计决策

- 采用 DeepAgents-first / harness-first 方案。
- `createDeepAgent()` 是唯一执行来源；Roc 不创建第二套 owner workflow、scheduler 子代理 runtime 或 agent team runtime。
- 使用 DeepAgents 内置 `general-purpose` 子代理能力，并允许 Roc 增加内置子代理和声明式子代理定义。
- 尽可能使用 DeepAgents 原生 `SubAgent`、`CompiledSubAgent` 和 `AsyncSubAgent` 能力。
- 全面使用流式：主代理、同步子代理、嵌套子代理、工具调用、文本块、reasoning、异步状态都必须以流式事件投影；不能等最终 `output` 后才一次性补事件。
- 继续使用 `streamEvents(..., { version: 'v3' })`，但把它视为实验性合同：实施前和 DeepAgents 升级后必须用本地 contract test 验证字段仍存在。
- 同步子代理是一次性委托，不伪装成可恢复后台任务。
- DeepAgents `AsyncSubAgent` 是单次 run 内部的异步委托，Roc 背景任务是 top-level durable scheduled task，两者不能合并。
- 子代理权限和工具边界由 Roc 校验后再交给 DeepAgents；不能靠 prompt 文案保证。
- `execute` 边界不交给 DeepAgents filesystem permissions；Roc backend 继续不暴露 `execute`，命令执行只通过 `run_shell_command` 工具和 `createRocShellPathPolicyMiddleware()` / `ShellExecutionService` 双层校验。
- 删除旧事件类型、旧 parser、旧 UI 分支、旧测试夹具和旧 mapper，不保留兼容。

## 架构边界

### DeepAgents Harness

`buildDeepAgent()` 继续负责装配 DeepAgents：

- model
- system prompt
- Roc backend
- Store
- memory sources
- skill sources
- subagents
- tools
- filesystem permissions
- interrupt policy
- checkpointer
- Roc guardrail middleware

Roc 可以调整传入的配置，但不重写 DeepAgents 的 task tool、SubAgentMiddleware、AsyncSubAgentMiddleware 或 Agent Protocol 语义。

Roc 也不能把 DeepAgents 原生 `execute` 当作普通 filesystem tool 暴露。DeepAgents 当前类型声明把 `execute` 列入 filesystem tool names，但 permissions 不管 `execute`；Roc 的权威命令执行路径仍是 `createRocWindowsCommandTool()` 暴露的 `run_shell_command`，再由 shell path policy 和 `ShellExecutionService` 拒绝 `/workspace/...`、Linux 本地路径和越界 cwd。

### Roc Projection Layer

新增或重构一个子代理投影层，职责是把 DeepAgents stream run 结构映射成 Roc 统一事件：

- 消费 `run.subagents`
- 对每个 `SubagentRunStream` 递归消费：
  - `messages`
  - `toolCalls`
  - `subagents`
  - `output`
- 为每个子代理分配 Roc projection id
- 维护 parent/child 关系、depth、path、sequence
- 将事件发送给 runtime event queue
- 将事件写入 task event store
- 保留 partial transcript，即使后续 `output` 或子流失败

Roc projection id 不是 DeepAgents 执行 identity。同步子代理如果没有稳定 call id，使用 `runId + parent path + ordinal` 生成同一次 run 内稳定的 id。AsyncSubAgent 优先使用 DeepAgents async task state 中的 `taskId`。

## 事件模型

在共享类型中新增结构化身份和事件 payload：

```ts
type SubagentIdentity = {
  subagentId: string;
  parentSubagentId: string | null;
  name: string;
  depth: number;
  path: string[];
  execution: 'sync' | 'async';
  taskInput: string | null;
  asyncTaskId?: string;
};

type SubagentEventPayload =
  | { kind: 'started' }
  | { kind: 'assistant_block'; block: ChatAssistantBlock }
  | { kind: 'tool_call'; block: Extract<ChatAssistantBlock, { kind: 'tool_call' }> }
  | { kind: 'async_status'; status: AsyncTaskStatus; checkedAt?: string }
  | { kind: 'completed'; summary: string | null }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled'; reason?: string };
```

`ChatRunEvent` 使用统一结构：

```ts
type ChatRunEvent =
  | ExistingRunEvents
  | {
      type: 'subagent_event';
      runId: string;
      sequence: number;
      identity: SubagentIdentity;
      event: SubagentEventPayload;
    };
```

`TaskEvent.type` 增加并只保留新主路径：

```ts
type TaskEventType = ExistingTaskEventTypesWithoutOldSubagentEvents | 'subagent_event';
```

必须删除旧 `subagent_started` 和 `subagent_completed`。新实现只写 `subagent_event`，UI 只读 `subagent_event`。旧历史任务中的旧子代理事件不再保证展示。

持久化到 task event store 时，`payload` 保存同一结构化 envelope 的 `{ sequence, identity, event }`。数据库映射出的 `TaskEvent.sequence` 仍可继续表示 rowid/插入顺序，用作相同 `createdAt` 下的最终排序兜底；它不能替代投影层生成的 run-local `sequence`。

## 子代理定义和权限

Roc 子代理定义分三类：

- DeepAgents 内置 `general-purpose`：默认保留，继承主代理工具和配置。
- Roc 内置同步子代理：例如 `code-review`、`research`，编译成 DeepAgents `SubAgent`。
- Roc 声明式子代理：可在后续实现中从受控配置编译成 `SubAgent` 或 `AsyncSubAgent`。

声明式定义需要先经过 Roc 校验：

- `name` 必须唯一，不能与 DeepAgents built-in async task tool 名称冲突。
- `description` 必须具体，供主代理选择子代理。
- `systemPrompt` 只定义角色和工作方式，不能绕过 Roc 权限边界。
- `tools` 只能引用当前 run 已启用能力中的工具。
- `skills` 必须显式声明；自定义子代理不默认继承主代理 skills。
- `permissions` 只能收窄，不能扩大 `createRocFilesystemPermissions()`；这条只覆盖文件工具，不覆盖命令执行。
- 子代理不能直接获得 DeepAgents 原生 `execute`；需要 shell 时只能使用 Roc `run_shell_command`，并继承相同 Windows cwd 与 `/workspace` 拒绝规则。
- `interruptOn` 只能在 Roc 允许的 tool review policy 内配置。
- `model` 若支持覆盖，必须经过 Roc 模型能力和成本策略校验。

权限校验失败必须在构建 agent 前报清晰错误，不能创建运行后再依赖模型自我约束。

## AsyncSubAgent 和背景任务边界

DeepAgents `AsyncSubAgent` 通过 `graphId` 识别，接入 Agent Protocol server，并暴露 async task 工具：

- `start_async_task`
- `check_async_task`
- `update_async_task`
- `cancel_async_task`
- `list_async_tasks`

Roc 背景任务不是 AsyncSubAgent：

- Roc 背景任务是顶层 durable scheduled task，有 task thread、scheduler、trigger、workspace、enabled capabilities、confirmation policy。
- DeepAgents AsyncSubAgent 是一次 run 内的内部委托，由主代理通过 async task 工具启动、查询、更新和取消。
- AsyncSubAgent 的运行状态属于当前 DeepAgents thread/checkpointer state，并写入 `asyncTasks` state channel；如果需要 Roc 重启后可靠恢复，必须使用持久 checkpointer。`MemorySaver` 只能承诺进程内状态。
- AsyncSubAgent 的 `taskId` 与远端 Agent Protocol `threadId` 相同；Roc UI 可以保存该 id 作为 async status handle，但不能把它当成本地 `TaskRun.id` 或 `BackgroundTask.id`。

UI 和事件 payload 必须区分：

- `execution: 'sync'` 的一次性子代理
- `execution: 'async'` 的 Agent Protocol 异步子代理
- Roc 顶层 background task run

不能把同步子代理伪装成可恢复任务，也不能把 Roc scheduler 事件写成 DeepAgents AsyncSubAgent 状态。

## UI 展示和错误处理

UI 以同一个投影模型支持正常 chat 和 task workbench：

- 正常 chat 从 runtime stream 更新。
- task detail 从持久化 `TaskEvent.type = 'subagent_event'` 回放。

主 assistant transcript 保持清晰，只展示主代理输出、reasoning、工具调用和最终结论。子代理展示为 activity block 或侧栏树：

- 默认折叠。
- 展开后显示该子代理自己的 assistant blocks、tool calls、nested subagents 和最终 summary。
- 支持跳转到正在运行的子代理。
- 支持查看完整子代理 transcript。
- AsyncSubAgent 支持刷新状态和取消 async run。

状态显示覆盖：

- running / started
- streaming assistant output
- tool running / tool failed
- async waiting / async status-only
- completed
- failed
- cancelled

错误处理规则：

- 子代理 stream 失败时写入 `failed`，并保留已流出的 partial transcript。
- `output` 读取失败不能抹掉已经投影的 child messages、tool calls 或 nested subagents。
- 工具失败、权限拒绝、深度限制、并发限制和配置校验失败都必须在对应子代理节点中可见。
- AsyncSubAgent 如果只能拿到状态而拿不到内部 transcript，UI 明确显示为状态型异步子任务，不假装有完整明细。
- 取消语义要区分 Roc 本地 run cancel 和 Agent Protocol async run cancel。

## 流式消费要求

实现阶段必须把子代理流式消费提升为第一类路径：

- `run.messages`、`run.toolCalls`、`run.subagents` 并发消费。
- 每个 `SubagentRunStream.messages`、`toolCalls`、`subagents` 递归消费。
- 不以 `await subagent.output` 作为 started/completed 之间的唯一工作。
- 所有 emitted `subagent_event` 带同一个 run 内单调递增的 `sequence`，确保并发流最终能稳定回放；task event payload 也保存该 `sequence`，不只依赖相同 `createdAt` 下的数据库插入顺序。
- 深层子代理按 depth/path 归档，避免 UI 只能看见第一层。
- runtime event 和 task event 使用同一 envelope，避免 task workbench 和 chat 语义漂移。

如果 DeepAgents 后续要求通过 `agent.stream(..., { subgraphs: true })` 才能拿到更完整 namespace，实施计划中可以评估切换；但默认先基于当前 Roc 已用的 `streamEvents(..., { version: 'v3' })` 和 `run.subagents` 扩展。

## 迁移和清理

本次不做兼容迁移。实施时直接全量切换：

- 删除旧 `ChatRunEvent.subagent_event` 扁平字段。
- 删除旧 `TaskEvent.type` 中的 `subagent_started` 和 `subagent_completed`。
- 删除旧 `SubagentPayload` parser。
- 删除旧 transcript 中只按 name/status/summary 渲染的子代理 block 分支。
- 删除旧 repository mapper 中对子代理 started/completed 的特殊处理。
- 删除旧测试夹具、helper 和断言。
- 删除任何双写、fallback read、legacy adapter 或 compatibility branch。
- 修正或删除 `DEEP_AGENT_BUILT_IN_TOOLS` 旧注释中与 DeepAgents 1.10.2 不一致的“文件系统 7 件”说法；保留 Roc allowlist 中排除 `execute` 的事实，并用测试说明原因。

已有历史任务中的旧子代理事件不再保证展示。普通 message、assistant block、tool call、approval、background task 事件不应受影响。

## 实施分期

### 阶段 1：共享契约

- 新增 DeepAgents 1.10.2 contract guard，锁定 `AnySubAgent`、`AsyncSubAgent`、`SubagentRunStream`、v3 stream 投影和 Roc 不暴露 `execute` 的边界。
- 新增 `SubagentIdentity` 和 `SubagentEventPayload`。
- 更新 `ChatRunEvent`。
- 更新 `TaskEvent`。
- 删除旧子代理事件类型。
- 更新 IPC 生成代码和 schema 校验。

### 阶段 2：DeepAgents 流投影

- 重构 `consumeSubagentStream()` 或拆出新的 projection module。
- 递归消费子代理 messages、tool calls、nested subagents 和 output。
- 生成稳定 projection id、parent id、depth、path、sequence。
- 保留 partial transcript 和失败事件。

### 阶段 3：持久化和 UI

- task run 只写新 `subagent_event`。
- chat transcript 只读新 envelope。
- task detail 从持久化事件重建子代理树。
- UI 支持折叠、展开、运行中状态、失败 partial transcript、取消和 async 状态。

### 阶段 4：AsyncSubAgent 接入

- 扩展 Roc 子代理定义编译器，支持 `AsyncSubAgent`。
- 校验 `graphId`、url、headers、能力和权限。
- 投影 `start_async_task`、`check_async_task`、`update_async_task`、`cancel_async_task`、`list_async_tasks` 相关状态。
- 如果要支持 Roc 重启后继续追踪 async task，替换 `MemorySaver` 为持久 checkpointer。

### 阶段 5：清理和验证

- 扫描旧事件、旧 parser、旧 UI 分支、旧 mapper、旧测试 helper。
- 运行 strict unused scan。
- 跑目标测试、typecheck、IPC 检查和全量测试。

## 测试策略

### 投影单元测试

覆盖：

- 同步子代理 started -> assistant block -> tool call -> completed。
- 子代理内部 tool call start/end/error。
- 嵌套子代理 parent/child/depth/path。
- 所有子代理事件携带 run 内单调递增 `sequence`。
- `output` 读取失败时保留已消费事件并写 failed。
- 子代理 stream 抛错时保留 partial transcript。
- 无稳定 call id 时 projection id 在同一次 run 中稳定。
- AsyncSubAgent 状态事件投影。
- 取消事件区分 local cancel 和 async cancel。

### 持久化和回放测试

覆盖：

- task run 只写 `subagent_event`。
- task detail 从新事件重建子代理树。
- 旧 `subagent_started` / `subagent_completed` 不再出现在 shared type、mapper、fixtures 和新写入路径。
- 相同 `createdAt` 下仍按 `TaskEvent.sequence` 稳定排序。
- DeepAgents 原生 `execute` 不出现在 Roc capability preview 的 built-in allowlist；shell 仍只通过 `run_shell_command`。

### Renderer 测试

覆盖：

- chat transcript 渲染子代理树。
- task detail 回放子代理树。
- 默认折叠和展开明细。
- 子代理失败 partial transcript 可见。
- AsyncSubAgent status-only 展示清晰。
- 取消和刷新动作只在 async 子任务上出现。

### 端到端验收

覆盖：

- 普通 chat 和 task workbench 复用同一个 DeepAgents harness。
- 同步子代理是一次性委托。
- AsyncSubAgent 显示 Agent Protocol 异步任务语义。
- 权限拒绝、深度限制、并发限制都作为可见事件。
- Roc 背景任务仍是顶层 scheduled task，不被 AsyncSubAgent 替代。

推荐验证链路：

- 目标 Vitest
- `pnpm typecheck`
- `pnpm check:ipc`
- `pnpm test`
- `pnpm exec tsc --noEmit -p tsconfig.json --noUnusedLocals --noUnusedParameters`
- `git diff --check`

如实施改动触及 build-time IPC 或打包边界，再补 `pnpm build`。

## 风险

- DeepAgents 同步子代理流可能没有稳定 call id；Roc projection id 必须在同一次 run 和回放中稳定。
- 并发消费 messages、toolCalls、subagents 可能导致事件顺序漂移；投影层必须维护 sequence。
- `streamEvents(..., { version: 'v3' })` 在 DeepAgents 1.10.2 声明为 experimental；升级 DeepAgents 时 contract guard 必须先失败再按新 API 调整。
- AsyncSubAgent 可靠性取决于 checkpointer。`MemorySaver` 下不能承诺进程重启恢复。
- 全量删除旧兼容会影响历史任务中的旧子代理事件展示，这是本次设计接受的破坏性变化。
- 子代理工具和权限定义如果不先校验，可能绕开 Roc 当前 workspace、MCP、skill 和 shell guardrail 边界。
- 若实施中误把 DeepAgents 原生 `execute` 暴露给模型，filesystem permissions 不能拦截命令越界；这是必须由 contract test 阻止的安全回归。

## 不做事项

- 不实现第二套 Roc 子代理 runtime。
- 不保留旧 `subagent_started` / `subagent_completed` 兼容。
- 不迁移旧子代理历史事件。
- 不把同步子代理设计成可恢复任务。
- 不把 Roc 背景任务和 DeepAgents AsyncSubAgent 合并。
- 不通过 prompt 文案代替权限、路径、并发或深度限制。
- 不暴露 DeepAgents 原生 `execute`，不绕过 Roc `run_shell_command`。
- 不引入与当前请求无关的 agent team、planner 或 scheduler 抽象。

## 验收标准

设计被实现后，以下条件必须同时满足：

- DeepAgents `createDeepAgent()` 仍是唯一 agent harness。
- 主代理和所有子代理输出都以流式事件投影。
- 每个 `subagent_event` 都有 run 内单调 `sequence`。
- chat 和 task workbench 使用同一 `subagent_event` envelope。
- task event store 新写入路径不再出现旧子代理事件类型。
- UI 能展示同步、嵌套、失败、取消和 async 状态。
- 旧子代理类型、parser、mapper、UI 分支和测试夹具已删除。
- Roc backend 仍不暴露 DeepAgents `execute`；命令执行仍只走 `run_shell_command` 和 Windows path guard。
- 目标测试、typecheck、IPC 检查、全量测试和 strict unused scan 通过。
