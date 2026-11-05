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

## A2 生产检查器

在现有实验工件的生产视图内审核与比较，不新增导航或 shell。默认只读取选中的生产快照；打开审核表单仍不读取指标文件，明确选择保存的输出后才按工件版本、文件路径和 SHA-256 读取。指标数值、单位、样本量和输出统计量只读，名称、定义、方向和统计方法必须由用户填写。

提交期间禁用表单。同一完整内容重试复用原 requestId，回执丢失后重试不重复审核。只读、非当前快照或归档项目不能新增审核。历史列表每页 20 份，选择确切 ID/hash 后重新核验实际运行和文件。比较须明确选择对照运行及其回执，显示双方指标、方法和来源版本，以及七类差异；不会选择赢家或推断显著性。

文件和执行漂移、错误指标合同、跨项目、缺失或损坏回执由主进程返回明确错误代码和文案。未知实现错误仍通过统一 IPC 内部错误边界报告，不在 renderer 伪造来源状态。切换输出、回执、对照或运行时清空旧结果，晚响应不会恢复已清除的选择。

## A2 验证

2026-11-06，工作目录 `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`，基线 `9985c50a`：

- `node --test tests/renderer/experiment-results.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/artifact-inspector.test.mjs` 41/41，exit 0。新增 7 项使用实际 CPython 3.14.7 输出、Electron renderer 和主进程 capability adapter；环境选择回调使用固定测试路径，renderer 通过 fixture 桥接实际 adapter，未覆盖 OS 原生面板与真实 preload。
- 新界面覆盖键盘提交、负值、样本量与误差、不可用区间/效应量、重复与参数变化比较、真实源码漂移和明确错误代码、非法输出、只读状态、分页、晚读取/比较响应、已写入但丢失回执后的同请求重试与 pending 禁用。
- `node --test tests/unit/research-experiment-results.test.mjs` 4/4，exit 0，覆盖指标合同、全部比较维度、迁移及明确 IPC 错误边界。
- `pnpm build` 通过，包含 typecheck。
- `node scripts/smoke-electron.mjs` 13/13，exit 0，零 renderer error；`pnpm check:ipc`、`pnpm check:renderer-chunks` 通过。

首轮新 UI 2/5：方向 select 的准确可访问名称缺失、匿名 clip-audit 调用方式错误、来源漂移被普通 Error 映射为内部错误。修复标签、测试脚本调用和主进程 domain error 翻译后，保留原实际断言全部通过，没有放宽为通用错误或减少样本。

浅色和深色 650px 比较截图均已目视检查，`cut:0`、`hidden:0`，无窗口横向溢出；长哈希可换行，完整回执可展开并局部滚动。证据保存在 `.artifacts/research-optimization/xexp-a2-*.log` 和 `xexp-a2-ui/`。

状态：`Verified passing`，限本部分人工审核与比较界面、错误体验和上述回归。Result→Evidence/图稿/主张/假设仍待后续部分。

## A3 固定指标证据

在实验检查器选定已审核回执后，明确选择其中的指标并保存为既有 Evidence。请求必须包含 project、result ID、回执 SHA-256 和 metric ID；主进程核验真实用户、完整运行和实际输出。每个指标来源固定原始输出的 `/metrics/<index>`、文件 SHA、指标值及统计量、人工指标定义和统计方法。来源元数据使用 `experiment-result`；原始 `experiment-run` 仍表示未关联指标审核回执的原始输出证据。

指标来源以确定 ID 登记到既有 knowledge，单 chunk、零 embedding，与 Evidence 捕获处于同一事务。重复捕获返回同一证据，不重写来源；不同审核回执产生不同来源，不覆盖旧主张、Idea 字段或历史。失效引用、跨项目、错误 hash、未知指标、已归档项目和来源漂移拒绝。事务失败不留下孤立 knowledge。

现有主张、图稿和 Idea 字段继续引用 Evidence ID。检查器聚合 Idea 字段的证据；来源折叠块按需复核确切指标回执，再由明确操作读取真实指标输出。切换来源后旧响应不会恢复原内容。导出 sources 必须包含 `experimentResults`，固定所引用回执并核验 Evidence 元数据、主张审核、实验文件和图稿实际渲染记录。

## A3 验证记录

2026-11-06，工作目录 `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`，基线 `8c98315`：

- `pnpm generate:ipc`、`pnpm typecheck`、`pnpm build` 通过。
- `node --test tests/unit/research-experiment-results.test.mjs tests/unit/research-export-body-gate.test.mjs` 10/10，exit 0。
- `node --test --test-name-pattern='actual result metric evidence' tests/integration/research-python-experiments.test.mjs` 初版在虚构图稿缺少渲染记录处失败；改为实际 Vega 渲染、发布、人工确认支持关系后 1/1 通过。覆盖实际 CPython 负结果、事务回滚、重复捕获不修改 knowledge、零 embedding、跨项目、主张历史、真实图稿、正文导出、Idea 证据、重启零计算、归档和实际文件漂移。
- `node --test --test-name-pattern='keyboard metric capture' tests/renderer/experiment-results.test.mjs` 初版稳定超时；现场显示零来源请求、焦点仍在 summary，第二次 Enter 关闭了尚未展开的原生 details。等待原生内容可见并断言按钮获得焦点后 1/1 通过，保留准确可见文案、实际输出和请求断言。
- 650px 浅色和深色来源截图已目视检查，`cut:0`、`hidden:0`。完整 hash、负值、指标定义、统计方法和真实输出可读取，键盘焦点可见。
- 最终扩展实际 trace 1/1，exit 0：新审核回执生成独立证据，原证据及 Idea 历史保留，失效证据拒绝读取和再次捕获。
- `node --test tests/unit/` 1203/1203，exit 0；`node --test tests/renderer/experiment-results.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/artifact-inspector.test.mjs` 43/43，exit 0。
- `node scripts/run-research-p0.mjs` 13/13、`node scripts/smoke-electron.mjs` 13/13，exit 0，零 renderer error；`pnpm harness:eval` 94/94，exit 0。
- `pnpm check:ipc`、`pnpm check:renderer-chunks` 通过，eager JS 1,134,003 bytes / 6 files。

日志 `.artifacts/research-optimization/xexp-a3-*.log`；失败 DOM/焦点/请求及截图、通过截图和审计回执在 `xexp-a3-ui/`。测试使用真实 CPython、Electron renderer 和 capability adapter；原生文件选择与 preload 由 fixture 桥接，未声称完整 OS picker/preload 全链覆盖。

状态：`Verified passing`，限本部分固定指标证据、实际消费者追溯、导出 sources 和上述回归。可检验假设与方法冻结属于下一部分。
