# Python 环境自动准备、预检与执行

Python 支持项目绑定的 CPython 3.14 环境、真实隔离探针、文件实验与冻结 Notebook 执行。主进程使用固定 uv 与 CPython 准备项目环境；项目管理显示进度、取消、重试和历史回执，不要求用户选择解释器或手写初始锁文件。统一实验生命周期见[科研实验运行](research-experiments.md)。

## 准备、状态与项目绑定

新建具有工作目录的项目及将想法提升为项目时，主进程启动后台准备；失败保留项目并记录环境操作状态。管理抽屉提供准备、取消和重试。`preparePythonEnvironment({projectId, requestId})` 返回持久化操作；同一请求 ID 幂等，已有活动操作不会重复启动。`getPythonEnvironmentStatus({projectId})`、`listPythonEnvironments({projectId})` 和 `getPythonEnvironment({projectId, environmentId, expectedHash})` 均为纯读取，不联网、不探测、不写项目文件。

准备使用 Roc 私有 `research-python` 根目录的固定 uv 与 CPython 下载缓存。发布清单记录版本、来源、字节大小和 SHA-256，并核验 arm64 可执行文件。项目未指定版本时固定为 Python 3.14.10；已有 `.python-version` 必须与受支持的精确运行时及 `requires-python` 相符，不会被默认版本覆盖。主进程不扫描 PATH、Homebrew 或用户全局 Python。

每次首次运行时安装使用 `attempts/<UUID>` 独立目录，并记录 owner。CPython 安装后的绝对路径保持不变；完整代码清单、固定二进制及真实隔离探针均通过后，原子发布指向该目录回执的符号链接。不同进程竞争发布时只接受一个已验证运行时，失败者只清理自己创建的目录。没有旧固定目录或旧回执的兼容读取。

主进程被 SIGKILL 时，未发布 attempt 不会成为成功缓存，也不会阻止新 attempt 重试。无法证明进程树已经退出的目录保留 owner 记录，不凭 PID 消失判断可以删除，不自动接管或清理未知/仍活动的树。正常失败和取消在确认子进程回收后清理本次目录；完整共享 runtime/cache 持久保留。

操作阶段为 queued、validating、downloading_runtime、creating_venv、resolving、syncing、verifying，终态为 ready、failed、cancelled 或 interrupted。ready 与不可变环境回执在同一数据库事务中保存；其 `environmentRef` 包含 projectId、environmentId、expectedHash。失败后的历史成功回执只供查阅，不能当作当前操作已成功。启动恢复把活动操作标记 interrupted，不自动继续联网。

`cancelPythonEnvironmentPreparation({projectId, operationId})` 等待准备进程树退出后返回。项目归档、删除、工作目录改变及应用关闭会取消准备并等待清理。按工作目录 realpath 的写租约覆盖整个准备过程，读租约覆盖实验或视觉检索的检查、计算及最终复核，防止包同步与计算交错。

`inspectExperimentEnvironment({projectId, runtime: {kind: 'python', environmentId, expectedHash}})` 重新核验精确回执，返回环境哈希，不安装或修复依赖。`expectedHash` 是回执的 snapshotHash；不接受解释器路径或 actor。历史回执不证明当前环境仍可用，代码或项目文件变化会使它失效。

## 当前环境合同

支持 macOS arm64 的独立 CPython 3.14 正式版及使用它的标准 venv。所选路径必须位于 `bin`，名称为 `python`、`python3` 或 `python3.14`；真实目标必须为 `bin/python3.14`。预检核验 thin arm64 Mach-O 可执行文件及 SHA-256。

主进程在启动解释器前检查所选和基础环境的 `bin`、`lib`，拒绝 `._pth` 和不支持的链接布局。标准 venv 必须有有界、普通的 `pyvenv.cfg`，声明正确的基础 `home`、3.14 版本及 `include-system-site-packages = false`。重复、缺失或未实现的配置项失败。基础环境和 `bin` 下的额外 `pyvenv.cfg` 不受支持。

