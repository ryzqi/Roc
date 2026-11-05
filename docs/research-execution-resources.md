# 科研执行资源治理

所有 `runResearchProcess` 调用显式提供 CPU 时间与驻留内存阈值。实验和原生环境探针采用 2 GiB 驻留阈值，解析/图稿等共享 worker 采用 4 GiB；CPU 阈值为各自执行超时的四倍。Vale、Tectonic 和 Typst 也声明对应阈值。请求 `hard` 模式会在启动代码前以 `research_process_hard_limits_unsupported` 拒绝。macOS Seatbelt 负责既有文件、网络、GPU 与脱离进程组限制，不能提供 CPU 或内存硬配额。

主进程用本机 `/bin/ps` 对实际独立进程组采样。每轮结束后间隔 100ms 再采样，采样进程自身有 1s 超时、512 KiB 返回上限及最小环境；不读取命令行或进程环境。CPU 数据为每个已观察到的 PID/启动时间身份的累计 user + system 时间高水位，包括后来退出的成员。RSS 峰值为一次采样中所有成员的驻留集之和。它可能重复计算共享页，也可能漏掉两次采样间退出的短命子进程；这些数据不能冒充完整计费、物理总内存或硬限制。尚未观察到进程时，CPU/RSS 为 `null`。

超过 CPU/RSS 阈值后终止实际进程组，返回分别带 `research_process_cpu_limit` 或 `research_process_memory_limit` 的失败及真实采样数据。采样失败不会继续假装受监控，返回 `research_process_resource_monitor_failed`。资源超限的 TERM/KILL 间隔为 100ms。普通取消与超时仍保留调用方原终止宽限。

父进程退出时立即清理子进程，避免后代持有 stdout/stderr 导致 `close` 一直等待。返回成功或原始失败之前，使用已有进程树清理工具确认进程组消失；无法清理则报告 `research_process_kill_failed`。Darwin 在进程组消失期间可能返回 `EPERM`，必须由后续实际缺失检查判定结果，不能直接覆盖原资源超限原因。

`pnpm test:research-resources` 编译临时 C 探针并运行真实 Seatbelt 进程，验证忙碌子进程 CPU、分配内存的子进程、父进程退出后持有管道的后代、取消、超时和硬限制拒绝。网络用真实本机 TCP 监听器核对连接拒绝且服务端收到零连接；创建 socket 本身不代表已经联网。探针、运行目录仅属于该测试，结束后清理。

2026-11-05 资源专项为 `Verified passing`：在 `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc` 执行 `node --test tests/unit/research-process-resources.test.mjs`，3/3 通过；`pnpm test:research-resources`，6/6 通过。实际采样和清理回执位于 `.artifacts/research-optimization/xsafe-a1/native-resources.json`，最终专项日志为 `xsafe-a1-native-final.log`。初轮 4/6、第二轮 5/6 及原内存专项复验日志保留在同一工件根目录；最终断言保留实际超限、正确原因、进程缺失和零网络连接。

同一仓库目录的 `pnpm test:unit` 为 1133/1133；`node scripts/run-research-p0.mjs` 为 13/13，覆盖实际 Electron 原生 worker、实验、重启与沙箱链；`pnpm harness:eval` 为 94/94；`node scripts/smoke-electron.mjs` 为 13/13，零 renderer 错误。最终 `pnpm build`（含 typecheck）、`pnpm check:ipc`、`pnpm check:renderer-chunks` 通过，eager JS 为 1132907 字节、6 个文件。日志为 `.artifacts/research-optimization/xsafe-a1-*.log`。验证后仅整理实验服务输出的类型与已有字段，不改变已验证的资源 runner；最终构建包含该整理。

CPU/内存硬隔离后端尚未提供，不能发布要求这些能力的任务。

## 统一计算准入

现有 `ToolResourceCoordinator` 同时承载科研进程的计数准入；普通工具原有的资源读写锁继续使用原合同。所有实际科研进程共享主进程中的一个计算池：全局最多 2 个、同一项目最多 1 个、解析最多 1 个、已明确允许的 GPU 进程最多 1 个。进程的项目、用户/后台优先级及计算类别由主进程调用方明确声明，不从存储路径或模型文本推断。实验、项目索引、导入、图稿、模板和导出使用实际项目 ID；共享文献解析及文献库导出明确属于全局操作。

