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

移除未使用的 `allowPosixSpawn` 选项。全部科研进程固定拒绝 Darwin 的 `setpgid`、`setsid` 和 `posix_spawn` 系统调用。旧选项允许原子 `POSIX_SPAWN_SETPGROUP` 成功创建另一进程组，尽管单独的组/会话切换已被拒绝；真实复现保存在 `xsafe-a3-spawn-escape-repro.log`，探针等待子进程退出。修复后的实际子进程组、会话切换与原子 spawn 均被拒绝。已有 R 原生桥继续在这一限制下通过生产运行检查。

真实 DNS 对照能解析 `example.com`，相同二进制在计算沙箱返回 `errno=EPERM`；无需增加未经证实的 Mach 服务规则。Metal 对照可取得实际设备和命令队列，默认 GPU 权限下两者不可取得，明确允许后两者可取得。回执保存设备名称、内核版本、架构和实际准入时间；它证明本机 Metal 权限边界，不代表所有加速服务或其他平台均已验证。

原生检查还验证声明输入可读但不可写、声明输出可写、未声明数据与路径穿越读取/写入被拒绝。输出符号链接无法读取未声明数据，且输出监控返回失败。凭证检查只在测试父进程暂设随机合成值，对照记录存在标志；最小子进程环境不含该值，测试恢复父进程原环境。日志和回执不包含凭证内容。

本增量为 `Verified passing`。在 `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc` 执行：

- `node --test tests/unit/research-compute-policy.test.mjs`：修复前 0/3，修复后 3/3。
- `pnpm test:research-resources`：13/13，包含 DNS、文件、凭证、原子 spawn 和实际 Metal 探针。
- `pnpm test:unit`：1142/1142。
- `node scripts/run-research-p0.mjs`：13/13。
- `pnpm harness:eval`：94/94；`node scripts/smoke-electron.mjs`：13/13，零 renderer 错误。
- `pnpm build`（含 typecheck）、`pnpm check:ipc`、`pnpm check:renderer-chunks`：通过，eager JS 保持 1132907 字节、6 个文件。

日志为 `.artifacts/research-optimization/xsafe-a3-*.log`，真实边界回执为 `xsafe-a3/native-resources.json`。本增量未增加 CPU/内存硬隔离能力；资源事实持久化、原生环境和输出上限的其余审计继续按计划执行。
