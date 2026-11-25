# P2：Python 3.14 与 uv 项目环境验收

验收日期：2026-11-25。范围为《科研工具优化》P2，以及它依赖的原生进程监督修复。当前状态：**Verified passing（本机 P2 验收）**。实际项目准备 9/9、运行时安装 3/3、生产 Electron 1/1、相关单元合同 58/58 通过；保留首次科学包导入耗时波动这一限制。

本报告描述已实现合同和已执行检查，不代替[Python 环境合同](research-python-environment.md)与[执行资源治理](research-execution-resources.md)。OCR 8-bit 模型、PyTorch/MLX 对齐、200 页及 CDM/TEDS 完整质量验收属于后续阶段，不由本报告验收。

## 产品与安装合同

新建具有工作目录的项目、将想法提升为项目时，由主进程后台准备环境。人工可以在现有管理界面准备、重新核验、取消、重试并查看历史。准备、状态和取消均绑定项目；公开引用为 `environmentId + expectedHash`，不接受解释器路径、actor 或调用者伪造的代码哈希。旧选择 API 和旧回执解码已移除，没有兼容别名。

- uv 固定为 0.13.9；新项目默认 CPython 3.14.10、macOS arm64。解释器和工具在 Roc 数据根下的私有 `research-python` 中管理，核验发布清单、字节大小、SHA-256 和实际可执行架构，不扫描 PATH、Homebrew 或用户全局 Python。
- 项目有独立 `.venv`，共享 Roc 管理的下载缓存。项目必须拥有 `pyproject.toml`、`uv.lock`、`.python-version`；缺失声明采用排他创建，已有声明保留原字节。当前发布清单只有 3.14.10；已有不受支持的精确补丁版本明确失败，不静默升级。
- `uv.lock` 缺失时受控创建；已有锁通过 `uv sync --locked` 使用，过期锁不被重写。默认依赖为空；科学包兼容性测试使用单独项目。
- 只接受固定 PyPI registry 的 wheel 依赖。直接 URL、git、path、editable、动态依赖、依赖组、自定义索引、uv source/workspace 配置及需要源码构建的输入被拒绝。禁用项目/workspace 安装、源码构建、自动 Python 下载及默认依赖组，使用 copy 链接模式。
- 可复用环境先离线检查；完整缓存可离线同步其他项目。安装网络权限只在需要时授予。Seatbelt 本身不按域名过滤；固定 CLI 索引和声明/锁文件校验共同限制来源，不能把 `registry` 表述为内核域名白名单。
- uv 的解释器发现会加载 `site`，因此调用 uv 前检查现有环境的 `.pth`、egg、启动自定义钩子和越界链接。普通实验用 `-I -S -B -X utf8` 直接运行项目解释器，无隐式同步、无网络、无安装。

环境回执保存三个项目文件的 path/size/SHA-256、managed runtime 身份、实际解释器、完整包集合、metadataHash 和 codeHash。`uv.lock` 不替代已安装代码完整性检查。准备持有 realpath 写租约；实验与视觉计算从预检至最后身份复核持有读租约，同目录的项目别名共享租约。读状态与历史不安装、不探测、不修复文件。

人工准备/取消要求主进程绑定窗口与项目。Agent 准备绑定 active owner，取消仅作用于自己创建的操作；取消会等待进程退出。成功状态和不可变回执在同一数据库事务保存。失败、取消、中断均保留可读状态，历史成功回执不能证明当前操作已经成功。数据库操作恢复不自动联网或继续准备。

## 已执行检查

以下命令的工作目录均为仓库根 `/Users/Apple_501/Desktop/Roc/Roc`。`ROC_TEST_PYTHON_ARCHIVES` 使用本地已按固定清单验证的 `uv.tar.gz` 与 `python.tar.gz`，避免每个测试重复下载；它不替换 uv、CPython、Seatbelt、实际项目安装或执行。通过结果对应所列日志和源码身份；最后一节说明已修复问题及剩余边界。