队列按进入顺序选择可执行的请求，项目满额的请求不会阻止其他项目使用空闲槽。最早的可执行后台请求可以让出一次机会给后来的前台请求，之后在资源可用时必须先执行，持续前台请求不能使它饥饿。待执行队列最多 256 项，超出时拒绝。取消排队请求会删除该请求并拒绝其调用，启动代码的次数为零，活动同项目进程继续执行。

`parse-budget.ts` 及其独立解析队列已删除。文献显式解析声明 `user`，项目文件解析声明 `background`，由相同计算池执行解析上限和公平规则。环境探针、执行和后置环境核验分别取得/释放槽，不嵌套占有计算槽。每次返回的 `admission.waitMs` 和 `holdMs` 来自真实排队、准入与最终进程清理的时间；它们与采样 CPU 时间是不同指标。

槽只在进程组清理检查结束后释放。无法确认进程组消失时，协调器拒绝全部后续计算并终止排队请求，错误为 `research_process_cleanup_unresolved`；诊断读取仍可进行。计算池隔离状态不会由重试或普通槽释放自动清除。

新增协调器/既有工具锁/采样联合检查 15/15，受影响文献导入、索引和 worker 合同检查 87/87；真实资源进程检查扩展为 8/8。真实子进程测试保持两个活动槽，证明前台获准一次后后台先于后来的前台获准；另一检查证明取消同项目排队请求不会产生进程，也不会停止活动同项目进程。

统一准入增量为 `Verified passing`。在上述仓库目录执行 `pnpm test:unit`，最终 1139/1139；`node --test tests/unit/research-process-admission.test.mjs tests/unit/tool-resource-coordinator.test.mjs tests/unit/research-process-resources.test.mjs tests/unit/run-telemetry-trace.test.mjs` 为 28/28；最终构建/typecheck、Harness 94/94、启动 13/13 零 renderer 错误、IPC 与分块检查通过，eager JS 保持 1132907 字节、6 个文件。

`node scripts/run-research-p0.mjs` 初轮 12/13，唯一失败为测试夹具直接编译 hostile PDF 时未声明准入范围；补上实际项目身份后，`node scripts/run-research-p0.mjs --test-name-pattern='hostile PDF text'` 1/1 通过，保留其余 12 项结果。初轮全量 1136/1139 的三个诊断失败由计算类别进入旧工具锁计数造成；计算观察采用独立类型后，实际 trace 联合 28 项和最终 1139 项通过，严格诊断 schema 没有放宽，未采集的计算计数没有伪装成零。日志为 `.artifacts/research-optimization/xsafe-a2-*.log`，实际计算准入回执保存为 `xsafe-a2/native-resources.json`。资源事件持久化及其余 X-SAFE 边界审计仍未完成。

## 计算权限与原生边界

新建实验请求只接受明确的 `network: 'disabled'`，实际角色 SDK 与主进程能力在调用执行服务前拒绝联网请求。执行服务固定使用 `networkAccess: 'none'`，下载不属于实验计算权限。普通文献和项目索引解析默认使用 CPU；主进程明确选择 CoreML 后才允许 GPU，并受统一 GPU 并发上限约束。

移除未使用的 `allowPosixSpawn` 选项。全部科研进程固定拒绝 Darwin 的 `setpgid`、`setsid` 和 `posix_spawn` 系统调用。旧选项允许原子 `POSIX_SPAWN_SETPGROUP` 成功创建另一进程组，尽管单独的组/会话切换已被拒绝；真实复现保存在 `xsafe-a3-spawn-escape-repro.log`，探针等待子进程退出。修复后的实际子进程组、会话切换与原子 spawn 均被拒绝。本次生产链路执行 TypeScript；实际 R/Julia 环境运行复验尚未完成，不能由 C 探针或 TypeScript 结果代替。

真实 DNS 对照能解析 `example.com`，相同二进制在计算沙箱返回 `errno=EPERM`；无需增加未经证实的 Mach 服务规则。Metal 对照可取得实际设备和命令队列，默认 GPU 权限下两者不可取得，明确允许后两者可取得。回执保存设备名称、内核版本、架构和实际准入时间；它证明本机 Metal 权限边界，不代表所有加速服务或其他平台均已验证。

原生检查还验证声明输入可读但不可写、声明输出可写、未声明数据与路径穿越读取/写入被拒绝。输出符号链接无法读取未声明数据，且输出监控返回失败。凭证检查只在测试父进程暂设随机合成值，对照记录存在标志；最小子进程环境不含该值，测试恢复父进程原环境。日志和回执不包含凭证内容。

