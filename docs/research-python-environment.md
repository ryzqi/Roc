# Python 环境选择、预检与执行

Python 支持项目绑定的 CPython 3.14 环境、真实隔离探针、文件实验与冻结 Notebook 执行。项目管理的任务区提供原生环境选择，实验角色读取选择并预检后运行；不会自动安装或修复环境。统一实验生命周期见[科研实验运行](research-experiments.md)。

## 用户选择与项目绑定

`selectPythonEnvironment({ projectId, requestId })` 只接受项目与请求身份。解释器路径由主进程的原生单文件面板返回，调用身份由真实 IPC sender 绑定；模型参数不能提供路径或用户 actor。面板使用 `noResolveAliases` 保留 venv 的解释器链接，随后执行下述预检和隔离探针。取消返回 `null`，失败不会保存成功回执，也不会安装或修复环境。

当前结构保存项目环境回执，不改写旧实验。每次成功选择保留独立 ID、原始请求、真实窗口 actor、工作目录、所选路径与真实解释器、版本、平台、完整环境身份、代码清单哈希及锁文件身份。同请求只读重放；另一个窗口不能重放原选择，新选择使用新请求。读取必须提供项目、选择 ID 和原始回执哈希。存储损坏、缺失回执、跨项目和错误哈希均失败。

主进程的环境解析会重跑真实探针，并核对原始工作目录和完整环境身份。历史回执的读取不意味着当前环境仍可用；版本、包代码、控制或锁文件变化需要新的显式选择。归档、项目释放和关闭应用会取消未完成的选择，等待探针清理后再释放服务。

`inspectExperimentEnvironment({ projectId, runtime: { kind: 'python', selectionId, expectedHash } })` 复用原实验环境 API。`expectedHash` 是选择回执的 `snapshotHash`；它不接受解释器路径或 actor。预览从项目绑定的回执重新解析环境，返回实际所选解释器路径、前缀、版本、完整安装包集合、锁文件和环境哈希。全部嵌套身份先按当前 schema 解析再计算哈希，返回值可独立复算。Python 分支不请求 R/Julia 或 TypeScript 工具链，不安装环境，也不创建实验记录。准入必须带相同项目；后台检查保留实际后台优先级。

## 当前环境合同

支持 macOS arm64 的独立 CPython 3.14 正式版及使用它的标准 venv。所选路径必须位于 `bin`，名称为 `python`、`python3` 或 `python3.14`；真实目标必须为 `bin/python3.14`。预检核验 thin arm64 Mach-O 可执行文件及 SHA-256。

主进程在启动解释器前检查所选和基础环境的 `bin`、`lib`，拒绝 `._pth` 和不支持的链接布局。标准 venv 必须有有界、普通的 `pyvenv.cfg`，声明正确的基础 `home`、3.14 版本及 `include-system-site-packages = false`。重复、缺失或未实现的配置项失败。基础环境和 `bin` 下的额外 `pyvenv.cfg` 不受支持。

选择的环境及基础环境的 `bin`、`lib` 都是显式代码根。代码根可能包含该环境自己的数据；项目目录和凭证目录没有因此获得读取权限。代码目录不能通过链接扩展到未声明目录。

## 锁文件

项目必须提供普通、非链接的 `roc-python.lock.json`，上限 4 MiB：

```json
{
  "schemaVersion": 1,
  "python": {
    "implementation": "cpython",
    "version": "3.14.7",
    "platform": "darwin",
    "architecture": "arm64"
  },
  "distributions": [
    { "name": "numpy", "version": "2.3.0" }
  ]
}
```

示例只说明格式，版本必须来自实际环境。包名采用小写规范形式，连续的 `-`、`_`、`.` 归一为 `-`。锁文件必须列出所选 `site-packages` 的完整安装包集合；包名唯一，版本逐字一致。缺包、多包、重复身份和版本不符均失败。

探针通过 `importlib.metadata.distributions(path=[明确的 site-packages])` 读取元数据，不导入包源码和入口点，也不将包目录加入自身的 `sys.path`。当前拒绝所有 `direct_url.json` 安装、`.pth`、`.egg-link`、`.egg` 和 `.egg-info`，不解释 editable、路径依赖或旧式启动语义。没有安装、下载或修复依赖的分支。

## 实际启动与身份

固定探针使用 `-I -S -B -X utf8 -c`，保留所选 venv 的解释器路径。验收核对实际 CPython 正式版本、平台、架构、解释器、前缀、基础前缀、三个标准模块路径、隔离旗标和未加载 `site`。

主进程先冻结全部声明代码树的字节、权限、成员及链接拓扑，再启动探针；返回后重新检查代码、所选解释器控制和锁文件。环境身份包括探针源码、实际报告、代码清单及控制/锁文件身份。只更改 native 包二进制，即使大小、时间戳、包元数据和锁文件不变，也会改变身份。探针期间持续存在的漂移拒绝本次结果。

两个扫描无法证明其间从未发生短暂修改。声明运行库中的可执行代码本身仍来自用户选择的环境；元数据报告不证明科研结论正确。

探针同时返回完整 Python 代码回执，使用统一的锁文件、控制和报告定义。回执包含实际代码清单及原始环境身份对象；离线验证核对清单哈希、元数据哈希、声明代码根、真实解释器文件哈希和实际启动路径。回执不复用 R/Julia 的身份格式。改写文件清单后重新计算清单哈希仍不能保留原环境身份；重新计算元数据哈希也不能掩盖解释器和启动路径之间的不一致。

## 进程边界与观测

实际调用复用 `runResearchProcess` 的项目准入、独立监督程序、Seatbelt、进程组回收和资源监控。只提供固定的 `PATH`、`LANG`、本次 `TMPDIR`；读取范围为代码根及 venv 控制文件，写入范围仅为本次探针目录。GPU 不授予，网络为 `none`。

