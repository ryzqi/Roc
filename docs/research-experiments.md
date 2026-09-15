# 科研实验运行

实验从项目内的 Python、R、Julia 脚本或 Python Notebook 启动。启动前先调用 `inspectExperimentEnvironment`，将返回的环境摘要 `hash` 放入 `startExperiment.expectedEnvironmentHash`；每次新运行使用新的 `requestId`，相同请求重发返回已有运行。`engine` 必须与所选运行时及源文件类型一致。

Python 可以选择随应用提供的运行时，或者使用同一内置解释器创建的项目 `.venv`（不继承系统 site-packages）。uv 模式要求 `uv.lock` 和 `pyproject.toml`：先在受限项目 Python 中收集实际包信息，再将安装元数据复制到没有启动钩子的临时环境，执行 `uv sync --locked --check --offline --no-python-downloads --no-build`。该检查不自动安装、升级或改写锁文件。环境摘要记录解释器、Python 版本、平台、包版本、安装元数据摘要、锁文件摘要和固定工具链身份。

R 使用 `{kind:"renv", rootPath, libraryPath}`：`rootPath` 是所选 R 的 `R.home()` 绝对目录，`libraryPath` 是项目内的相对库目录。项目须有 `renv.lock`，库中须有 `renv`；支持 renv 创建的包缓存链接。运行前检查 R 版本、`renv::status()` 与实际包描述，锁文件中的 R/包版本不符会失败。R 以 `--vanilla` 启动，不加载项目或用户启动配置；使用指定库和该 R 自带的库，不恢复额外的 site-library。

Julia 使用 `{kind:"julia", rootPath, depotPath}`：`rootPath` 包含 `bin/julia`，`depotPath` 指定已准备的 depot，均为绝对目录。预检使用所选 Julia 的 Pkg 检查 Project/Manifest 是否同步、依赖和 artifacts 是否已安装，以及 Manifest 中的 Julia 版本。实际选中的项目/版本化 Manifest、工作区项目配置、JuliaLocalPreferences/LocalPreferences 和 JuliaArtifacts/Artifacts 配置会保存到输入快照，保留 Julia 自身的文件选择优先级。运行关闭 startup 文件和自动预编译，使用已有编译缓存；不加载默认全局环境。本地相对路径依赖的 Project.toml 与源码需要一并声明为输入，绝对路径依赖会被拒绝。

R/Julia 解释器、包元数据及锁文件摘要均纳入环境指纹，运行结束时再次校验。未声明版本的 Julia 包将版本记录为 `null`。应用不安装 R/Julia 或修改其项目库/depot；所选运行时需与当前 macOS 兼容。

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

`network` 明确选择是否联网；禁用时 Notebook 仅开放运行内核所需的本机回环通信。输出写入本次输出/临时目录；标准输出和错误单独保存，进程整体受超时和取消控制。脚本的 `arguments` 分别进入 Python `sys.argv`、R `commandArgs(trailingOnly=TRUE)` 或 Julia `ARGS`，参数字典也保留在同一 JSON 环境变量中。

R 的标准库会执行系统命令。应用附带带源码和哈希的 arm64/x64 通用适配库，让 popen/pclose/system 使用受控的 fork/exec；R 及其子进程从启动起都位于沙箱中，不能另建进程组/会话或调用 posix_spawn。允许的系统辅助程序仅为 sh/bash、uname、which 和 rm，其文件访问仍限于已授权目录。R 每个进程使用独占、不含空格的临时目录，结束或取消后清理。其他未授权外部程序不会自动放行。

成功运行的持久记录保存输入/输出哈希清单、日志和可检索的文本结果；Notebook 的文本输出保留单元格及输出序号定位。`readExperimentFile` 读取已登记文件（预览上限 4 MiB）；资源 URL 按运行、文件与内容哈希核验。来源内容变化会拒绝读取。证据可以通过 `getEvidenceExperimentSource` 回到对应实验文件。

`publishExperiment` 从已提交的运行记录生成并校验 JSON 清单，再关联实验阶段的流程工件及 provenance；需要项目处于可编辑的实验阶段。取消会等待进程退出并保存日志，应用关闭或重启恢复时将未完成运行标记为 interrupted。中断运行不自动重复执行，重新运行须使用新 `requestId`，并重新校验环境与当前输入。

阶段 Agent 的写工具由服务绑定当前项目和本次阶段运行。脚本修改使用 `expectedHash`；实验、图稿、导出启动使用新的 `requestId`，重复同一请求返回已有记录。`ownerRunId` 只由服务写入，模型不能指定项目身份。取消或替换阶段运行后，迟到的脚本写入、完成结果和发布都会被拒绝。人工批准和最终 ZIP 交付仍不向模型开放。

实验、绘图和导出阶段的模型输出必须绑定本次运行链已发布的真实工件。系统不会另造 `path=null` 的空产物；未发布时阶段失败并保留模型版本。失败或重试会留下已发布记录，重试成功后把模型 provenance 接到这些工件。手工创建的元数据工件不能代替实际发布。

科研绘图使用 `engine: "matplotlib"` 及显式 `figure` 选项，完整约定见[图稿执行与审核](research-figures.md)。科研页实验视图可校验环境、启动运行、读取日志并发布实验或图稿。任意本机环境包的源码并非完整打包快照；环境摘要记录实际包版本、安装元数据及项目锁文件，运行前后都会重新检查其一致性。

修改 R 进程适配器时，构建机需要 macOS 的 Command Line Tools；以下命令重建两个架构、合并为通用库并更新源码/二进制哈希。应用运行时直接使用已构建资源。

```bash
rtk proxy python3 -B /Users/Apple_501/Desktop/Roc/Roc/scripts/research/build-r-process.py
```
