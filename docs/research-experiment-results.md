# 实验指标、审核与比较

X-EXP A1 使用真实完成的实验和冻结文件，不另建计算引擎。`research.experimentResults.review` 是主进程绑定用户窗口的人工操作，模型不能通过参数提供审核身份。

## 输出合同

实验在 output 写入 UTF-8 JSON，最多 1 MiB，固定 `schemaVersion:1` 和 1–100 个唯一指标：

```json
{
  "schemaVersion": 1,
  "metrics": [{
    "id": "mean",
    "value": 4,
    "unit": "ms",
    "sampleSize": 3,
    "uncertainty": {"kind": "recorded", "type": "standard_deviation", "value": 2},
    "confidenceInterval": {"kind": "unavailable", "reason": "本次分析未估计区间"},
    "effect": {"kind": "unavailable", "reason": "本次未测量对照组"}
  }]
}
```

`value` 可为负数，不能是非有限数；样本量为正整数。误差记录区分 `standard_deviation` 和 `standard_error`。置信区间记录 `lower`、`upper`、0–1 之间的 `confidence`；效应量记录名称、值和单位。未估计的量必须明确 `unavailable` 和原因，不补造零、区间或效应量。省略字段、重复指标和未知版本失败。

## 人工冻结

审核请求指定 project/run、确切 `inputHash`、输出相对路径和 SHA-256，并为每个指标提交 label、definition、unit 和方向。指标集合与输出完全一致，单位不一致拒绝。用户填写统计方法、选择理由、假设和限制；产品不自动选择统计方法或筛选显著结果。

数值和统计量从经过执行链核验的真实输出解析。回执绑定审核请求、主进程用户身份、时间、结果 JSON、运行/环境哈希、实际执行源码 SHA、声明输入、参数、命令参数和 Python seed。Notebook 的执行源码为冻结的 `roc-notebook/run.py`，其完整输入身份由 Notebook/导入回执及执行审计共同绑定。

回执不可原地编辑。同一 requestId/用户/完整请求的重放返回原回执，不重复计算或重审；改变任一审核内容必须明确新 requestId。归档项目不新增审核。失败、取消或中断运行不生成成功形状的指标回执，原运行和负结果仍保存在实验链。

DB44 仅新增结果账本及索引，不转换旧实验/Notebook，也不修改原始用户记录。`list` 显式分页并返回历史回执；它不表示磁盘来源当前有效。`get` 核验完成的实际执行、全部冻结文件和资源审计，再对照回执中的结果和源码身份。文件缺失、损坏或被主机重新哈希时失败，不自动重算、补文件或改回执。

## 比较合同

两端都使用确切 result ID 和回执 SHA，并经过来源复核。比较逐项返回 `data`、`metric_definitions`、`units`、`environment`、`parameters`、`seed`、`method` 差异；输入路径/大小/SHA、指标语义、方向、效应量单位、实际环境、命令参数和审核方法均参与核对。输入和参数排序不影响相等性。

没有差异时 `comparable:true`；存在差异时 `comparable:false`，保留双方完整数值、样本/误差/区间/效应量和人工方法。该判断是冻结合同的结构可比性，不是科学支持性结论，不排名、不返回 winner、不宣称显著性。单位转换和可比性例外未实现，不静默转换或假定等价。

## A1 验证

2026-11-06，全部命令在仓库根目录：

- `node --test --test-name-pattern='metric review|DB41 upgrade' tests/integration/research-python-experiments.test.mjs tests/integration/research-python-selection.test.mjs` 3/3，实际 CPython 3.14 计算、人工 IPC 身份、重复运行比较、参数/数据差异、错误单位/哈希、源码及 manifest 重哈希拒绝和磁盘重启零 dispatch。
- `node --test tests/unit/research-experiment-results.test.mjs` 3/3，非有限数/缺失字段/负误差/错误区间拒绝、七类差异及命令参数、负值、DB43→44 原始 Notebook 字节守恒。
- `pnpm typecheck`、`pnpm build`、`pnpm check:ipc`、`pnpm check:renderer-chunks` 通过；Harness 94/94。

- `pnpm test:unit` 1201/1201，exit 0；新增迁移检查另以最终 focused 命令 3/3 验证。
- `node scripts/run-research-p0.mjs` 13/13，exit 0。
- `node scripts/smoke-electron.mjs` 13/13，exit 0，零 renderer error。

状态：`Verified passing`，限本部分指标来源、人工审核和比较 API。证据 `.artifacts/research-optimization/xexp-a1-*.log`。界面及 Result→Evidence/图稿/主张/假设消费者仍待后续实施。