| 检查与精确命令 | 结果 | 证据及覆盖 |
| --- | --- | --- |
| `ROC_TEST_PYTHON_ARCHIVES="$PWD/.runtime/research-toolchain-p2-probe" node --test tests/integration/research-python-runtime-recovery.test.mjs` | 3/3 | [runtime-recovery.json](../.artifacts/research-toolchain-p2/runtime-recovery.json)；42.77 秒。真实宿主 SIGKILL、实际 Python/guard 退出、遗留目录保留、新目录重试与离线复用；两个独立宿主通过同步屏障竞争发布；三种清理不确定错误保留 own attempt/job。 |
| `node --test tests/unit/research-python-runtime-recovery.test.mjs` | 2/2 | 普通下载失败仅清理本次目录，连续重试成功进入新 attempt；未知目录/活跃 owner/旧空锁保留，拒绝旧回执和逃逸/符号链接的发布目标。 |
| `ROC_TEST_PYTHON_ARCHIVES=.runtime/research-toolchain-p2-probe node --test tests/integration/research-python-runtime-store.test.mjs` | 3/3 | [runtime-store-final.log](../.artifacts/research-toolchain-p2/runtime-store-final.log)；固定版本安装、离线复用和损坏拒绝。 |
| `node --test tests/integration/research-python-environment.test.mjs` | 13/13 | [probe-cleanup-green.log](../.artifacts/research-toolchain-p2/probe-cleanup-green.log)；真实探针、漂移、越界、取消，以及监督错误下工作文件保留。 |
| `pnpm typecheck` | 通过 | runtime-store 最终目录身份检查及失败清理修改后执行。 |
| `pnpm build` | 通过 | [build-probe-cleanup.log](../.artifacts/research-toolchain-p2/build-probe-cleanup.log)；包含技能校验、TypeScript、Electron 构建和 renderer chunk 检查。 |
| `pnpm check:ipc` | 通过 | [check-ipc-final.log](../.artifacts/research-toolchain-p2/check-ipc-final.log)；生成 API 与声明一致。 |
| `ROC_TEST_PYTHON_ARCHIVES=.runtime/research-toolchain-p2-probe node --test tests/integration/research-python-project-preparation.test.mjs` | 9/9 | [project-preparation-final.log](../.artifacts/research-toolchain-p2/project-preparation-final.log)、[实际结果](../.artifacts/research-toolchain-p2/project-preparation.json)；真实 3.14.10、uv、新建/复用、科学包计算、另一项目离线同步、取消保留用户文件、版本拒绝、已有代码变化拒绝和无回执环境重装。还覆盖两次离线检查后的代码漂移拒绝及进程清理不确定时保留本次文件。 |
| `node --test tests/integration/research-python-preparation.test.mjs tests/integration/research-python-automatic.test.mjs` | 15/15 | [preparation-all-final.log](../.artifacts/research-toolchain-p2/verification/preparation-all-final.log)；纯读、后台状态、权限与路径注入、幂等、项目归档/路径替换、取消、磁盘恢复。安装部分为 fixture，检查使用真实隔离 CPython；不能代替上一行真实安装验收。 |
| `node --test tests/unit/research-python-leases.test.mjs tests/unit/research-python-preparation-lifecycle.test.mjs tests/unit/research-experiment-environment-tools.test.mjs tests/unit/research-current-execution-contracts.test.mjs tests/unit/visual-retrieval.test.mjs tests/unit/research-stage-readiness.test.mjs tests/unit/research-schema-migration.test.mjs` | 58/58 | [p2-current-contracts.log](../.artifacts/research-toolchain-p2/verification/p2-current-contracts.log)；独立复查时重跑，覆盖共享读/排队写租约、取消等待、禁止迟到 ready、owner 隔离、目录别名、纯恢复、工具合同和视觉资源生命周期。安装与部分运行适配为 fixture。 |
| `node --test tests/renderer/python-environment.test.mjs tests/renderer/research-tasks.test.mjs` | 35/35 | [ui-final.log](../.artifacts/research-toolchain-p2/verification/ui-final.log)；含 7 项 Python 管理测试、键盘准备/取消、轮询终止、重试、切换项目、只读项目、浅深色与窄布局。 |
| `node --test tests/renderer/experiment-results.test.mjs` | 12/12 | [result-ui.log](../.artifacts/research-toolchain-p2/verification/result-ui.log)；真实计算结果与证据读取、键盘交互。 |
| `node --test tests/integration/research-visual-process.test.mjs` | 3/3 | [visual-tests.log](../.artifacts/research-toolchain-p2/verification/visual-tests.log)；真实隔离 Python 进程、启动身份拒绝、结果校验与取消后清理。该测试不证明生产视觉模型质量。 |
| `ROC_TEST_PYTHON_ARCHIVES=.runtime/research-toolchain-p2-probe node --test tests/integration/research-python-preparation-electron.test.mjs` | 1/1 | [electron-current.log](../.artifacts/research-toolchain-p2/verification/electron-current.log)；真实生产 Electron、预热私有运行时、创建项目自动准备、键盘重新核验、路径注入拒绝、精确回执重放和重启后恢复。 |
| `node scripts/research/build-process-guard.mjs` | 成功 | 重建并签名锁定 arm64 原生监督程序；源码 SHA-256 为 `86daed36e5891edb747251d9fce78cdcad87b19387066aad3ba7e9dfb9c23514`。 |
| `node --test tests/unit/research-process-guard.test.mjs tests/integration/research-process-guard.test.mjs` | 2/2 | [native-guard-green.log](../.artifacts/research-toolchain-p2/verification/native-guard-green.log)；源码/二进制锁一致，2048 次实际启动、32 并发保留输出和退出状态。 |
| `node --test tests/integration/research-process-resources.test.mjs tests/integration/research-python-experiments.test.mjs` | 43/43 | [guard-regressions.log](../.artifacts/research-toolchain-p2/verification/guard-regressions.log)；24 项资源/权限/进程树测试及 19 项真实 Python/Notebook 冻结、执行、取消、恢复、发布和负结果输出测试。 |
| `node --check tests/integration/research-process-guard.test.mjs`、`git -c core.whitespace=-blank-at-eof diff --cached --check` | 通过 | guard 回归脚本语法及提交前差异检查。冻结的 v75 SQL 保留原始结尾空行和哈希；其余空白检查通过。 |

