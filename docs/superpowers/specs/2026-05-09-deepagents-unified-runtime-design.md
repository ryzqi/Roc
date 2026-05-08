# DeepAgents 统一运行时与固定 NVIDIA Provider 设计

## 1. 目标

将当前 Roc 的聊天与任务执行链统一重构为 `Deep Agents + LangChain` 运行时，并删除旧的同步 provider 执行实现。

本次设计同时要求：

- 模型提供商底层尽量复用 LangChain 生态现成包。
- 普通聊天与 task 模式都统一走 Deep Agents。
- main / preload / renderer 全链路支持流式事件与流式渲染。
- 设置页左侧新增固定 `NVIDIA` provider，endpoint 固定，用户只输入 API Key、模型 ID 和 NVIDIA 专项设置。
- 完成后删除旧实现、更新测试、重新打包并做 fresh smoke。

## 2. 当前状态

当前仓库的执行与设置链是分裂的：

- `src/main/services/chat-service.ts` 负责处理 `chat.submit`。
- `src/main/services/provider-runtime-service.ts` 直接用 `fetch` 执行 OpenAI-compatible / Anthropic-compatible 请求。
- `src/main/services/agent-service.ts` 当前只做 Deep Agents capability preview，不执行实际 run。
- `src/shared/ipc.ts` 与 `src/preload/index.ts` 只暴露一次性 `chat.submit()`，没有 chat run 流式事件协议。
- `src/renderer/App.tsx` 的 `ChatView` 只在请求结束后展示整包 `chatResult`，没有 token 级别的流式 UI。
- 设置页当前只允许编辑 `openai_compatible` 与 `anthropic_compatible` 草稿；`NVIDIA` 不是固定 provider。

这与本次目标直接冲突：执行层仍是自写 transport，Deep Agents 没有承担真正运行，前端也没有流式渲染主链。

## 3. 设计边界

### 3.1 在做范围

- 删除旧的 provider 同步执行主链。
- 引入统一的 LangChain 模型工厂。
- 让 `chat` 与 `task` 模式都通过 Deep Agents 流式执行。
- 新增 main -> preload -> renderer 的 chat run 流式事件协议。
- 重构聊天 UI 支持增量输出、运行状态、失败状态、完成状态。
- 重构设置页 provider 区，加入固定 `NVIDIA` provider。
- 根据最新官方文档更新依赖版本与测试。

### 3.2 不做范围

- 不引入 provider 插件系统。
- 不自动拉取 NVIDIA 模型列表。
- 不保留旧 `chat.submit` 或旧 `providerRuntimeService.executeChat` 作为 fallback。
- 不新增“兼容旧结果”的 renderer 双轨渲染。
- 不顺带重构无关工作台或页面。

## 4. 外部事实约束

以下事实来自当前回合核验过的官方文档与实测：

- LangChain JavaScript 官方支持 `ChatOpenAI` 通过自定义 `baseURL` 连接 OpenAI-compatible 端点。
- `ChatOpenAI` 支持流式输出。
- 最新 `@langchain/openai` 已能保留 `reasoning_content` 到 `AIMessage.additional_kwargs`。
- 实测 NVIDIA `https://integrate.api.nvidia.com/v1/chat/completions` 可通过 `ChatOpenAI` 访问。
- 实测 `modelKwargs.chat_template_kwargs.thinking=true` 能透传到 NVIDIA，并返回 `reasoning_content`。
- 当前仓库的 `deepagents` 版本落后于 npm 最新版，因此实现时需要同步升级 LangChain / Deep Agents 相关包到受支持的最新组合。

这些事实决定了本次实现不需要自写 NVIDIA SDK，也不应该继续保留 fetch transport 作为主执行层。

## 5. 核心设计决定

### 5.1 执行层唯一入口

执行层统一改为：

`Provider Config -> LangChain Model Factory -> DeepAgent Runtime -> Stream Event Bus -> Renderer`

含义如下：

- 所有模型实例都从统一模型工厂构建。
- 普通聊天也不再直接调用 provider；而是走一个“最小能力 Deep Agent”。
- task 模式与 chat 模式共用同一套 run 结构、流式事件、错误模型和前端渲染协议。

### 5.2 Provider 接入策略

Provider 配置层仍由现有 settings/config/secret 体系持久化，但执行时不再读取为“自写 HTTP transport 配置”，而是读取为“LangChain model 构造参数”。

