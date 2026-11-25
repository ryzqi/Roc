# 科研执行资源治理

科研计算共用 `runResearchProcess`、主进程计算准入、macOS Seatbelt、进程组监督及资源监测。只接受离线 `networkAccess: 'none'`；模型与依赖下载是独立准备操作。

## 准入与权限

全局最多 2 个计算、每项目 1 个、解析 1 个、显式允许 GPU 的计算 1 个。调用方声明真实 projectId、user/background 优先级与类别；共享文献操作明确为全局范围，不按路径推断项目。

队列上限 256，按可执行顺序选取，满额项目不阻塞其他项目。最早可执行后台请求最多让出一次机会给前台，随后优先；排队取消不启动代码。环境准备、计算、复核分别取得并释放槽，不嵌套持有。waitMs/holdMs记录真实准入及最终清理时间，与 CPU时间分开。

普通解析使用 CPU；主进程明确选择 CoreML才授予 GPU，并受统一上限约束。所有科研进程拒绝 setpgid、setsid、posix_spawn，防止逃离监督组。文件范围只来自显式读取/写入/执行声明；网络、GPU和路径边界由原生沙箱执行。

## 监测限额

resourceLimits和writeLimits必填，每个可写目录恰有一条限额；缺失、重复、多余目录在派发前失败。hard模式返回 `research_process_hard_limits_unsupported`。CPU/RSS和磁盘限额采用监测后终止，Seatbelt不提供这些硬配额。

实验计算采用 2 GiB RSS、timeoutMs的四倍 CPU预算；共享解析/图稿 worker为 4 GiB。Vale、Tectonic、Typst、Pandoc及环境探针声明各自预算，以实际请求和回执为准，Python探针另见[环境合同](research-python-environment.md)。

| 可写目录 | 单文件 | 总量 | 文件数 | 目录项 |
| --- | ---: | ---: | ---: | ---: |
| 实验输出/scratch与Python探针 | 64 MiB | 128 MiB | 1000 | 2000 |
| Vale、Tectonic、Typst作业 | 64 MiB | 512 MiB | 10000 | 20000 |
| 共享 worker作业 | 128 MiB | 896 MiB | 6000 | 12000 |

领域输出校验仍独立执行。归档逐块限制单文件64 MiB、内容512 MiB、归档600 MiB和10000成员，见[导出](research-exports.md)。stdout/stderr共用真实字节上限，不为两个流分别放宽。

`/bin/ps` 每轮结束后间隔100ms采样计算组，命令自身1s超时/512KiB上限，不读进程环境或命令行。CPU是已观察PID/启动时间的累计user+system高水位之和；RSS是一次采样成员驻留集之和的峰值。共享页可能重复计数，短命成员可能漏采；零采样时两者均为null，不能补零或当完整计费。

超限分别返回CPU/内存/写入/日志错误，TERM/KILL宽限100ms；普通取消和墙钟超时沿用调用方宽限。采样失败返回 `research_process_resource_monitor_failed`，不能继续假装受监测。目录退出后再做最终检查，短时越限可能已发生。

## 清理与宿主崩溃

arm64原生监督程序在计算沙箱和计算组之外，先注册宿主PID的内核退出事件，再建立计算组并释放启动门。宿主SIGKILL或首进程退出后清理全部后代，确认组消失才通过私有管道报告真实计算退出码；监督失败不能变成成功。

JS仍负责取消、超时、采样与限额，归还槽前确认计算/监督组消失。无法确认清理时以 `research_process_cleanup_unresolved` 隔离宿主后续计算并拒绝队列；普通重试不能解除。实际清理失败报告 `research_process_kill_failed`，EPERM须由后续缺失检查判定。

监督源码与签名二进制由 `node scripts/research/build-process-guard.mjs` 更新锁文件。运行核对二进制摘要，采样不包含监督程序消耗。崩溃后未写入的最终观测保持缺失，恢复不自动重跑。

## 原生环境身份

Python 环境检查使用合同2及代码清单合同1：冻结声明解释器和包代码树的完整文件字节、成员、权限及链接拓扑，并在探针前后各核对一次。元数据不变但包代码变化仍改变环境hash；观测到漂移返回 `research_python_native_code_changed`。解释器、前缀、完整包集合和锁文件须匹配已绑定的项目环境，见[Python环境](research-python-environment.md)。

代码扫描流式读取，单文件512MiB、总4GiB、100000项、清单64MiB。核对描述符和路径的inode/大小/权限/纳秒时间，拒绝特殊文件与未声明链接目标。两次扫描是观测，不证明期间从未发生瞬态修改，也不等于全系统共享库快照。

原生代码与视觉模型的文件扫描在异步打开 / 元数据读取之后、创建读取流之前再次核对取消信号，避免已取消信号令流在迭代器拒绝后另发未处理错误。读取中取消仍由流传播，普通 I/O 错误保持失败；所有路径均关闭已打开的文件描述符。

## 不可变审计回执

| 文件 | 当前合同与含义 |
| --- | --- |
| log/resources.json | schema3/backend2：运行/项目/输入/环境、限额、实际退出、CPU/RSS、准入、探针序列、hostCrashCleanup与processGuardHash |
| log/environment-code.json | Python环境完整代码清单及原始metadata校验材料；环境检查身份为合同2，代码清单为合同1 |
| log/python-startup.json | Python真实启动路径、旗标、模块、版本和seed，见Python专题 |

资源 outcome为returned/rejected/not_dispatched；准备失败不补计算观测，返回0后环境复核失败仍保存真实计算事实并将实验标为失败。probes分别保存preparation/verification的请求hash、命令、预算、状态及观测；Python在准备和复核阶段各保存一次environment，TypeScript无环境探针。不存原始环境变量，探针消耗不混入计算。

回执只写一次、只读权限，发布校验字节、身份、限额、成功退出和完整探针序列；清单自身重新hash不能掩盖原环境身份。Node不生成原生代码回执。审计文件不进入科学知识索引；导出日志通过公开投影交付，原字节与投影身份分别保留。

## 开发检查

资源边界的专项入口是 `pnpm test:research-resources`，需要 macOS Seatbelt 与原生监督资源。测试使用有界 C 探针和自建临时目录，检查 CPU/RSS、目录、日志、取消/超时、离组拒绝、网络/GPU/路径及宿主 SIGKILL 清理；完整开发要求见[开发指南](development.md)。

原生边界探针不证明任意 Python 环境、科学正确性或硬资源隔离。正常关闭和磁盘快照恢复不能替代真实宿主崩溃清理检查。

Python 环境准备使用独立安装入口，只有固定 uv/Python 与固定命令集合可获得准备所需网络和目录权限；普通 runner 的网络合同仍为 none。准备按工作目录 realpath 取得写租约，实验与视觉检索持有读租约，取消等待监督的进程树退出及任务暂存清理。操作状态持久化在 research_python_environment_operations，重启转 interrupted；ready 与成功回执原子提交。