其他已有日志：[lower-errors-recheck.log](../.artifacts/research-toolchain-p2/lower-errors-recheck.log) 20/20，覆盖实际探针的包/控制/锁漂移与 installer 参数、路径和网络边界；[installer-boundary.json](../.artifacts/research-toolchain-p2/installer-boundary.json) 保留真实 uv/CPython 调用回执。历史完整调用命令未恢复，故不把推测的命令列为已执行命令。

科学包验收实际安装了 NumPy 2.5.5、Pandas 3.1.1、SciPy 1.18.1、scikit-learn 1.9.1；无网络计算得到均值 4、拟合斜率约 2、行列式 6。它证明这些固定样本可在本机受控环境运行，不代表全部包、算法或平台兼容。资源是采样观测后终止，不是内核硬配额；快速进程的零采样保持为零，不补造 CPU/RSS。

## 实际 Electron 与界面证据

生产 Electron 测试使用独立数据根，运行真正的创建项目与准备服务。测试先验证 ready 后截图；浅色与深色截图均已人工检查，Python 版本、两条历史回执、完整解释器路径和重新核验按钮可见。

- [生产 Electron：浅色](../.artifacts/research-toolchain-p2/electron-preparation/light.png)
- [生产 Electron：深色](../.artifacts/research-toolchain-p2/electron-preparation/dark.png)
- [紧凑布局与键盘焦点：浅色](../.artifacts/research-toolchain-p2/ui-python/light.png)
- [紧凑布局与键盘焦点：深色](../.artifacts/research-toolchain-p2/ui-python/dark.png)

截图不证明 Finder 启动或默认用户数据根迁移成功；本次没有用它替代打包安装与真实用户配置验证。早先 `active-*.png` 是准备中的画面，不能代替上述 ready 终态截图。

## 项目准备性能测量

已执行命令：