本增量为 `Verified passing`。在 `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc` 执行：

- `node --test tests/unit/research-compute-policy.test.mjs`：修复前 0/3，修复后 3/3。
- `pnpm test:research-resources`：13/13，包含 DNS、文件、凭证、原子 spawn 和实际 Metal 探针。
- `pnpm test:unit`：1142/1142。
- `node scripts/run-research-p0.mjs`：13/13。
- `pnpm harness:eval`：94/94；`node scripts/smoke-electron.mjs`：13/13，零 renderer 错误。
- `pnpm build`（含 typecheck）、`pnpm check:ipc`、`pnpm check:renderer-chunks`：通过，eager JS 保持 1132907 字节、6 个文件。

日志为 `.artifacts/research-optimization/xsafe-a3-*.log`。A5 新增红测曾覆盖 `xsafe-a3/native-resources.json`，该文件不再代表原 13 项验证；完整边界回执以 `xsafe-a5/native-resources-final.json` 为准，其最终 20 项复验包含全部原 13 项边界场景，原 A3 验证日志保留。本增量未增加 CPU/内存硬隔离能力；原生环境的其余审计继续按计划执行。

## 实验资源回执

新执行保存版本 1 的 `log/resources.json`，沿用实验文件快照和工件 manifest 的 SHA-256 校验。回执明确关联实际运行、项目、引擎、输入快照和环境摘要，保存计算超时、采样 CPU/RSS 阈值、文件数量/大小/总量/目录项及 stdout/stderr 合计上限。后端身份记录 macOS Seatbelt 合同版本、实际内核版本和架构，CPU/内存硬限制始终为 `false`。

`returned` 保存 runner 的实际退出码、资源采样和准入时间；`rejected` 保存原始失败代码及 runner 已取得的观测；环境准备失败记录 `not_dispatched`，计算派发与采样均为空。零次采样只接受 CPU/RSS 同时为 `null`，不能转成零。进程返回零之后发生环境漂移等失败时，回执仍保留已返回的进程事实，实验终态另行说明后续失败。环境探针的观测不会冒充计算观测。

主进程以只写一次、只读权限保存回执。发布及发布后复验同时检查回执字节摘要、运行/项目/输入/环境身份、计算策略和成功退出；缺少回执不能通过这些发布检查。已发布 manifest 保留回执文件摘要，修改回执会使原工件复验失败。资源文件可通过现有实验文件读取接口核查，保持项目归属检查；它不进入科研知识索引，不生成科学主张或 Evidence。

回执保存计算结束时实际取得的事实。进程或应用崩溃导致未写入最终回执时，原运行保留中断状态与缺失观测，重启不会制造采样或自动重跑。原生环境探针和其他 worker 的资源持久化仍是后续工作。

本增量为 `Verified passing`。在上述仓库目录执行 `node --test tests/unit/research-experiment-resources.test.mjs tests/unit/research-process-resources.test.mjs tests/unit/research-compute-policy.test.mjs`，最终 9/9；`pnpm test:unit`，1145/1145；`pnpm build`（含 typecheck）、`pnpm check:ipc`、`pnpm check:renderer-chunks` 通过，eager JS 1132907 字节、6 个文件；Harness 94/94、启动 13/13，零 renderer 错误。初轮专项 8/9 的失败是新跨项目夹具复用工作区，随后以不符合 `createProject` 输入的 `null` 再次失败；改为实际独立工作区后严格归属检查通过。

`node scripts/run-research-p0.mjs` 为 13/13，并在生产实验服务之外捕获原始 runner 结果/错误，与持久化回执逐项比对。随后仅增加真实超时检查，`node scripts/run-research-p0.mjs --test-name-pattern='standard offline task parses PDF evidence'` 为 1/1；原 TypeScript 计算/出版/交付流程及新超时均通过。超时回执保留 10 次采样、150ms 已观测 CPU、89571328 字节峰值 RSS、2013ms 准入占用及 `research_process_timeout`，失败运行没有发布工件。回执保存在 `.artifacts/research-optimization/p0-production/research_task_79d6d06f-4ca9-4930-bf87-c1c56ff6e42d/report.json`，验证日志为 `xsafe-a4-*.log`。除新增专项断言外，产品代码自通过构建后未改动。

## 全部可写目录的限额

