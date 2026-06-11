# Provider 文本探活与 Forge 边界设计

## 背景

Agnes 测试暴露了 4 个事实：

1. Provider 测试只验证文本连通，不验证工具调用能力。
2. `docx` 创建必须通过 Deep Agents 内置 `write_file`、`edit_file` 或 `execute` 等工具真实执行，skill 只是只读说明源。
3. 当前运行中模型可能输出 reasoning 和承诺文本，但没有 `tool_calls`，因此后端没有收到创建文件动作。
4. 空回复 nudge 来自护栏纠偏文案，中间纠偏不应污染用户可见任务输出。

`docs/forge-analysis.md` 的原则仍作为边界参考：失败要显式，控制流不能依赖会被压缩的消息历史，不用静默 fallback 替模型完成工作。

## 目标

- 保留 Provider 测试的现有语义：只做文本探活。
- 明确 Provider 测试通过不等于 Agent 文件创建能力可用。
- 保留内部纠偏提示不进入用户可见输出的方向。
- 避免引入不符合当前决策的 Forge 运行时行为。

## 非目标

- 不把 Provider 测试升级为工具调用能力测试。
- 不在设置页新增“文本连通 / 工具调用可用”双状态。
- 不自动替模型创建文件或执行 fallback 命令。
- 不修改网络模型的原生 tool calling 行为。
- 不做与本问题无关的 UI 或文案重构。

## Provider 测试边界

`ProviderRuntimeService.testProvider` 保持文本探活：

- 继续使用文本 prompt。
- 继续使用 `tools_not_invoked=true` 的能力摘要。
- 不绑定测试工具。
- 不因 `supportsToolCalls=false` 直接判 Provider invalid。

Root Cause 1 的处理方式是明确边界：Provider 测试只说明 endpoint、凭据、模型文本响应可用；Agent 文件创建是否可靠不由 Provider 测试声明。

## Runtime 边界

文件创建类任务必须由模型发起真实工具调用。系统不能把“我来创建...”这种承诺文本解释成已执行动作。

当前 spec 不设计新的运行时完成规则。后续如果要修复“承诺执行但没有工具调用”的缺口，需要单独定义触发条件、状态来源、nudge 方式和测试范围。

reasoning-only 回合触发的 retry nudge 可以作为内部纠偏保留；该类 nudge 不应记录到用户可见任务输出中。

## 测试设计

Provider 测试：

- 断言 `testProvider` 仍是文本探活。
- 断言 capability summary 仍包含 `tools_not_invoked=true`。
- 不新增设置页双状态测试。

护栏输出：

- reasoning-only retry nudge 标 internal。
- internal nudge 不进入用户可见 task output。

## 验收标准

- Provider 测试仍只代表文本连通。
- Provider 测试不会触发或要求工具调用。
- 用户可见输出不显示 reasoning-only 的内部 retry nudge。
- 文档不再包含新增 Forge 运行时行为设计。

## 风险与取舍

- 该设计不直接修复“模型承诺创建但未调用工具”的运行时缺口。
- 后续修复该缺口时，需要另行选择运行时 guardrail 方案，并用回归测试覆盖 Agnes/docx 场景。
- 保持 Provider 测试为文本探活可以减少设置页语义变化，但不能作为 Agent 工具能力证明。