```sh
ROC_TEST_PYTHON_ARCHIVES=.runtime/research-toolchain-p2-probe node scripts/benchmark-python-project-preparation.mjs .artifacts/research-toolchain-p2/python-preparation-benchmark-final.json 5
```

结果见 [python-preparation-benchmark-final.json](../.artifacts/research-toolchain-p2/python-preparation-benchmark-final.json) 与 [日志](../.artifacts/research-toolchain-p2/python-preparation-benchmark-final.log)。主机为 Apple M1 Pro、10 逻辑核心、32 GiB 内存，Darwin 27.2.0、Node 26.13.1。测量时间为 `2026-11-25T11:55:30.274Z`；JSON 记录 Git `0ef1213c2797e8b6b171bea9edbb9cd0e47c0770`、`trackedDirty: true` 与相关源码哈希。测量包含 guard、运行时恢复和代码漂移修复；随后仅补充探针在进程回收不确定时保留目录的异常路径，性能未重新采样，不能宣称测量源码与最终提交逐字相同。

| 操作 | 样本数 | P50 / ms | P95 / ms | 范围 / ms |
| --- | ---: | ---: | ---: | ---: |
| 首次完整准备一个空项目 | 5 | 12659.31 | 13537.36 | 11998.06–13537.36 |
| 再次核验并复用该项目 | 5 | 10869.67 | 11417.74 | 10542.13–11417.74 |
| 私有运行时初始化（本地已验证归档） | 1 | 不适用 | 不适用 | 9086.94 |

空项目样本共享已经初始化的 runtime/cache。首次项目准备包含声明、锁、`.venv`、uv 检查、完整代码身份与实际探针；再次准备仍做完整身份检查。两组均无科学包下载，全部项目进程调用为 `network: none`。数据库 fixture 和模块加载不在计时区间；操作轮询最多引入约 10 ms。文件系统缓存为暖状态，未隔离主机其他工作，5 样本的 P95 即样本最大值。

[P0](research-toolchain-baseline.md) 测量的是外部创建空 `.venv`（P50 40.16 ms）、旧产品首次检查（1727.74 ms）和重复检查（1718.79 ms）；P2 测量整个新产品准备流程，Python 补丁版本也不同。**不能用约 12.7 秒／10.9 秒与 P0 直接相减，宣称发生性能回归或提升。**下载首装、科学包项目和物理冷缓存性能尚未单独验收。脚本拒绝覆盖已有输出；旧阶段测量文件仍保留。

## 原生启动故障与修复证据

实际 Notebook 负结果测试曾丢失先前 stdout，报 `research_python_startup_report_invalid`。最小真实 Python 压力循环捕获了原生子进程 exit 125、stdout/stderr 为空。进一步移除 Python，只运行锁定 guard → sandbox-exec → shell，以 32 并发复现父子同时 `setpgid` 的 EPERM；失败时目标进程组已经被另一侧正确建立，门管道中断没有得到该故障的证据支持。

正式回归在修复前 2048 次启动中失败 3 次，修复后 2048 次全部通过。修复让父监督进程在释放 gate 前唯一负责建立进程组，子进程通过 gate 后验证自身组身份；不忽略 EPERM。组建立、watch、gate 和 exec 失败保留明确阶段及 errno。源码与锁定二进制同步更新，二进制 SHA-256 为 `ae30e4629420f38fd259c82582b64990feec77be8a77c23ea2f5281a20324237`，提交为 `b312744`。

- [修复前正式压力结果](../.artifacts/research-toolchain-p2/native-guard-startup-51cce6c74fa7b26bea583a014093e1c852cb92a9cf335cf8f764f422c5653e61.json)
- [修复后正式压力结果](../.artifacts/research-toolchain-p2/native-guard-startup-ae30e4629420f38fd259c82582b64990feec77be8a77c23ea2f5281a20324237.json)
- [失败分支与进程组诊断](../.artifacts/research-toolchain-p2/guard-native-debug-detailed.json)
- [原始 Python 场景复测：200 次、4 并发无失败](../.artifacts/research-toolchain-p2/python-output-fixed-stress.json)