`writeLimits` 为科研进程的必填合同；每个可写目录必须恰有一条限额。遗漏、重复或多余目录均在启动代码前拒绝。R 临时桥显式加入其临时目录和限额，runner 不再提供可选监控路径。

| 生产者 | 单文件 | 每个可写目录总量 | 文件数 | 目录项数 |
| --- | ---: | ---: | ---: | ---: |
| 实验输出、scratch、R 桥临时目录、原生环境探针 | 64 MiB | 128 MiB | 1000 | 2000 |
| Vale、Tectonic、Typst 作业目录 | 64 MiB | 512 MiB | 10000 | 20000 |
| 共享 worker 作业目录 | 128 MiB | 896 MiB | 6000 | 12000 |

共享 worker 的总量覆盖现有 512 MiB 文献资产及三份 128 MiB 工件上限，文件数为现有 5000 资产上限加 1000 个作业/缓存文件。解析、图稿、模板和文献格式 worker 均受这些目录限额约束。具体输出仍需通过各领域原有校验，目录限额不能替代科学工件合同。

磁盘目录仍以 100ms 间隔监控，代码退出后再检查最终目录；这属于监测和终止，不是磁盘硬配额。短时写入可以越过阈值后才被发现，不能宣称任意恶意写入均被内核预先截断。归档写入继续使用既有逐块字节上限：单文件 64 MiB、总量 512 MiB、归档 600 MiB、成员 10000。

stdout/stderr 共用真实字节计数并最多保留指定总量。日志超限与 CPU/RSS、目录超限统一使用 100ms TERM/KILL 宽限，避免忽略 TERM 的日志洪泛进程继续占用普通 1 秒宽限。取消及普通超时保留调用方声明的原宽限。

真实有限 C 探针验证单文件、跨文件总量、文件数、空目录项数、硬链接、符号链接和日志洪泛；每个新输出探针均核对实际进程组已消失。探针最大文件写入为 128 KiB，日志尝试 256 KiB，只有任务专属临时目录参与，测试结束清理。忽略 TERM 的日志探针保留上限 4096 字节，修复前实际占用 1978ms，修复后 149ms；其已观察 CPU 为零是一次真实采样，区别于未采样的 `null`。

本增量为 `Verified passing`。在上述仓库目录执行 `pnpm test:research-resources`，最终 20/20；随后只补充非空但缺少一个可写目录的检查，`node --test --test-name-pattern='missing or incomplete write limits' tests/integration/research-process-resources.test.mjs`，1/1，零文件创建。`node --test tests/unit/research-experiment-resources.test.mjs tests/unit/research-process-admission.test.mjs tests/unit/research-process-resources.test.mjs tests/unit/research-compute-policy.test.mjs`，15/15；`pnpm test:unit`，1145/1145；生产 P0 13/13、Harness 94/94、启动 13/13 零 renderer 错误，IPC/分块检查通过。

初轮全量单测、生产 P0、启动与 IPC/Harness 覆盖完整写入合同；启动这些检查后只修复日志终止宽限，最终 `pnpm build`（含 typecheck）和实际 20 项原生检查覆盖该修复，不改变已通过的写入合同或其他消费者。eager JS 为 1132907 字节、6 个文件。完整回执复制保留在 `.artifacts/research-optimization/xsafe-a5/native-resources-final.json`；后续专项可写入最新 `native-resources.json`，不得覆盖完整回执。红测、原生复验和全部检查日志为 `xsafe-a5-*.log`。X-SAFE 的原生环境数据/代码完整性与其余资源持久化仍未完成。

## 离线 runner 合同

删除无调用方的 `full`、`loopback` 网络模式及其 Seatbelt 允许规则。科研计算 runner 的类型与运行时均只接受 `networkAccess: 'none'`，其他值在解析任何文件范围或启动代码前拒绝。模型/依赖下载走独立准备操作，不复用计算进程网络授权。移除没有调用方的 `ResearchExperimentService.runProcess` 转发方法。

本增量为 `Verified passing`。有效 `/usr/bin/true` 命令的网络合同红测 0/1，修复后相关单测联合 16/16。`pnpm test:research-resources` 为 21/21，新增两种过时模式均在产生文件前拒绝，并保留实际 DNS/TCP 拒绝、GPU、资源和清理矩阵。`pnpm build`（含 typecheck）、IPC、分块检查通过；标准生产 P0 专项 1/1（包括计算、文献、出版、交付与真实超时）、Harness 94/94、启动 13/13 零 renderer 错误。所有生产者原本都使用 `none`，未重复 A5 已通过的 1145 项全量检查；本次新增拒绝合同由专项直接验证。回执为 `.artifacts/research-optimization/xsafe-a6/native-resources.json`，日志为 `xsafe-a6-*.log`。原生环境数据/代码审计及其余持久化继续执行。

