# Forge Profile 与完成证据校验设计

## 背景

Agnes 测试暴露了 4 个问题：

1. Provider 测试只验证文本连通，不验证工具调用能力。
2. `docx` 创建必须通过 Deep Agents 内置 `write_file`、`edit_file` 或 `execute` 等工具真实执行，skill 只是只读说明源。
3. 当前 `response-validation` 允许“有 reasoning + 有可见文本 + 无 tool_calls”的回合通过，模型可以用“我来创建...”结束但没有执行。
4. reasoning-only 回合触发的空回复 nudge 属于内部纠偏，不应作为用户可见输出污染任务结果。

`docs/forge-analysis.md` 的核心原则适用于本修复：本地小模型要通过 `respond` 把“裸文本还是工具调用”的开放式抉择变成结构化选择；控制流状态不能依赖会被压缩的消息历史；失败要显式，不能静默替模型执行。

## 目标

- 区分本地模型和网络模型的 Forge 策略。
- 修复文件创建/修改类任务中“承诺执行但没有工具调用”的完成缺口。
- 保留 Provider 测试的现有语义：只做文本探活。
- 保留 reasoning-only nudge 的内部纠偏方向，避免用户可见区域重复显示护栏提示。

## 非目标

- 不把 Provider 测试升级为工具调用能力测试。
- 不在设置页新增“文本连通 / 工具调用可用”双状态。
- 不自动替模型创建文件或执行 fallback 命令。
- 不把 `respond` 默认扩展到所有网络模型。
- 不做与本问题无关的 UI 或文案重构。

## 架构设计

新增内部 `ForgeProfile` 决策层，集中描述不同 provider 的 Forge 行为。

`local` profile 用于 `llama_cpp`：

- 启用合成 `respond` 工具。
- `knownToolNames` 包含 `respond`。
- 目标是让本地模型始终在结构化 tool-calling 语法中做选择。

`remote` profile 用于 `openai_compatible`、`nvidia`、`openrouter`、`anthropic_compatible`：

- 默认不启用 `respond`。
- 保留供应商原生 tool calling。
- 用完成证据校验防止“无工具调用但文本收尾”的任务失败。

`agent-builder` 不再散落 `isLocalProvider` 判断，而是通过 `resolveForgeProfile(providerType)` 获得策略。该层只表达 Forge 行为，不参与 Provider 配置保存或 UI 展示。

## Provider 测试边界

`ProviderRuntimeService.testProvider` 保持文本探活：

- 继续使用文本 prompt。
- 继续使用 `tools_not_invoked=true` 的能力摘要。
- 不绑定测试工具。
- 不因 `supportsToolCalls=false` 直接判 Provider invalid。

Root Cause 1 的处理方式是明确边界：Provider 测试只说明 endpoint、凭据、模型文本响应可用；Agent 文件创建是否可靠由运行时 guardrails 保证。

## 完成证据校验

新增或扩展一个 guardrail，用于普通 Agent 文件 mutation 任务的完成判定。

触发范围：

- 当前用户输入表达文件创建或修改意图，例如创建文件、写入文件、生成报告、保存到当前目录、创建 `docx`。
- 或本轮已经调用过文件/命令 mutation 工具：`write_file`、`edit_file`、`delete_file`、`execute`。
- 初版只覆盖文件 mutation 任务，不扩展到所有任务类型。

允许完成的证据：

- 成功的 `write_file` 或 `edit_file`。
- 成功的 `execute` 后，出现后续 `ls`、`read_file` 或 `execute` 验证目标存在。
- 后台任务工作流继续以 `confirm_with_user` 为 terminal，不受普通文件证据规则误伤。

拦截条件：

- 最后一条 `AIMessage` 没有 `tool_calls`。
- 存在 visible text，但本轮没有满足上述完成证据。
- 无论该消息是否含 reasoning，都返回 retry nudge 并 `jumpTo: model`。
- reasoning-only retry nudge 标为 internal，不记录到用户可见任务输出。

错误边界：

- 多次只输出“我来创建...”时，由现有 error budget 停止运行。
- 最终错误应说明模型未给出合法工具调用或缺少文件操作证据。
- 不做静默 fallback，不让系统假装任务完成。

## 状态与数据流

完成证据不能从被压缩后的消息历史临时猜测。应把权威状态放在 Forge/LangGraph state tracker 中。

建议状态字段：

- `fileMutationIntent`: 本轮是否进入文件 mutation 任务。
- `fileMutationObserved`: 是否观察到成功的文件 mutation 工具。
- `fileVerificationObserved`: 是否观察到 mutation 后的验证工具。
- `fileMutationTargets`: 可选，记录涉及的目标路径，初版可弱化为审计信息，不作为强路径匹配前置条件。

数据流：

1. 用户输入进入 Agent。
2. Guardrail 从输入或工具轨迹标记 `fileMutationIntent`。
3. 工具执行成功后，state tracker 记录 mutation / verification 证据。
4. `response-validation` 或独立 completion guard 在模型最终文本前检查状态。
5. 缺少证据则注入 retry nudge；证据满足则允许文本完成。

该设计遵守 `docs/forge-analysis.md` 的 “Control Flow Is Not Memory”：消息历史可被压缩，完成判定不能随历史一起丢失。

## 测试设计

Forge profile：

- `llama_cpp` 解析为 `local`，启用 `respond`，`knownToolNames` 包含 `respond`。
- `openai_compatible`、`nvidia`、`openrouter`、`anthropic_compatible` 解析为 `remote`，不启用 `respond`。
- `agent-builder` 使用 profile，不再直接散落本地模型判断。

完成证据：

- 复现 Agnes/docx：`reasoning + "我来创建..." + no tool_calls`，且存在文件创建意图，应返回 retry nudge。
- 普通问答：`reasoning + "答案是42"`，无文件 mutation 意图，应允许完成。
- 文件任务：成功 `write_file` 后最终文本，应允许完成。
- `execute` 创建文件但无验证，应继续 nudge。
- `execute` 创建文件后有 `ls`、`read_file` 或 `execute` 验证，应允许完成。
- reasoning-only retry nudge 标 internal，不进入用户可见 task output。

Provider 测试：

- 断言 `testProvider` 仍是文本探活。
- 断言 capability summary 仍包含 `tools_not_invoked=true`。
- 不新增设置页双状态测试。

## 验收标准

- Agnes/docx 场景不再能用“我来创建...”无工具调用结束。
- 本地模型继续使用 `respond` 合成工具。
- 网络模型默认不注入 `respond`，但文件 mutation 完成必须有运行时证据。
- Provider 测试仍只代表文本连通。
- 相关单测通过，必要时 `pnpm typecheck` 通过。

## 风险与取舍

- 文件 mutation 意图识别过宽可能误拦普通问答。初版只覆盖明确文件创建/修改关键词和已发生 mutation 工具轨迹。
- `execute` 的副作用难以结构化识别，因此要求后续验证证据，避免把任意成功命令当作文件已创建。
- 大范围重构允许，但每个改动必须服务于 `ForgeProfile` 或完成证据校验，不做无关清理。