选择的环境及基础环境的 `bin`、`lib` 都是显式代码根。代码根可能包含该环境自己的数据；项目目录和凭证目录没有因此获得读取权限。代码目录不能通过链接扩展到未声明目录。

## 项目声明与依赖锁

每个项目使用 `pyproject.toml`、`uv.lock`、`.python-version` 和独立 `.venv`。缺失的项目声明采用排他创建；已有声明逐字保留。初始依赖为空，不默认安装科学包。已有锁使用 `uv sync --locked`，过期锁明确失败，不自动重写。缺失锁由受控 `uv lock` 创建。

准备只接受受控 registry 的 wheel 依赖。git、URL、path、editable、动态依赖、自定义索引或 source/workspace 及需要源码构建的输入被拒绝。安装禁用项目与 workspace 安装、默认依赖组和 Python 自动下载，使用 Roc 私有缓存、copy 链接模式及固定运行时。有效环境先执行离线同步检查，只有需要同步时才访问 registry。不存在调用者自定义命令、环境变量或安装索引入口。

成功回执保存三个项目文件的 path/size/SHA-256，以及 managed runtime、实际解释器、metadataHash 和完整 codeHash。执行冻结这三个文件，普通运行不调用 uv、不联网、不安装依赖。当前合同不解码旧环境回执，也没有旧选择 API 别名。

探针通过 `importlib.metadata.distributions(path=[明确的 site-packages])` 读取完整包集合，不导入第三方源码。拒绝 `direct_url.json`、`.pth`、`.egg-link`、`.egg` 和 `.egg-info`。uv 自身的解释器查询会加载 site，因此准备器在调用它前额外检查已有 venv 的启动钩子、链接及代码身份。

失败仅回收本次排他创建且身份未变化的临时文件与目录；已有用户环境保留。下载暂存和 job 目录在进程退出后清理，已验证的共享 runtime/cache 是长期缓存。

## 实际启动与身份

固定探针使用 `-I -S -B -X utf8 -c`，保留所选 venv 的解释器路径。验收核对实际 CPython 正式版本、平台、架构、解释器、前缀、基础前缀、三个标准模块路径、隔离旗标和未加载 `site`。

主进程先冻结全部声明代码树的字节、权限、成员及链接拓扑，再启动探针；返回后重新检查代码、所选解释器控制和锁文件。环境身份包括探针源码、实际报告、代码清单及控制/锁文件身份。只更改 native 包二进制，即使大小、时间戳、包元数据和锁文件不变，也会改变身份。探针期间持续存在的漂移拒绝本次结果。

两个扫描无法证明其间从未发生短暂修改。声明运行库中的可执行代码本身仍来自已核验的项目环境；元数据报告不证明科研结论正确。

探针同时返回完整 Python 代码回执，使用统一的锁文件、控制和报告定义。回执包含实际代码清单及原始环境身份对象；离线验证核对清单哈希、元数据哈希、声明代码根、真实解释器文件哈希和实际启动路径。改写文件清单后重新计算清单哈希仍不能保留原环境身份；重新计算元数据哈希也不能掩盖解释器和启动路径之间的不一致。

## 进程边界与观测

实际调用复用 `runResearchProcess` 的项目准入、独立监督程序、Seatbelt、进程组回收和资源监控。只提供固定的 `PATH`、`LANG`、本次 `TMPDIR`；读取范围为代码根及 venv 控制文件，写入范围仅为本次探针目录。GPU 不授予，网络为 `none`。

探针声明 60 秒墙钟超时、30 秒采样 CPU 上限、512 MiB 采样 RSS 上限、4 MiB 日志上限，以及文件/总量/数量边界。CPU、内存和磁盘是监控后终止，不是硬配额。快速进程可能没有采样；回执保留实际零次或未知观测，不编造测量。

