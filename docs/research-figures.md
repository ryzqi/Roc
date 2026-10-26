# 科研图稿

科研图稿由研究 agent 创建，没有单独的图表编辑器。新图稿使用离线 Vega-Lite v6 JSON spec 和显式声明的本地 CSV/TSV/DSV/JSON 输入。图稿不会执行 Python、Matplotlib 或任意 JavaScript；spec 只接受 Vega-Lite 受限表达式语法。独立的数据实验使用受限的 Node.js `.mts` `run(context)` 合同，详见[数据实验说明](research-experiments.md)。Python 图稿记录只允许读取已保存的历史产物，不能重新执行或作为新图稿输入。

## 创建图稿

`startFigure` 请求的 `engine` 固定为 `vega-lite`，`sourceVersion` 为 `1`。`sourcePath` 必须指向 `.vl.json` 文件；`inputPaths` 列出 spec 使用的所有本地数据文件，路径相对于项目工作区。`data.url` 必须与 `inputPaths` 中的路径完全相同。应用将 spec 和声明的数据复制到本次运行的只读快照，再在关闭网络的隔离任务中渲染。

```json
{
  "engine": "vega-lite",
  "sourceVersion": 1,
  "sourcePath": "figures/improvement.vl.json",
  "inputPaths": ["data/results.csv"],
  "label": "各组改善幅度",
  "timeoutMs": 120000,
  "figure": {
    "widthInches": 5,
    "heightInches": 2.5,
    "dpi": 180,
    "seed": 7
  }
}
```

对应的 `figures/improvement.vl.json`：

```json
{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "data": { "url": "data/results.csv" },
  "mark": { "type": "bar", "color": "#20736b" },
  "encoding": {
    "x": { "field": "Group", "type": "nominal" },
    "y": { "field": "Improvement", "type": "quantitative" }
  }
}
```

渲染只从本次快照读取已声明的数据。远程 URL、外部图片、链接和 SVG 资源会被拒绝。单个输入最多 64 MiB，合计最多 256 MiB，数据行合计最多 100,000 行；spec 上限 4 MiB、最大嵌套深度 64。宽高范围为 1–24 英寸，DPI 为 72–1200，seed 为 0–4294967295 的整数；总像素不超过 32,000,000。seed 会控制 Vega 随机源；同一输入和环境仍可能受系统字体差异影响。

## 运行、查看和发布

`inspectFigureEnvironment` 返回 Vega、Vega-Lite、Canvas 和 Node 环境及其 hash。可以将 `hash` 传给 `startFigure.expectedEnvironmentHash`，在已检查环境变化时拒绝启动。UI 不必传 hash；主进程使用当前环境并将其记录在运行快照中。

`startFigure` 返回可轮询的运行记录。使用 `getFigureRun` 查看状态，使用 `cancelFigure` 取消。每次重绘使用新的 `requestId`；修改 spec、数据、参数或选项都会产生独立运行。成功运行生成 `figure.png`、`figure.svg`、单页 `figure.pdf` 和 `figure-validation.json`。PDF 使用现有 `@napi-rs/canvas` PDF 后端，页面尺寸和输出 DPI 来自 `figure` 选项。主进程独立校验三种格式的尺寸、页数及 SHA-256；验证失败时运行标记为失败，并保留已收集的日志和产物供诊断。

运行成功后，在可编辑的绘图阶段发布：

```typescript
await research.publishFigure({ projectId, runId, replacesFigureId: null });
```

发布前会重新验证冻结文件、写入并核验图稿清单，然后在同一事务中建立图稿、流程工件和 provenance。`getFigure({projectId, figureId})` 与 `listFigures({projectId, limit})` 返回图稿、验证报告、当前审核状态和运行标识。旧 `recordFigure` 接口只能保存历史元数据，不能覆盖已发布图稿，也不能替代真实渲染验证。

## 人工审核和替换

发布后的状态为 `rendered`。通过 `createClaim` 将图稿说明保存为 `subjectType: "figure"` 的主张，并关联带定位的证据。阶段 agent 完成绘图时，结构化输出会关联本次运行已发布的图稿并追加模型 provenance，不会另造空图稿。绘图阶段 `complete` 先验证清单、spec、数据和输出，再检查证据；通过后进入 `waiting_approval`。用户检查图稿、主张与证据后调用阶段 `approve`，图稿才显示 `approved`。

核验期间阶段、图稿或主张版本改变时，旧请求失败，须基于当前内容重新审核；应用关闭也会撤销迟到批准。审核期间任何文件变化都会阻止批准。输出能被解析不代表科学结论已获证实，图稿内容仍须审核。

审核退回后，重新运行修改后的 spec，再用旧图稿 ID 作为 `replacesFigureId` 发布新图。替换会原子移除旧图在当前审核集合中的位置，并将旧图标为 `superseded`；旧 spec、文件、主张、证据和替换事件保留。新图须重新关联主张，证据不会自动继承。等待批准或已批准的版本不能直接替换，须先退回或按流程回到绘图阶段。

已登记输出通过资源路由按哈希读取，支持 PNG/SVG/PDF；响应禁用脚本和网络资源，仅允许 SVG 自身内嵌的 data: 图片，路径与哈希失配时拒绝读取：

```text
roc-preview://research/figures/{encodedProjectId}/{encodedFigureId}/{png|svg|pdf}/{sha256}
```

图稿与实验来源在工作区原文件变化后仍可读取。批准的图稿可进入[科研最终导出](research-exports.md)。图稿域没有单独界面（[ADR 0024](adr/0024-stage-surface-removed.md)）：渲染、读日志与发布由对话 agent 调用 `research.figure.startOwned` / `publishOwned`；深链到 `?view=figures` 会明确失败。审核与替换仍经过人工审批闸门 `research_approve_gate`。