回归已加入 `pnpm test:research-resources`。临时诊断 C、二进制和 Python 压力脚本已清理，保留上述证据及正式回归。原始 Python 临时脚本已删除，其 JSON 属于一次性诊断证据；可持续运行的入口是正式 native guard 和 Python/Notebook 集成测试。

## 修复结果与限制

1. **私有 runtime 崩溃恢复已验证通过。**原实现的真实宿主 SIGKILL 回归先得到 `research_python_runtime_preparation_incomplete`。现实现为每次安装创建 `attempts/<UUID>` 固定路径及 owner 记录，完成隔离探针与全量代码校验后原子发布符号链接，绝不移动已安装 CPython 的绝对 prefix。两个宿主竞争发布只保留一个 winner；正常失败只清理本次 inode/dev 一致的目录。SIGKILL 以及 `research_process_kill_failed`、`research_process_supervision_failed`、`research_process_completion_failed` 的目录和 job 保留，不凭 owner PID 消失推断树已安全退出。重试新建目录，未发布半成品既不复用也不阻塞；未知和仍活动树不会被接管或删除。无旧布局/旧回执兼容。真实回归 3/3、单元回归 2/2、TypeScript 通过，命令与证据见上表。任务隔离临时根已清理。
2. **准备后半段代码漂移已拒绝。**正常准备并获得 codeHash 后，在复用路径任一次 `uv sync --offline --check` 成功后新增模块，最终核验拒绝而不重新签署。正式项目准备测试同时覆盖首次和最终检查后的变化，9/9 通过。修复前证据保留在 [review-late-code-change.json](../.artifacts/research-toolchain-p2/review-late-code-change.json)。
3. **科学包首次导入存在 macOS 签名验证延迟。**早先 60 秒超时中 CPU 仅约 3 秒；逐导入输出定位至原生库加载，系统 `sample` 的 1714 个主线程样本中 1590 个位于 dyld 映射/`fcntl` 签名验证。新环境不加 Seatbelt 的直接运行也曾超过 60 秒；复用后约 3 秒。另一次冷加载诊断完成于 30.30 秒，复用为 3.19 秒。完整项目验收仍使用原有 60 秒计算上限并通过，科学包测试总时长 70.02 秒包含安装。没有扩大权限、修改签名或提高生产超时；本次通过不保证每次首次导入都在 60 秒内。证据见 [冷加载测量](../.artifacts/research-toolchain-p2/science-timeout-probe-cold-measure.json)、[直接运行对照](../.artifacts/research-toolchain-p2/science-timeout-probe-direct-first.json)及[原生采样](../.artifacts/research-toolchain-p2/science-import-native-sample.txt)。临时诊断脚本与其测试根已清理。
4. **探针清理保留规则已补全。**外层准备和内层探针均在进程树回收无法证明时保留工作文件；普通取消仍清理。回归先复现 `ENOENT`，再验证三种监督错误保留证据文件。见 [修复前](../.artifacts/research-toolchain-p2/probe-cleanup-red.log)及[完整探针回归](../.artifacts/research-toolchain-p2/probe-cleanup-green.log)。该错误分支测试使用注入监督错误，实际进程取消由同一集成套件验证。
5. **数据库切换。**Research schema 76 使用新准备操作和回执表；离线 v71–75 → v76 对孤立 R/Julia 历史执行用户授权的删除，拒绝其他历史丢失、产物引用和 Agent 跨库引用。五个旧 schema 的真实 Electron 候选启动、发布与数据完整性已验收，见 [schema-v76-acceptance.json](../.artifacts/research-toolchain-p2/schema-v76-acceptance.json)。默认 `~/.roc` 用户库未迁移或删除；安装新包前仍需按[离线迁移流程](database-storage.md)处理其版本。
6. **边界。**读写租约只协调同一 Roc 主进程的参与者，不能阻止外部工具写项目目录；前后身份扫描也不能证明两次扫描之间从未出现短暂修改。已记录的环境和资源身份不证明科研结论正确。P2 不宣称支持任意 Python 3.14 补丁、自定义构建后端或完整 Jupyter。
