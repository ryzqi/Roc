# Python 环境预检与隔离探针

PR08 当前完成范围是环境预检和真实隔离探针。它们不构成用户选择环境的授权，也没有启用新建 Python 实验。可信原生选择、项目绑定、运行及发布仍需后续接入。

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

完整运行日志位于 `.artifacts/research-optimization/pr08-a2-*.log`，最终实际回执为 `pr08-a2/python-environment.json`。用户选择、Python 实验复跑/恢复/发布及完整 PR08 验收尚未完成。

## 官方资料

- [Python 3.14 启动选项](https://docs.python.org/3.14/using/cmdline.html)
- [Python 3.14 模块路径初始化](https://docs.python.org/3.14/library/sys_path_init.html)
- [Python 3.14 安装包元数据](https://docs.python.org/3.14/library/importlib.metadata.html)

实际 copied-binary 试验已证明 `._pth` 能在 `-I -S` 下请求 `import site` 并启动 `sitecustomize`，因此启动旗标需要主进程的预检和实际报告核验共同成立。
