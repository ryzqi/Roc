# Agent 最终响应合同

`chat.startRun` 接受可选的 `responseContract`，把明确的机器输出要求交给生产模型循环和任务验收。该输入随 task contract 冻结在 run snapshot 中，checkpoint 恢复使用同一合同。未提供合同的请求沿用原有响应验收。

## 显式输入

合同格式为 `{ format: "json", schema: ... }`。例如，可见材料提供 `p0`、`p1` 两个来源 ID 时：

```json
{
  "format": "json",
  "schema": {
    "type": "object",
    "properties": {
      "answer": { "type": "string", "minLength": 1 },
      "evidence": {
        "type": "array",
        "items": { "type": "string", "enum": ["p0", "p1"] },
        "uniqueItems": true
      }
    },
    "required": ["answer", "evidence"],
    "additionalProperties": false
  }
}
```

支持的 JSON Schema 子集包括 string、number、integer、boolean、null、递归 array 和 object；支持相应类型的枚举、上下界、数组唯一性和必填字段。object 必须声明 `properties`、`required` 和 `additionalProperties: false`。未知关键字、默认值、类型强制转换和冲突上下界被拒绝。

输入限制为最多 12 层嵌套、256 个 schema 节点和 65,536 个序列化字符。字段名最多 200 字符；枚举最多 4,096 项。合同中的来源 ID 必须来自任务可见输入；答案标注和独立评分规则留在评测端。

## 一次纠正与完成验收

主代理的 `afterModel` 检查最后一条无工具调用的 AI 消息。它对完整可见文本执行 `JSON.parse` 和 schema 校验，不提取 JSON、不删除说明或围栏，也不改写响应。工具轮次的过程叙述不触发该检查。

首次失败时，生产循环追加一条带简短错误原因的反馈，并请求模型返回完整修正值。纠正机会每个 run 最多一次；计数和 run ID 写入 checkpoint，重启不能补充机会。同一 thread 的后续新 run 可以获得自己的一次纠正。该模型调用走原有用量、取消、传输和持久化链路。

纠正后仍失败时，保留模型原始回答并结束生成。run 可以为 `completed`，响应验收项为 `failed`，任务验收不会成为 `satisfied`。自定义工件验收全部通过也不能绕过响应合同；缺少显式响应验收项时，验收报告补充独立的 JSON 响应项。

executor 分别传递终轮 `finalResponse` 和聚合会话 `finalMessage`。响应合同只验终轮文本；缺失终轮文本时失败，不能使用聚合叙述代替。原始过程、失败回答、反馈、模型用量和最终 checkpoint 都保留。验收凭据哈希绑定原始终轮字节，事件回放保留该判定。

## 答案与能力提示

通用提示要求先确定所问的答案单位和范围，再选择支持完整答案的最小充分证据。判断题遵循任务约定的标签；名单、数值和关系保留必要部分。该指导不截断模型回答，JSON 合法性也不能证明结论或引用具备语义支持。

框架文件工具按当前 execution scope 的 capability manifest 装配。已知精确文件路径可直接读取；`ls` 用于发现未知路径。todo 工具及其操作说明仅在该 scope 授权 `write_todos` 时启用；禁用时保留框架同名覆盖点，防止模型 profile 重新追加该工具。框架记忆继续加载和缓存原有内容；未授权 `edit_file` 时，只替换框架追加的写入指导，保留用户文本、记忆内容和缓存元数据。模型可见性检查和运行时工具授权继续生效。

## QASPER 与验证边界

QASPER adapter `qasper-roc-runtime-v3` 从公开 `paper.json` 生成答案/证据 schema，约束 ID 存在且唯一。独立 verifier 额外核对冻结响应合同，最终评分仍绑定 root checkpoint 和最后一次原始模型响应，原生 QASPER grader 保持原样。

响应要求、application contract 和文件工具描述已变化，v2 结果不能直接与 v3 比较。原始运行证据已清理，现仅保留带日期的[历史摘要](../evaluation/VALIDATION.md)。当前比较必须另建相同数据、adapter、模型、请求配置、工具定义和评分合同的兼容基线。受控回归验证运行行为；答案 F1、证据 F1、格式失败率与资源改善须由真实模型运行测量。