## R 环境探针的数据边界

R 环境探针的项目读取范围缩小为实际取得摘要的 `renv.lock` 和可选 `renv/settings.json`。实际解释器根、声明库和已核验名称的包缓存根仍可读取，项目其他文件不因环境检查获得读取权限。主进程只接受这些实际运行时/库根内的包元数据路径，探针不能指示主进程读取其他项目文件。原生环境摘要加入检查合同版本 2，新的预期环境摘要必须来自当前检查。

本机没有 R/Julia 环境。专项用编译的 C 二进制通过真实 R 启动适配、原生桥和 Seatbelt 执行，独立验证权限合同；它不会把 C 输出当成实际 R 包解析或科学复现验收。正向探针核对两份声明控制文件可读、合法库链接的缓存 `DESCRIPTION` 可读，项目私有文件返回 `EPERM`。恶意探针另在报告里指定私有文件，主进程以 `research_experiment_metadata_outside_scope` 拒绝。修复前 0/2：私有文件实际可读，伪造元数据报告也被接受；修复后 2/2。

本增量在上述范围内为 `Verified passing`。在上述仓库目录执行 `pnpm test:research-environment-boundaries`，2/2；相关政策/资源/准入单测联合 16/16；构建/typecheck、IPC、分块检查通过，eager JS 1132907 字节、6 个文件；标准生产 P0 1/1、Harness 94/94、启动 13/13 零 renderer 错误。回执为 `.artifacts/research-optimization/xsafe-a7a/native-environment.json`，明确记录 `actualRRuntimeTested: false` 和 `actualJuliaRuntimeTested: false`；日志为 `xsafe-a7a-*.log`。实际 R 验收、Julia 控制文件范围、原生代码完整性和其余资源持久化仍待完成。

## Julia 环境探针的项目数据范围

主进程先在无项目读取权限的沙箱中执行所选解释器的 `--version`，使用同一计算准入、资源监测、输出上限和离线/CPU 策略。随后用固定版本 `smol-toml` 解析声明的项目控制文件，选择实际解释器主/次版本对应的 Manifest，发现嵌套 workspace 和本地相对路径依赖。控制文件最多 1000 个，控制文件和本地元数据合计最多 10000 个，单文件 16MiB、总计 64MiB。重复成员去重，循环声明拒绝；缺失、格式错误、版本不匹配、越出项目或符号链接均失败。