成功、非零退出、取消和 runner 拒绝都经现有环境探针回执记录。报告解析、身份和锁匹配失败保留已有真实进程回执；非零退出和无效报告保留原始 stdout/stderr、usage/admission。独立探针仍没有实验身份或持久化实验 provenance。

## 固定实验启动程序

Python start 的公开、owned 和存储合同一致：`engine: 'python'`、显式 `source: { kind: 'file', path }` 或冻结 Notebook 的 `source: { kind: 'notebook', notebookId, expectedHash, subsetVersion: 1 }`、必需 `sourceVersion: 1`、uint32 `seed`、`expectedEnvironmentHash`，以及声明的参数、参数列表和输入路径。runtime 只接受 `{ kind: 'python', environmentId, expectedHash }`。适配只接受已核验环境及本次只读输入、输出和临时目录。启动旗标固定为 `-I -S -B -X utf8 -c`；调用者不能传解释器旗标。环境 toolchainHash 绑定启动程序 SHA-256、旗标和执行合同版本。

启动程序先核对真实解释器报告，再将模块路径明确设为三个已核验标准路径及所选包目录。在用户源码和安装包执行前，首行 stdout 输出并 flush 启动报告。主进程严格核对报告、模块路径、绝对源码路径和种子；缺失或改变的报告拒绝结果，并保留真实日志、资源与准入回执。

源码以原始字节编译，保留编码声明，使用真实 `__main__` 模块字典运行。`sys.argv` 包含快照源码路径和声明参数。`roc_experiment` 模块提供 source_version、input_dir、input_paths、output_dir、scratch_dir、只读 parameters 和 seed。种子只初始化 Python `random`，不声称其他库或哈希随机性已固定。

实际计算复用统一 runner，仅输出和临时目录可写，不授予网络、GPU 或项目其他文件访问。非零退出、用户异常、超时、日志洪泛及资源拒绝保留原始结果。取消会回收完整进程树。

## 实验审计、复跑与发布

实验 service 冻结源码、声明输入和锁文件，输入身份包含源码版本与种子。计算前保存完整 `log/environment-code.json`，收到实际启动报告后保存 `log/python-startup.json`；`log/resources.json` 保留计算资源及准备、验证各一次真实环境探针。三个审计文件均不进入科学内容索引。

计算完成时重新核对原工作区输入和完整环境。相同 requestId 返回已有终态，不重新计算或探测，但仍核对原始输入；请求内容改变直接冲突。显式新 requestId 创建新运行。缺少版本、种子、环境身份或预览哈希的请求不能创建实验，错误预览身份不能开始计算。

发布逐字校验冻结文件，并离线核验代码清单、原环境身份、runtime、toolchain、启动程序及真实启动报告。报告必须绑定 run、project、input、environment、源码路径、版本、种子和模块路径；重写审计字段后重新计算文件 checksum 仍不能通过身份核验。非成功实验不能发布。已有冻结发布可在原工作区改变后核验。公开导出将审计日志保存为 `public_file_projection`，分别记录原文件的字节哈希/大小与投影摘要，不直接交付含本机路径的原始日志；见[公开投影边界](research-ro-crate.md#公开投影边界)。

实验角色先调用 `prepare_python_environment({requestId})`，使用 `get_python_environment_status({})` 等待 ready，并从 operation.environmentRef 取得精确环境引用。`cancel_python_environment({operationId})` 只能取消当前运行自己发起的准备，不能取消人工、系统或其他运行的操作。所有写入经过当前项目和 active owner 的前后核验，节点取消也会取消自己的准备。

`list_python_environments({offset, limit})` 只读返回至多十条历史回执，最新优先。`inspect_experiment_environment({runtime, offset, limit})` 返回必需 expectedEnvironmentHash 和最多 8000 字符的分页报告；迟到结果不会返回给已取消阶段。模型不能传 actor 或解释器路径。

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