探针声明 60 秒墙钟超时、30 秒采样 CPU 上限、512 MiB 采样 RSS 上限、4 MiB 日志上限，以及文件/总量/数量边界。CPU、内存和磁盘是监控后终止，不是硬配额。快速进程可能没有采样；回执保留实际零次或未知观测，不编造测量。

成功、非零退出、取消和 runner 拒绝都经现有环境探针回执记录。报告解析、身份和锁匹配失败保留已有真实进程回执；非零退出和无效报告保留原始 stdout/stderr、usage/admission。独立探针仍没有实验身份或持久化实验 provenance。

## 固定实验启动程序

Python start 的公开、owned 和存储合同一致：`engine: 'python'`、显式 `source: { kind: 'file', path }` 或冻结 Notebook 的 `source: { kind: 'notebook', notebookId, expectedHash, subsetVersion: 1 }`、必需 `sourceVersion: 1`、uint32 `seed`、`expectedEnvironmentHash`，以及声明的参数、参数列表和输入路径。runtime 只接受 `{ kind: 'python', selectionId, expectedHash }`。适配只接受已核验环境及本次只读输入、输出和临时目录。启动旗标固定为 `-I -S -B -X utf8 -c`；调用者不能传解释器旗标。环境 toolchainHash 绑定启动程序 SHA-256、旗标和执行合同版本。

启动程序先核对真实解释器报告，再将模块路径明确设为三个已核验标准路径及所选包目录。在用户源码和安装包执行前，首行 stdout 输出并 flush 启动报告。主进程严格核对报告、模块路径、绝对源码路径和种子；缺失或改变的报告拒绝结果，并保留真实日志、资源与准入回执。

源码以原始字节编译，保留编码声明，使用真实 `__main__` 模块字典运行。`sys.argv` 包含快照源码路径和声明参数。`roc_experiment` 模块提供 source_version、input_dir、input_paths、output_dir、scratch_dir、只读 parameters 和 seed。种子只初始化 Python `random`，不声称其他库或哈希随机性已固定。

实际计算复用统一 runner，仅输出和临时目录可写，不授予网络、GPU 或项目其他文件访问。非零退出、用户异常、超时、日志洪泛及资源拒绝保留原始结果。取消会回收完整进程树。

## 实验审计、复跑与发布

实验 service 冻结源码、声明输入和锁文件，输入身份包含源码版本与种子。计算前保存完整 `log/environment-code.json`，收到实际启动报告后保存 `log/python-startup.json`；`log/resources.json` 保留计算资源及准备、验证各一次真实环境探针。三个审计文件均不进入科学内容索引。

计算完成时重新核对原工作区输入和完整环境。相同 requestId 返回已有终态，不重新计算或探测，但仍核对原始输入；请求内容改变直接冲突。显式新 requestId 创建新运行。缺少版本、种子、选择身份或预览哈希的请求不能创建实验，错误预览身份不能开始计算。

发布逐字校验冻结文件，并离线核验代码清单、原环境身份、runtime、toolchain、启动程序及真实启动报告。报告必须绑定 run、project、input、environment、源码路径、版本、种子和模块路径；重写审计字段后重新计算文件 checksum 仍不能通过身份核验。非成功实验不能发布。已有冻结发布可在原工作区改变后核验，导出复制原始审计文件和哈希。

实验角色使用 `list_python_environments({ offset, limit })` 读取当前项目的用户选择，最多十条；返回选择 runtime、版本、记录时间、代码和锁文件身份。`inspect_experiment_environment({ runtime, offset, limit })` 调用实际环境预览，返回必需 `expectedEnvironmentHash` 和最多 8000 字符的分页报告。两个工具均绑定当前项目和有效阶段；迟到预览不能返回给已取消的阶段。空历史需要用户在项目管理中选择环境，模型不能打开原生选择面板、传用户 actor 或替换解释器路径。

随后 `start_experiment` 绑定真实 owner/project，`get_experiment` 查询自己的运行，`publish_experiment` 发布已完成结果供人工审核。其他阶段没有新增环境工具，原有冻结阶段快照不被改写；旧工具合同不能重新执行。

## 关闭、恢复与验证范围

关闭服务取消在途计算、等待完整进程树清理并保存 interrupted。启动恢复仅将 preparing/running 转为 interrupted，保留 owner、输入、环境和文件，不重探针或计算；缺失最终观测不补造。运行终态 exitCode:1 与资源回执 exitCode:null 的含义不同，不能把拒绝标记当真实解释器退出码。

同请求核对完整请求、项目、owner、原输入与任务关联后返回原终态。旧任务取消/中断仍可按原身份读取重放，新关联须为 active；新运行使用新 requestId和有效owner，中断运行不能发布。通用恢复与崩溃清理见[执行资源治理](research-execution-resources.md)。

已有专项覆盖所选CPython/标准venv、启动钩子与代码漂移、冻结输入/seed、真实资源边界、执行审计、关闭及磁盘快照恢复。对应测试曾使用CPython3.14.7，本次文档整理未重跑；不推及其他布局、Jupyter完整语义或科学正确性。检查入口见[验证说明](verification.md)。

## 官方资料

- [Python 3.14 启动选项](https://docs.python.org/3.14/using/cmdline.html)
- [Python 3.14 模块路径初始化](https://docs.python.org/3.14/library/sys_path_init.html)
- [Python 3.14 安装包元数据](https://docs.python.org/3.14/library/importlib.metadata.html)

实际 copied-binary 试验已证明 `._pth` 能在 `-I -S` 下请求 `import site` 并启动 `sitecustomize`，因此启动旗标需要主进程的预检和实际报告核验共同成立。