JuliaProject、版本化 Manifest、显式 manifest、AppManifest、workspace、preferences 和 artifacts 名称依据 [Julia 文件选择实现](https://github.com/JuliaLang/julia/blob/master/base/loading.jl)及 [Pkg EnvCache 实现](https://github.com/JuliaLang/Pkg.jl/blob/master/src/Types.jl)。这些是当前原生格式。探针只获得选中的控制文件和本地包项目元数据文件的逐文件读取权限，项目根和本地包目录不作为读取授权。运行时和选中的 depot 代码目录继续沿用声明的授权范围。

主进程在派发探针前冻结文件 SHA-256。报告必须精确返回完整控制路径/哈希集合和已核实的运行时版本；额外、遗漏、重复或变更均拒绝，不能通过报告扩大读取权限。本地包元数据只允许预先发现的精确文件，并在探针结束后重新核对字节。环境检查合同升级为 3。

真实 macOS Seatbelt 回归使用编译的 C 可执行文件走 Julia 版本/环境适配入口，验证未声明项目文件、本地包私有文件和未选中的 Manifest 均不可读，合法控制文件与本地元数据可读；验证伪造、缺项、重复、错误哈希，以及实际派发后的控制/元数据漂移。回执位于 `.artifacts/research-optimization/xsafe-a7b/native-environment.json`，明确记录实际 R/Julia 解释器均未测试。该回执不证明 Julia Pkg 在具体安装上的可用性，也不证明整个运行时或包代码的完整性。

本增量在上述范围内为 `Verified passing`。在 `/Users/Apple_501/Desktop/Roc/Roc` 执行 `pnpm test:research-environment-boundaries`，最终 8/8（Julia 6、R 2）；`node --test tests/unit/research-julia-controls.test.mjs tests/unit/research-experiment-resources.test.mjs tests/unit/research-process-resources.test.mjs tests/unit/research-process-admission.test.mjs tests/unit/research-compute-policy.test.mjs`，24/24；`pnpm build`（含 typecheck）通过。`node scripts/run-research-p0.mjs --test-name-pattern='standard offline task'` 1/1、`pnpm harness:eval` 94/94、`node scripts/smoke-electron.mjs` 13/13 零 renderer 错误，IPC/分块检查通过，eager JS 1132907 字节、6 个文件。

最初 Julia 四项红测均失败，原因是没有独立版本探针，且主进程接受未声明、遗漏的控制文件和私有包元数据。修复后初轮 6/6、相关 23/23 通过；最终补上重复成员去重，24 项、8 项原生与构建复验通过。标准 P0/Harness/启动覆盖去重调整前的同一依赖及运行时入口，其结果保留；最终专项直接覆盖调整后的遍历。日志为 `.artifacts/research-optimization/xsafe-a7b-*.log`。原生代码完整性、其余资源持久化与实际解释器验收继续执行。

## 原生代码树身份

环境身份现在包含所声明原生代码树的完整字节与链接拓扑摘要。R 覆盖运行时、所选 library 和已验证的 renv 缓存包根；Julia 覆盖运行时和已授予读取权限的 depot 子目录。已验证科研工具包仍使用其独立 toolchain hash。本地项目脚本沿用显式输入快照，不因环境检查获得整个项目的代码读取权限。

每次环境探针开始前和完成后分别计算代码身份。包名、版本、DESCRIPTION/Project 和解释器文件不变时，动态库或其他包代码的变化仍改变环境哈希；检查期间观察到变化，返回 `research_experiment_native_code_changed`。环境检查合同升级为 4。代码树身份绑定目录/文件集合、权限、文件 SHA-256、链接文本和已解析目标；缓存链接只允许进入已声明根，未知外部目标和特殊文件拒绝。

字节读取采用 1MiB 流式缓冲，单文件最多 512MiB、合计 4GiB、目录项 100000、清单元数据 64MiB。读取前后核对实际文件描述符和路径的 inode、大小、权限及纳秒时间，取消保留原始原因。文件内容每次重算，mtime 不是缓存或成功依据。超过检查范围明确失败，不产生部分成功身份。

实际 C 探针通过原有 R 启动器加载不同文件名的运行时/包动态库，核对其各自函数返回值。库文件名必须不同，因为启动器的 `DYLD_LIBRARY_PATH` 会优先覆盖同名库；仅改 install name 或符号不能建立独立加载的证据。原生四项覆盖运行时库变更、renv 缓存包库变更、派发期间代码漂移和未变更重复身份。回执为 `.artifacts/research-optimization/xsafe-a7c/native-code.json`。

代码身份是两次完整扫描的观测结果，不是不可变文件系统或操作系统共享库的清单；扫描之间被外部写入后又恢复的瞬态变化不因此得到持续隔离证明。实际 R/Julia 解释器验收、逐文件回执与环境探针资源持久化仍待完成，未宣称科学运行可用性或硬资源隔离。

本增量在上述范围内为 `Verified passing`。在 `/Users/Apple_501/Desktop/Roc/Roc` 执行 `pnpm test:research-native-code` 4/4，`pnpm test:research-environment-boundaries` 8/8；`node --test tests/unit/research-native-code.test.mjs tests/unit/research-julia-controls.test.mjs tests/unit/research-experiment-resources.test.mjs tests/unit/research-process-resources.test.mjs tests/unit/research-process-admission.test.mjs tests/unit/research-compute-policy.test.mjs` 30/30；最终 `pnpm build`（含 typecheck）、IPC/分块检查通过，eager JS 1132907 字节、6 个文件。标准生产 P0 专项 1/1、Harness 94/94、启动 13/13 零 renderer 错误。

最终相同探针在隔离的 `e128447` 源码上为 1/4：实际库函数值变化、原包元数据不变，却未改变环境身份；检查期间代码漂移也未被拒绝。有效红测日志与回执为 `xsafe-a7c-native-red-valid.log`、`xsafe-a7c/native-code-red-valid.json`。更早的同名库比较和符号调整未建立独立包加载，保留日志但不作为正确性证据。最终四项保持原值/哈希断言，日志为 `.artifacts/research-optimization/xsafe-a7c-*.log`。隔离源码副本和探针临时目录已清理。
