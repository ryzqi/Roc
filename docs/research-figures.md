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

`startFigure` 返回可轮询的运行记录。使用 `getFigureRun` 查看状态，使用 `cancelFigure` 取消。每次重绘使用新的 `requestId`；修改 spec、数据、参数或选项都会产生独立运行。成功运行生成 `figure.png`、`figure.svg`、单页 `figure.pdf`、`figure-data.json` 和 `figure-validation.json`。PDF 使用现有 `@napi-rs/canvas` PDF 后端，页面尺寸和输出 DPI 来自 `figure` 选项。主进程独立校验三种格式的尺寸、页数及 SHA-256；验证失败时运行标记为失败，并保留已收集的日志和产物供诊断。

阶段角色使用 `start_figure → get_figure → publish_figure`，三个工具统一采用真实图稿运行 `runId`。`get_figure` 只读取当前项目、当前有效阶段所拥有的图稿，返回状态、错误、文件数和 `artifactId`，不返回二进制。`failed`、`cancelled`、`interrupted` 是终态，不能继续轮询或发布。`get_experiment` 只查询脚本实验；图稿工具不接受 `experimentId` 别名。

渲染 pipeline `/3` 在作业入口将 spec 相对路径解析到冻结项目目录，并使用 Vega-Lite `autosize: { type: "fit", contains: "padding" }`，按指定物理尺寸容纳坐标轴和留白。SVG/PDF 保持英寸换算后的 point 尺寸，PNG 使用 `Math.trunc(inches * dpi)` 像素尺寸。单图和 layered 图适用 fit；复杂组合或显式 step 不能满足固定尺寸时，输出校验失败，不改变请求尺寸或放宽验证。发布与运行的 `artifactId` 在同一数据库事务中关联。

`figure-data.json` 保存实际 Vega scenegraph 的 post-transform datum、场景路径、完整编译编码、直接字段编码及常量/暂不支持的编码通道，绑定源 spec、渲染环境和编译 spec 的 SHA-256。filter、aggregate、formula 和 stack 之后的数据来自实际绘制项；默认柱图的 y 字段可能是 stack 生成的 `mean_end`，而非输入的 `mean`。条件、表达式及嵌套字段编码保留完整原文并标为 unsupported；不推断科学含义或自动关联实验指标。回执最多 1000 个 mark，场景遍历最多 100,000 项；超限拒绝，不截断。

主进程核对 renderer 返回的回执字节/hash，再核对回执来源及环境。回执是运行输出及 version 2 图稿清单的必需文件，任何字节变化会阻止验证、审批或导出。导出保留 `provenance/figures/<figureId>/` 下完整图稿清单、输入、输出及日志；三种图片同时位于 LaTeX 图稿目录。

运行快照固化工具清单。包含旧图稿查询合同的快照不原地扩权；执行或重试会报 `research_run_tool_contract_changed`，须使用新 `requestId` 新建阶段运行。历史记录保留用于审计。

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

图稿与实验来源在工作区原文件变化后仍可读取。批准的图稿可进入[科研最终导出](research-exports.md)。图稿域没有单独界面（[ADR 0024](adr/0024-stage-surface-removed.md)）：对话代理调度图稿阶段，阶段角色通过内部 `research.figure.startOwned` / `getOwned` / `publishOwned` 映射调用生产工具。Owned 映射不增加公开 IPC 能力；深链到 `?view=figures` 会明确失败。审核与替换仍经过人工审批闸门 `research_approve_gate`。

## 实际场景回执验证（X-WRITE A4C1）

范围状态：`Verified passing`。工作目录 `/Users/Apple_501/Desktop/Roc/Roc`，日志位于 `.artifacts/research-optimization/`。

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `node --test tests/unit/research-figure-integration.test.mjs tests/unit/research-figure-owned.test.mjs tests/unit/research-production-review.test.mjs tests/unit/research-export-body-gate.test.mjs` | 24/24，通过实际 filter/aggregate/formula/stack、条件编码、确定性回执和两阶段篡改拒绝 | `xwrite-a4c1-focused-final.log` |
| `pnpm build` | 通过，包含 typecheck | `xwrite-a4c1-build.log` |
| `node scripts/run-research-p0.mjs` | 13/13，实际渲染/编译/导出逐文件哈希通过 | `xwrite-a4c1-p0.log` |
| `pnpm harness:eval` | 94/94 | `xwrite-a4c1-harness.log` |
| `node --test tests/renderer/artifact-production.test.mjs` | 9/9 | `xwrite-a4c1-renderer.log` |
| `node scripts/smoke-electron.mjs` | 13/13，零 renderer error | `xwrite-a4c1-startup.log` |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | 当前合同；1,134,192 bytes / 6 eager 文件 | `xwrite-a4c1-ipc.log` / `xwrite-a4c1-chunks.log` |

补充完整 unit 在断言修正及导出消费者修改前启动，结果 1235/1236；唯一失败是测试预期 experiment 文件错误，而实际为 `research_figure_snapshot_changed`。保留失败日志 `xwrite-a4c1-unit.log`，修正精确错误断言后上表最终 24 项通过，未宣称完整 unit 重跑通过。前两轮图稿测试还错误预期 y 编码原字段；实际渲染证明 stack-end 字段才是正确回执。没有放宽数值、来源或错误合同。