最终 provider 类型收敛为：

- `openai_compatible`
- `anthropic_compatible`
- `nvidia`

其中：

- `openai_compatible` -> `ChatOpenAI`
- `anthropic_compatible` -> `ChatAnthropic`
- `nvidia` -> `ChatOpenAI`

`nvidia` 的固定执行参数：

- `baseURL = https://integrate.api.nvidia.com/v1`
- 用户手填 `model id`
- API Key 通过现有 secret service 存储
- NVIDIA 专项设置通过 `modelKwargs` 与构造参数映射到 LangChain

### 5.3 旧实现删除策略

以下旧路径不再保留主执行职责：

- `provider-runtime-service.ts` 中当前直接 `fetch` provider 的聊天实现
- `chat-service.ts` 中当前一次性返回 `ChatSubmitResult` 的同步提交模式
- renderer 中依赖 `state.chatResult` 整包落地的聊天展示逻辑

允许保留的只有：

- provider 测试、secret 管理、default model 解析、settings snapshot 读取等配置层能力

如果旧文件中“执行层”和“配置层”耦合在一起，应拆出配置层保留，执行层删除。

## 6. 运行时架构

### 6.1 新的模型工厂

新增一个明确职责的 LangChain 模型工厂服务，负责：

- 读取默认 provider / 默认模型
- 解密 provider secret
- 按 provider 类型构造 `ChatOpenAI` / `ChatAnthropic`
- 映射通用参数：
  - `temperature`
  - `maxTokens`
  - `streaming`
- 映射 NVIDIA 专项参数：
  - `chat_template_kwargs.thinking`

模型工厂不负责 run 生命周期，只负责返回可执行的 `BaseChatModel`。

### 6.2 新的 Deep Agent Runtime Service

新增一个独立的 runtime service，负责：

- 用模型工厂创建默认模型实例
- 按 `chat` / `task` 模式装配 Deep Agent
- 将 enabled capabilities 映射为 Deep Agents 可见的 tools / skills / subagents 边界
- 启动流式 run
- 把底层 chunk / event 转成 Roc 自己的 stream event
- 记录 task snapshot / task events / capability manifest

普通聊天与 task 的差异不再体现在“是否走 Deep Agents”，而体现在：

- `chat`：最小工作流、最小能力集、以回答为主
- `task`：保留现有任务表面和事件记录，允许更完整的能力集

### 6.3 taskService 的角色

`taskService` 保留数据库与任务表面职责：

- 线程
- run
- 事件
- background task
- capability manifest

但 taskService 不再假设结果只能在 run 结束时一次性写入，而要支持：

- run started
- token / reasoning / tool / todo / subagent progress
- run completed
- run failed

必要时为流式 run 增加新的事件类型与快照字段。

## 7. 流式 IPC 与事件协议

### 7.1 设计原则

当前 `roc:tasks:updated` 只是“有更新请整包刷新”的通知，不适合作为聊天主链路。新的 chat run 需要独立的流式事件协议。

新协议必须满足：

- main 可逐条推送事件
- renderer 可订阅与取消订阅
- quick / tray / main window 可共享广播机制
- 同一 run 有稳定 `runId`
- 事件可区分 chat / task

### 7.2 事件模型

新增 `chat run` 级别的事件类型，最少包括：

- `run_started`
- `message_delta`
- `reasoning_delta`
- `tool_event`
- `todo_event`
- `subagent_event`
- `run_completed`
- `run_failed`

其中：

- `message_delta` 用于最终用户可见文本流式渲染
- `reasoning_delta` 用于 NVIDIA thinking / reasoning_content 的专项呈现
- `run_completed` 给出最终摘要、duration、providerId、modelId
- `run_failed` 给出安全可展示错误

### 7.3 IPC 形态

保留命令式“启动 run”的 IPC，但把结果从“一次性返回整包”改成“两段式”：

1. `chat.startRun(request)` 返回 `runId` 与初始元信息
2. renderer 通过 `chat.onRunEvent(callback)` 订阅流式事件

必要时提供：

- `chat.cancelRun(runId)`
- `chat.getRunState(runId)` 仅用于恢复或诊断

## 8. 前端渲染设计

### 8.1 聊天主视图

`ChatView` 改为真正的消息流视图，而不是“空画布 + 一次性结果面板”。

核心状态应包含：

