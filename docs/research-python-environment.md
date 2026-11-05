# Python 环境预检与隔离探针

PR08 当前提供环境预检、真实隔离探针，以及主进程确认的原生环境选择与项目绑定。项目管理的任务区已提供选择入口；新建 Python 实验、运行及发布尚未启用。

## 用户选择与项目绑定

`selectPythonEnvironment({ projectId, requestId })` 只接受项目与请求身份。解释器路径由主进程的原生单文件面板返回，调用身份由真实 IPC sender 绑定；模型参数不能提供路径或用户 actor。面板使用 `noResolveAliases` 保留 venv 的解释器链接，随后执行下述预检和隔离探针。取消返回 `null`，失败不会保存成功回执，也不会安装或修复环境。

数据库迁移 42 新增项目环境回执，不改写旧实验。每次成功选择保留独立 ID、原始请求、真实窗口 actor、工作目录、所选路径与真实解释器、版本、平台、完整环境身份、代码清单哈希及锁文件身份。同请求只读重放；另一个窗口不能重放原选择，新选择使用新请求。读取必须提供项目、选择 ID 和原始回执哈希。存储损坏、缺失回执、跨项目和错误哈希均失败。

主进程的环境解析会重跑真实探针，并核对原始工作目录和完整环境身份。历史回执的读取不意味着当前环境仍可用；版本、包代码、控制或锁文件变化需要新的显式选择。归档、项目释放和关闭应用会取消未完成的选择，等待探针清理后再释放服务。

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

探针通过 `importlib.metadata.distributions(path=[明确的 site-packages])` 读取元数据，不导入包源码和入口点，也不将包目录加入自身的 `sys.path`。初版拒绝所有 `direct_url.json` 安装、`.pth`、`.egg-link`、`.egg` 和 `.egg-info`，不解释 editable、路径依赖或旧式启动语义。没有安装、下载或修复依赖的分支。

## 实际启动与身份

固定探针使用 `-I -S -B -X utf8 -c`，保留所选 venv 的解释器路径。验收核对实际 CPython 正式版本、平台、架构、解释器、前缀、基础前缀、三个标准模块路径、隔离旗标和未加载 `site`。

主进程先冻结全部声明代码树的字节、权限、成员及链接拓扑，再启动探针；返回后重新检查代码、所选解释器控制和锁文件。环境身份包括探针源码、实际报告、代码清单及控制/锁文件身份。只更改 native 包二进制，即使大小、时间戳、包元数据和锁文件不变，也会改变身份。探针期间持续存在的漂移拒绝本次结果。

两个扫描无法证明其间从未发生短暂修改。声明运行库中的可执行代码本身仍来自用户选择的环境；元数据报告不证明科研结论正确。

## 进程边界与观测

实际调用复用 `runResearchProcess` 的项目准入、独立监督程序、Seatbelt、进程组回收和资源监控。只提供固定的 `PATH`、`LANG`、本次 `TMPDIR`；读取范围为代码根及 venv 控制文件，写入范围仅为本次探针目录。GPU 不授予，网络为 `none`。

探针声明 60 秒墙钟超时、30 秒采样 CPU 上限、512 MiB 采样 RSS 上限、4 MiB 日志上限，以及文件/总量/数量边界。CPU、内存和磁盘是监控后终止，不是硬配额。快速进程可能没有采样；回执保留实际零次或未知观测，不编造测量。

成功、非零退出、取消和 runner 拒绝都经现有环境探针回执记录。报告解析、身份和锁匹配失败保留已有真实进程回执；非零退出和无效报告保留原始 stdout/stderr、usage/admission。独立探针仍没有实验身份或持久化实验 provenance。

## 验证

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。实际环境为已安装的 CPython 3.14.7，不代表用户已选定该环境用于产品执行。

- `node --test tests/integration/research-python-environment.test.mjs`：真实 venv 探针、固定身份重复、包源码/启动钩子未导入、文件/网络/凭证边界、完整锁集合、editable/旧启动形式拒绝、重复/损坏元数据、真实 native 字节变动、探针后漂移、取消和无效报告。
- `node --test tests/unit/research-python-controls.test.mjs tests/unit/research-environment-probe-resources.test.mjs tests/unit/research-native-code.test.mjs tests/unit/research-experiment-resources.test.mjs tests/unit/research-current-execution-contracts.test.mjs`：20/20。
- `pnpm test:unit`：1172/1172，无跳过。
- `pnpm build`：类型检查及构建通过。
- `node scripts/run-research-p0.mjs`：13/13。
- `pnpm check:ipc`、`pnpm check:renderer-chunks`：通过，renderer 入口 1132907 bytes / 6 files。
- `node scripts/smoke-electron.mjs`：13/13，零 renderer errors。