此部分记录实际绘制数据及冻结字节。实验指标/Evidence 的人工映射、规则审核和消费者由 A4C2 接入，C1 不声明已完成图稿科学一致性，也不代替科学审核。

## 图稿数据人工映射（X-WRITE A4C2A）

`research.inspectFigureConsistency` 验证实际图稿冻结文件，返回编译 mark、完整编码及直接字段摘要；场景项按显式 mark、offset、limit（最多 200）分页读取。数值位置只包括直接编码的有限 datum；基线等数值也会计数，不能自动推断它们都是科学指标。条件、表达式、常量和缺失字段不接受指标映射。

`research.saveFigureConsistencyReview` 将指定 mark、channel、field 和 scenePath 绑定到图稿主张及真实结果指标 Evidence。请求显式包含工件版本、图稿 manifest/trace hash、单位、转换/舍入/容差规则、最新父审核和人工理由。计算沿用正文合同；不一致照实保存，不授予科学批准。主进程在异步指标读取后再次核对图稿文件，并在事务中重查主张、Evidence、结果和工件版本。窗口身份由 IPC 绑定，完全相同的请求重试返回原回执且零重复写入。

DB49 保存不可变版本，包括冻结运行、图稿、trace 引用、选中编码/实际 scene item、主张、Evidence、指标结果与计算。审核头纳入整个工件快照，保存后旧阶段审批版本失效。`research.getFigureConsistencyHistory` 独立验证保存 JSON/hash、来源清单关联、计算与父版本；当前来源失效后仍能读取明确标注的 `stored_receipt`。每条映射只保存选中项，不复制整个 trace。

本部分交付主进程合同和 IPC；同壳映射界面及审批/导出消费者后续接入。核对的是实际 datum 和完整编码，不推断科学含义或最终像素位置。

A4C2A 定向状态为 `Verified passing`。仓库根目录执行 `node --test tests/unit/research-figure-consistency.test.mjs tests/unit/research-consistency.test.mjs tests/unit/research-artifact-inspector.test.mjs tests/unit/research-gate-review.test.mjs tests/unit/research-export-body-gate.test.mjs`：31/31；`node --test --test-name-pattern='actual result metric evidence' tests/integration/research-python-experiments.test.mjs`：1/1，含真实负值绘制、磁盘历史和来源变化拒绝。`pnpm build`（含 typecheck）、P0 13/13、生产文件 renderer 9/9、启动 13/13 零 renderer error、IPC 当前及 chunks 1,134,192 bytes / 6 文件通过。日志位于 `.artifacts/research-optimization/xwrite-a4c2a-*.log`。补充完整 unit 1244/1244、Harness 94/94 已收集通过。最初单测的工作区、待审批主张编辑及 Zod 错误断言夹具问题已修正，拒绝合同保持不变。


## 图稿数据映射界面（X-WRITE A4C2B）

同一工件抽屉提供按需加载的「检查图稿绘制数据」，保留独立的说明文字数值检查。场景标记、完整编码、实际数值字段和场景路径可浏览；每页 20 项，摘要和分页分别绑定图稿/工件版本。分页不会清空累计映射，正在编辑的待加入字段会锁住翻页与标记切换。仅直接数值字段可选，常量和不支持的编码分别显示。

人工明确选择场景项、通道、主张、真实指标 Evidence 和展示单位，再填写转换、舍入、容差及审核理由。空数值输入拒绝加入，不自动转成零。加入、替换、移除和放弃均是本地草稿动作；保存绑定最新父回执和整个工件版本。保存中或有草稿时锁住抽屉关闭、Escape、刷新、阶段审核以及其他审核编辑。完全相同的丢失回执重试返回原版本且零重复写入。成功后刷新整个工件，旧审批上下文失效。

保存回执可独立分页、展开全部原文；当前冻结文件变化时隐藏此前成功的报告并拒绝保存，历史仍明确标注未按当前来源复核。只读、已批准、归档状态可浏览，不能保存。迟到的摘要、场景页、指标和保存回复不会进入另一项目。

范围状态 `Verified passing`，工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `pnpm build` | 通过，包含 typecheck | `xwrite-a4c2b-build-final.log` |
| `node --test tests/renderer/figure-consistency.test.mjs tests/renderer/scientific-consistency.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/artifact-inspector.test.mjs` | 47/47；新图稿 6 项，既有正文和生产/抽屉回归全部通过 | `xwrite-a4c2b-renderer-final.log` |
| `node --test tests/unit/research-figure-consistency.test.mjs tests/unit/research-production-review.test.mjs` | 13/13 | `xwrite-a4c2b-focused.log` |
| `node scripts/smoke-electron.mjs` | 13/13，零 renderer error | `xwrite-a4c2b-startup.log` |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | 合同当前；1,134,228 bytes / 6 eager 文件 | `xwrite-a4c2b-ipc.log` / `xwrite-a4c2b-chunks.log` |

日志和真实 Electron 45/macOS arm64 的 650px 明暗主题截图在 `.artifacts/research-optimization/`，减弱动效、默认/悬停/编码展开/最终状态均满足 `cut=0`，仅三个精确的抽屉物理边缘阴影被隐藏，无横向溢出。指标使用明确合成的已存结果，场景确实由 Vega 渲染；实际 CPython 来源检验由 A4C2A 的集成测试覆盖。此部分不声明最终像素位置或科学含义已经批准；审批与导出消费者由 A4C2C 接入。
