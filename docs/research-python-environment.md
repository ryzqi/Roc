# Python 环境自动准备、预检与执行

Python 支持项目绑定的 CPython 3.14 环境、真实隔离探针、文件实验与冻结 Notebook 执行。主进程自动准备环境；项目管理仅显示准备状态和历史回执，不要求用户选择解释器或手写初始锁文件。统一实验生命周期见[科研实验运行](research-experiments.md)。

## 自动发现与项目绑定

`listPythonEnvironmentSelections({ projectId })` 为可写项目自动发现并核验 Python。同项目并发请求共用一次准备。发现顺序优先复用既有回执、项目 `.venv` / `venv`，然后检查用户 uv 安装目录、常见 macOS 安装目录和 PATH；Finder 启动不依赖 shell PATH。候选路径只来自主进程，不接受模型或渲染进程提供的解释器路径。未安装兼容 CPython 时返回明确错误，不弹出文件选择面板，也不下载或安装软件。

探针通过后，缺失的 `roc-python.lock.json` 根据实际 Python 版本和完整包集合自动创建；已存在的锁文件逐字保留并严格核验。无效锁文件直接失败。自动生成只使用独占创建，不覆盖并发写入。自动回执使用 `{ kind: 'system', id: 'roc-python-environment' }`，保留工作目录、实际路径、版本、完整环境身份、代码清单和锁文件哈希。身份未变时复用回执；代码变化后通过核验才记录新回执。旧用户回执仍可按原 ID 与哈希读取，不改写旧实验。

主进程的环境解析会重跑真实探针，核对工作目录和完整环境身份。历史回执不代表当前环境仍可用。归档项目和没有工作目录的项目只读取已有记录；项目释放和关闭应用取消未完成的准备，等待探针清理后释放服务。

`inspectExperimentEnvironment({ projectId, runtime: { kind: 'python', selectionId, expectedHash } })` 复用原实验环境 API。`expectedHash` 是回执的 `snapshotHash`；不接受解释器路径或 actor。预览重新解析项目绑定的环境，返回真实解释器、前缀、版本、完整包集合、锁文件和环境哈希。全部嵌套身份按当前 schema 解析再计算哈希，返回值可独立复算。Python 分支不请求 R/Julia 或 TypeScript 工具链，不创建实验记录。准入必须带相同项目；后台检查保留实际后台优先级。

## 当前环境合同

支持 macOS arm64 的独立 CPython 3.14 正式版及使用它的标准 venv。所选路径必须位于 `bin`，名称为 `python`、`python3` 或 `python3.14`；真实目标必须为 `bin/python3.14`。预检核验 thin arm64 Mach-O 可执行文件及 SHA-256。

主进程在启动解释器前检查所选和基础环境的 `bin`、`lib`，拒绝 `._pth` 和不支持的链接布局。标准 venv 必须有有界、普通的 `pyvenv.cfg`，声明正确的基础 `home`、3.14 版本及 `include-system-site-packages = false`。重复、缺失或未实现的配置项失败。基础环境和 `bin` 下的额外 `pyvenv.cfg` 不受支持。

选择的环境及基础环境的 `bin`、`lib` 都是显式代码根。代码根可能包含该环境自己的数据；项目目录和凭证目录没有因此获得读取权限。代码目录不能通过链接扩展到未声明目录。

## 锁文件

项目锁文件为普通、非链接的 `roc-python.lock.json`，上限 4 MiB；首次准备自动创建，也可使用项目已有锁文件：

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

两个扫描无法证明其间从未发生短暂修改。声明运行库中的可执行代码本身仍来自本机检测到的环境；元数据报告不证明科研结论正确。

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

发布逐字校验冻结文件，并离线核验代码清单、原环境身份、runtime、toolchain、启动程序及真实启动报告。报告必须绑定 run、project、input、environment、源码路径、版本、种子和模块路径；重写审计字段后重新计算文件 checksum 仍不能通过身份核验。非成功实验不能发布。已有冻结发布可在原工作区改变后核验。公开导出将审计日志保存为 `public_file_projection`，分别记录原文件的字节哈希/大小与投影摘要，不直接交付含本机路径的原始日志；见[公开投影边界](research-ro-crate.md#公开投影边界)。

实验角色使用 `list_python_environments({ offset, limit })` 自动准备当前项目环境，按最新优先返回至多十条记录，包含 runtime、版本、时间、代码和锁文件身份。`inspect_experiment_environment({ runtime, offset, limit })` 调用实际环境预览，返回必需 `expectedEnvironmentHash` 和最多 8000 字符的分页报告。两个工具均绑定当前项目和有效阶段；迟到预览不能返回给已取消的阶段。空历史自动初始化；模型不能传 actor 或解释器路径，不得要求用户选择环境。

随后 `start_experiment` 绑定真实 owner/project，`get_experiment` 查询自己的运行，`publish_experiment` 发布已完成结果供人工审核。其他阶段没有新增环境工具，原有冻结阶段快照不被改写；旧工具合同不能重新执行。

## 关闭与恢复

关闭服务取消在途计算、等待完整进程树清理并保存 interrupted。启动恢复仅将 preparing/running 转为 interrupted，保留 owner、输入、环境和文件，不重探针或计算；缺失最终观测不补造。运行终态 exitCode:1 与资源回执 exitCode:null 的含义不同，不能把拒绝标记当真实解释器退出码。

同请求核对完整请求、项目、owner、原输入与任务关联后返回原终态。旧任务取消/中断仍可按原身份读取重放，新关联须为 active；新运行使用新 requestId和有效owner，中断运行不能发布。通用恢复与崩溃清理见[执行资源治理](research-execution-resources.md)。

支持范围限于上述 CPython/标准 venv 布局及受控 Notebook 子集，不包含完整 Jupyter 语义。开发检查入口见[开发指南](development.md)；运行与来源校验不证明科学正确性。

## 官方资料

- [Python 3.14 启动选项](https://docs.python.org/3.14/using/cmdline.html)
- [Python 3.14 模块路径初始化](https://docs.python.org/3.14/library/sys_path_init.html)
- [Python 3.14 安装包元数据](https://docs.python.org/3.14/library/importlib.metadata.html)

启动旗标与主进程的 `._pth` 拒绝、控制文件预检及实际启动报告核验共同构成环境准入，不能仅凭 `-I -S` 推断所选环境可用。
