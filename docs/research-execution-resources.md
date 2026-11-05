# 科研执行资源治理

所有 `runResearchProcess` 调用显式提供 CPU 时间与驻留内存阈值。实验和原生环境探针采用 2 GiB 驻留阈值，解析/图稿等共享 worker 采用 4 GiB；CPU 阈值为各自执行超时的四倍。Vale、Tectonic 和 Typst 也声明对应阈值。请求 `hard` 模式会在启动代码前以 `research_process_hard_limits_unsupported` 拒绝。macOS Seatbelt 负责既有文件、网络、GPU 与脱离进程组限制，不能提供 CPU 或内存硬配额。

主进程用本机 `/bin/ps` 对实际独立进程组采样。每轮结束后间隔 100ms 再采样，采样进程自身有 1s 超时、512 KiB 返回上限及最小环境；不读取命令行或进程环境。CPU 数据为每个已观察到的 PID/启动时间身份的累计 user + system 时间高水位，包括后来退出的成员。RSS 峰值为一次采样中所有成员的驻留集之和。它可能重复计算共享页，也可能漏掉两次采样间退出的短命子进程；这些数据不能冒充完整计费、物理总内存或硬限制。尚未观察到进程时，CPU/RSS 为 `null`。

超过 CPU/RSS 阈值后终止实际进程组，返回分别带 `research_process_cpu_limit` 或 `research_process_memory_limit` 的失败及真实采样数据。采样失败不会继续假装受监控，返回 `research_process_resource_monitor_failed`。资源超限的 TERM/KILL 间隔为 100ms。普通取消与超时仍保留调用方原终止宽限。

父进程退出时立即清理子进程，避免后代持有 stdout/stderr 导致 `close` 一直等待。返回成功或原始失败之前，使用已有进程树清理工具确认进程组消失；无法清理则报告 `research_process_kill_failed`。Darwin 在进程组消失期间可能返回 `EPERM`，必须由后续实际缺失检查判定结果，不能直接覆盖原资源超限原因。

`pnpm test:research-resources` 编译临时 C 探针并运行真实 Seatbelt 进程，验证忙碌子进程 CPU、分配内存的子进程、父进程退出后持有管道的后代、取消、超时和硬限制拒绝。网络用真实本机 TCP 监听器核对连接拒绝且服务端收到零连接；创建 socket 本身不代表已经联网。探针、运行目录仅属于该测试，结束后清理。

2026-11-05 资源专项为 `Verified passing`：在 `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc` 执行 `node --test tests/unit/research-process-resources.test.mjs`，3/3 通过；`pnpm test:research-resources`，6/6 通过。实际采样和清理回执位于 `.artifacts/research-optimization/xsafe-a1/native-resources.json`，最终专项日志为 `xsafe-a1-native-final.log`。初轮 4/6、第二轮 5/6 及原内存专项复验日志保留在同一工件根目录；最终断言保留实际超限、正确原因、进程缺失和零网络连接。

同一仓库目录的 `pnpm test:unit` 为 1133/1133；`node scripts/run-research-p0.mjs` 为 13/13，覆盖实际 Electron 原生 worker、实验、重启与沙箱链；`pnpm harness:eval` 为 94/94；`node scripts/smoke-electron.mjs` 为 13/13，零 renderer 错误。最终 `pnpm build`（含 typecheck）、`pnpm check:ipc`、`pnpm check:renderer-chunks` 通过，eager JS 为 1132907 字节、6 个文件。日志为 `.artifacts/research-optimization/xsafe-a1-*.log`。验证后仅整理实验服务输出的类型与已有字段，不改变已验证的资源 runner；最终构建包含该整理。

这一增量提供监测、超限终止和清理；X-SAFE 的全局/项目计算准入、前台优先、公平队列及资源事件持久化仍待后续增量。CPU/内存硬隔离后端尚未提供，不能发布要求这些能力的任务。
