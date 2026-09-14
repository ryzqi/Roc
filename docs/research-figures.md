# 可复现科研绘图

绘图复用实验执行服务：代码、声明的输入、环境文件和应用的渲染入口均保存为不可变快照。选择 `engine: "matplotlib"`，使用内置 Python 或已校验的 uv 环境；uv 环境须安装并锁定 Matplotlib。先调用 `inspectExperimentEnvironment`，再将其 `hash` 传给 `startExperiment.expectedEnvironmentHash`。

绘图请求沿用实验合同，另须显式指定 `figure` 和 `network: "disabled"`：

```json
{"widthInches": 6, "heightInches": 4, "dpi": 300, "seed": 42}
```

宽高范围为 1–24 英寸，DPI 为 72–1200，种子为 0–4294967295 的整数；总像素不得超过 32,000,000。所有辅助脚本和数据文件都要加入 `inputPaths`。`.roc/figure.py` 为本次冻结的渲染入口，不可与声明的输入重名。参数、命令行参数、日志、取消、中断恢复和文件上限沿用[实验合同](research-experiments.md)。

源文件必须将一个 Matplotlib `Figure` 赋给变量 `figure`。可以包含多个子图；应用将同一对象导出为 `figure.png`、`figure.svg` 和单页 `figure.pdf`，无需在源码中调用 `savefig`。例如，声明 `data.csv` 为输入后：

```python
import matplotlib.pyplot as plt
import numpy as np

data = np.loadtxt("data.csv", delimiter=",")
figure, axes = plt.subplots(layout="constrained")
axes.plot(data[:, 0], data[:, 1], marker="o")
axes.set(xlabel="Input", ylabel="Response", title="Measured response")
```

应用使用 Agg 后端，固定导出尺寸、SVG 标识种子、Python `random` 与 NumPy 全局随机种子，并去除 PDF/SVG 创建时间。配色、布局和字体由源码控制，不强加期刊规范。自建随机生成器、时钟或其他不确定计算仍须由源码显式控制；固定输入和环境并不保证任意用户代码产生相同内容。

脚本结束后，新的内置 Python 进程独立解码 PNG、解析 SVG、打开并渲染 PDF，校验像素、画布尺寸和单页约束。SVG 拒绝脚本、外部链接和外部资源。验证报告 `figure-validation.json` 保存渲染入口摘要、选项、尺寸及三个输出的哈希。验证失败时，运行标记为失败，保留已收集的日志和输出供诊断。

## 发布和人工审核

`startExperiment` 返回可轮询的运行记录。使用 `getExperiment` 查询完成状态、`cancelExperiment` 取消，使用已登记的实验资源预览输出。每次重绘使用新的 `requestId`；修改代码、数据、参数或选项都会形成独立运行。

运行成功后，在可编辑的绘图阶段调用：

```typescript
await research.publishFigure({ projectId, runId, replacesFigureId: null });
```

发布前重新验证全部冻结文件，写入并核验图稿清单，然后在同一事务中建立图稿、流程工件和实验 provenance。`getFigure({projectId, figureId})` 和 `listFigures({projectId, limit})` 返回图稿、验证报告、当前审核状态和运行标识。旧 `recordFigure` 接口只能保存历史元数据，不能覆盖这些已发布图稿，也不能用元数据记录替代真实渲染通过审核。

发布后的状态为 `rendered`。通过 `createClaim` 将图稿说明保存为 `subjectType: "figure"` 的主张，并关联带定位的证据。阶段 Agent 完成绘图时，结构化输出会写到本次运行已发布的图稿，并追加模型 provenance；不会另造空图稿。绘图阶段 `complete` 先验证清单、代码、数据和输出，再检查证据；通过后进入 `waiting_approval`。用户检查图稿、主张与证据后调用阶段 `approve`，图稿才显示 `approved`。核验期间阶段、图稿或主张版本改变时，旧请求失败，须基于当前内容重新审核；应用关闭也会撤销迟到批准。审核过程中任何文件变化都会阻止批准。输出能被解析不代表科学结论已获证实，图稿内容仍须审核。

审核退回后，重新运行修改后的代码，再用旧图稿 ID 作为 `replacesFigureId` 发布新图。替换会原子移除旧图在当前审核集合中的位置，并将旧图标为 `superseded`；旧代码、文件、主张、证据和替换事件保留。新图须重新关联主张，证据不会自动继承。等待批准或已批准的版本不能直接替换，须先退回或按流程回到绘图阶段。

已登记输出通过以下资源路由按哈希读取，支持 PNG/SVG/PDF；响应禁用脚本和网络资源，仅允许 SVG 自身内嵌的 data: 图片，路径与哈希失配时拒绝读取：

```text
roc-preview://research/figures/{encodedProjectId}/{encodedFigureId}/{png|svg|pdf}/{sha256}
```

图稿与实验来源在工作区原文件变化后仍可读取。批准的图稿可进入[科研最终导出](research-exports.md)；完整编辑界面由 Renderer 增量接入。

## 验证

常规生命周期、迁移和协议回归不需要私有工具链：

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/figure-service.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/pdf-preview-protocol.test.ts
```

真实 IPC 测试需要已准备的私有工具链，保留图像与审核证据：

```bash
rtk proxy env PYTHONDONTWRITEBYTECODE=1 ROC_RESEARCH_TOOLCHAIN=/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64 ROC_RESEARCH_ARTIFACT_ROOT=/Users/Apple_501/Desktop/Roc/Roc/.artifacts/research-figure-integration pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/figure-ipc.test.ts
```