- 当前输入框状态
- 当前活动 run
- 逐步累积的 assistant message
- reasoning 展开区
- tool/todo/subagent 事件轨迹
- 失败提示

### 8.2 渲染策略

流式渲染必须：

- 每次收到 `message_delta` 立即更新 assistant 气泡
- 每次收到 `reasoning_delta` 更新 reasoning 面板
- run 完成后固化为最终消息
- run 失败时保留已收到内容并展示错误

不再依赖旧的 `state.chatResult` 整包显示。

### 8.3 task 视图

task 模式仍保留 task snapshot / history / capability manifest 等现有表面，但应与 chat 主链共用同一个流式运行时。

也就是说：

- task 运行的事件既落数据库，也驱动当前前端的增量显示
- `roc:tasks:updated` 继续作为任务表面刷新通知存在
- chat 主面板自己的流式订阅不依赖任务快照轮询

## 9. 固定 NVIDIA Provider 设计

### 9.1 左侧列表

设置页 provider 列表左侧新增一个固定项：

- 名称：`NVIDIA`
- 始终存在
- 不可删除
- 不通过 “Add Custom Provider” 创建

视觉方向参考 `image.png`，但遵守现有设置页结构与样式体系。

### 9.2 详情表单

固定 NVIDIA provider 的编辑表单应包含：

- `API Key`
- `模型 ID`
- `启用开关`
- `thinking` 开关
- `temperature`
- `max tokens`

不包含：

- endpoint 编辑框
- provider name 编辑框
- provider type 切换

endpoint 固定写死为 `https://integrate.api.nvidia.com/v1`。

### 9.3 数据模型

NVIDIA provider 仍进入统一 provider 配置持久化，但其结构有额外专用字段用于构造 `modelKwargs`。

这意味着 settings model / shared types / config schema 需要从“仅通用 provider 模型”扩展为“通用字段 + provider-specific options”。

## 10. 测试与验证设计

### 10.1 单元测试

重点覆盖：

- 模型工厂对三种 provider 的构造
- NVIDIA `thinking` 参数透传
- streaming event 映射
- renderer 流式状态归并
- settings model 对固定 NVIDIA provider 的草稿与保存

### 10.2 集成测试

重点覆盖：

- chat run 启动后收到增量事件
- task run 记录 task events 与完成态
- settings 保存 NVIDIA 后可用于默认模型执行

### 10.3 smoke

smoke 需要更新为验证：

- 设置页存在固定 NVIDIA provider
- 可录入 NVIDIA API Key 与模型 ID
- chat UI 可见流式输出，而不是只在结束后一次性展示
- packaged fresh build 下依旧可运行

## 11. 风险与控制

### 11.1 依赖升级风险

LangChain / Deep Agents 升级后可能带来类型或 runtime 变动。

控制方式：

- 只升级与本任务直接相关的包
- 每个里程碑后跑最小相关测试

### 11.2 事件模型复杂化

如果一次性引入过多前端事件类型，可能让 renderer 改造失控。

控制方式：

- 先定义一套最小但完整的事件协议
- 仅为当前 UI 真正展示的内容建模

### 11.3 旧实现删除导致回归

删除旧同步链会影响现有测试、smoke 和状态装配。

控制方式：

- 每个里程碑单独提交
- 以 TDD 方式逐步替换
- 在最后阶段做 build、package、packaged smoke

## 12. 里程碑

### 里程碑 1

统一运行时与模型工厂落地，旧同步执行主链删除。

### 里程碑 2

流式 IPC、main 广播、preload 订阅、renderer 流式消息渲染落地。

### 里程碑 3

固定 NVIDIA provider 与设置页专项配置落地。

### 里程碑 4

清理旧代码、更新测试、重新打包并完成 packaged smoke。

## 13. 验收标准

完成后必须满足：

1. 普通聊天与 task 都不再走旧 `providerRuntimeService.executeChat` 主链。
2. 默认模型实例来自 LangChain 生态包，而不是仓库自写 HTTP transport。
3. 前端聊天界面支持真实流式渲染。
4. 设置页左侧始终存在固定 `NVIDIA` provider。
5. NVIDIA endpoint 固定，用户手填 API Key 与模型 ID。
6. NVIDIA `thinking` 可配置，并能把 reasoning 流到前端。
7. 旧执行实现与无用路径被删除。
8. 相关测试、build、package、packaged smoke 通过。
