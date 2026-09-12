# 科研实验运行

实验从项目内的 Python 脚本或 Python Notebook 启动。启动前先调用 `inspectExperimentEnvironment`，将返回的环境摘要 `hash` 放入 `startExperiment.expectedEnvironmentHash`；每次新运行使用新的 `requestId`，相同请求重发返回已有运行。

Python 可以选择随应用提供的运行时，或者使用同一内置解释器创建的项目 `.venv`（不继承系统 site-packages）。uv 模式要求 `uv.lock` 和 `pyproject.toml`：先在受限项目 Python 中收集实际包信息，再将安装元数据复制到没有启动钩子的临时环境，执行 `uv sync --locked --check --offline --no-python-downloads --no-build`。该检查不自动安装、升级或改写锁文件。环境摘要记录解释器、Python 版本、平台、包版本、安装元数据摘要、锁文件摘要和固定工具链身份。

`sourcePath` 和 `inputPaths` 均为项目内的相对文件路径。运行前复制并校验所有输入及环境文件，脚本在该副本中执行。项目外文件、符号链接和路径越界会失败；原项目中的输入保持只读。单文件最多 64 MiB，每次输入及输出分别最多 256 MiB，最多 1,000 个声明输入和 1,000 个输出文件。需要使用的辅助脚本、数据文件应一并列在 `inputPaths`。

脚本通过以下环境变量读取参数和输出位置：

- `ROC_INPUT_DIR`：本次冻结输入目录，也是执行工作目录。
- `ROC_OUTPUT_DIR`：本次输出目录；需要保留的结果写入这里。
- `ROC_PARAMETERS_JSON`：请求中的参数字典，值为字符串。

```python
import json
import os
from pathlib import Path

parameters = json.loads(os.environ["ROC_PARAMETERS_JSON"])
data = Path("data.csv").read_text(encoding="utf-8")
Path(os.environ["ROC_OUTPUT_DIR"], "result.txt").write_text(data, encoding="utf-8")
```

Notebook 总是使用所选环境的 Python，不采用文件中指定的任意 kernel。uv 环境运行 Notebook 需要预先安装并锁定 `ipykernel`。执行后的 Notebook 保存单元格输出；出现单元格错误时也保留已执行内容。Notebook 参数使用同一环境变量协议，不接受命令行参数。

`network` 明确选择是否联网；禁用时 Notebook 仅开放运行内核所需的本机回环通信。子进程只可执行本次指定的解释器，输出写入本次输出/临时目录；标准输出和错误单独保存，进程整体受超时和取消控制。

成功运行的持久记录保存输入/输出哈希清单、日志和可检索的文本结果；Notebook 的文本输出保留单元格及输出序号定位。`readExperimentFile` 读取已登记文件（预览上限 4 MiB）；资源 URL 按运行、文件与内容哈希核验。来源内容变化会拒绝读取。证据可以通过 `getEvidenceExperimentSource` 回到对应实验文件。

`publishExperiment` 从已提交的运行记录生成并校验 JSON 清单，再关联实验阶段的流程工件及 provenance；需要项目处于可编辑的实验阶段。取消会等待进程退出并保存日志，应用关闭或重启恢复时将未完成运行标记为 interrupted。中断运行不自动重复执行，重新运行须使用新 `requestId`，并重新校验环境与当前输入。

R/Julia 环境与脚本接入、图稿编排及完整界面分别由后续增量提供。任意本机环境包的源码并非完整打包快照；uv 环境摘要记录实际包版本及项目锁文件，运行前后都会重新检查其一致性。