初轮真实测试 5/8：两个测试错误地要求短进程一定有采样，一个测试假定此发行版的内建 `zlib` 有 `__file__`。改为将完整回执与独立捕获的真实 runner 结果逐项核对，并使用实际 `_dbm` 原生文件；保留全部边界、漂移和失败断言。修正后的 10 项通过，初轮日志保留。

完整运行日志位于 `.artifacts/research-optimization/pr08-a2-*.log`，最终实际回执为 `pr08-a2/python-environment.json`。Python 实验复跑/恢复/发布及完整 PR08 验收尚未完成。

项目选择增量从同一工作目录验证：

- `node --test tests/integration/research-python-selection.test.mjs`：9/9，真实 Python 探针、精确身份、无授权/跨项目拒绝、原生选择取消、环境变化、探针期间项目变化、真实解释器就绪后取消、损坏存储、DB41 升级及磁盘重开。
- `node --test tests/integration/research-python-selection-electron.test.mjs`：1/1，生产 Electron 的真实 preload、主窗口 actor、面板父窗口与链接选项、实际 CPython 核验、同请求只读重放、取消和重启读取。OS 面板返回值由测试替换，不代表用户已经在产品里选择环境。
- `pnpm build`：类型检查与构建通过。

项目选择增量的最终全量检查：`pnpm test:unit` 1172/1172，无跳过，357103 ms；`node scripts/run-research-p0.mjs` 13/13；`pnpm check:ipc` 与 `pnpm check:renderer-chunks` 通过，入口 1132907 bytes / 6 files；`node scripts/smoke-electron.mjs` 13/13，零 renderer errors。

选择日志为 `.artifacts/research-optimization/pr08-a3-*.log`，实际回执位于 `pr08-a3/python-selection.json` 与 `pr08-a3-electron/receipt.json`。此段仍未启用 Python 实验。

管理入口增量从同一工作目录验证：

- `node --test tests/renderer/python-environment.test.mjs`：6/6，键盘选择、真实 pending、取消、失败、主进程历史重读、项目切换、只读和读取失败状态。最终浅色/深色 480 × 680 窗口的长路径、焦点、hover、展开和动效落点检查通过；裁切回执均为 `cut=0, hidden=0`。
- `node --test tests/integration/research-python-selection-electron.test.mjs`：1/1，真实生产管理入口经 Enter、preload、真实窗口 actor、原生面板接口和实际 CPython 探针保存回执，取消保持原历史，重启精确读取。仅 OS 面板返回值被替换。
- `pnpm build`、`pnpm check:ipc`、`pnpm check:renderer-chunks`：通过，入口 1132907 bytes / 6 files。
- `node scripts/smoke-electron.mjs`：13/13，零 renderer errors。
- `pnpm test:renderer`：310/312，无跳过，416575 ms；会话 prepend 的可见锚点从 -9px 移至 15px，质量评价保存等待超过 10 秒。使用 `node --test --test-name-pattern='rendered transcript keeps' tests/renderer/lifecycles.test.mjs` 和 `node --test --test-name-pattern='explicit domain and overall' tests/renderer/review-quality-assessment.test.mjs` 原样分别复现，两项均通过。未改这两项代码或断言；并发全量失败根因仍未确认，不能声称全量 renderer 通过。

日志位于 `.artifacts/research-optimization/pr08-a3b-*.log`；最终界面截图和裁切回执位于 `pr08-a3b-ui/`，生产管理入口回执和双主题截图位于 `pr08-a3b-electron/`。

## 官方资料

- [Python 3.14 启动选项](https://docs.python.org/3.14/using/cmdline.html)
- [Python 3.14 模块路径初始化](https://docs.python.org/3.14/library/sys_path_init.html)
- [Python 3.14 安装包元数据](https://docs.python.org/3.14/library/importlib.metadata.html)

实际 copied-binary 试验已证明 `._pth` 能在 `-I -S` 下请求 `import site` 并启动 `sitecustomize`，因此启动旗标需要主进程的预检和实际报告核验共同成立。
