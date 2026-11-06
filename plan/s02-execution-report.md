# S02 执行与恢复验收

日期：2026-11-07。开始 SHA：`5313b3d411d583e73e2c8903f99d20f010691084`。
范围状态：`Verified passing（S02 工程 L0/L1）`。

## 实现与证据对应

| 合同 | 实现 | 行为证据 |
| --- | --- | --- |
| RH-02.1 执行身份 | snapshot v10、execution v2、Stage snapshot v1；可信 origin、nodeBinding、冻结 request/manifest/policy/input hashes | identity、stage-inputs、grant、cold-resume 专项；伪造主体/父关系/跨项目/输入漂移拒绝 |
| RH-02.2 单一控制路径 | TaskController 协调 Stage/Chat/job；必需 broker/executor/effect；取消与暂停持久化 cleanup fence | cancellation/lifecycle 专项含同步抛错、并发清理、重开与失败 fence |
| RH-02.3 事件 | envelope v1；每 Task 连续 sequence、actor/correlation/causation、payload/event hash；单项 1 MiB、保留最近 10,000 Task events | task-events/run-event-log/replay 专项；缺尾、全缺、重复、顺序及篡改拒绝 |
| RH-02.4 一致性 | 同库事务/trigger；跨库 Stage intent 与 outbox，幂等 delivery receipt；失败可诊断且重启重投 | identity 的提交故障；execution-replay 的 ACK 失败、双库 reopen 与不重复语义事实 |
| RH-02.5 Effect/预算 | identity v1 与结果绑定 receipt；settlement receipt 同事务；unknown 保留预留与已观测较大值 | effect/预算专项物理 reopen，旧 lease 拒绝、结果篡改、重复/不一致结算、未知价格占用 |
| RH-03.1 回放 | `verifyTaskReplay` 投影；Effect store recorded receipt；既有显式 Stage retry 创建新 execution | 只读 CLI 数据库 hash 不变；recorded 不创建 attempt；retry 保持根 Task 和预算但获得新 runId |
| RH-03.2 恢复 | 同版本 Chat checkpoint 恢复同 runId/threadId；Stage 重新执行是明确新尝试；重新检查项目/输入/审批/effect | `agent-cold-resume` 真实 executor + SQLite backup/reopen；旧 reservation unknown、新调用结算、重复恢复拒绝 |
| RH-03.3 诊断 | 现有 IPC 类型消费 envelope；管理抽屉显示 recoveryIssues/outbox；导出仍限 2 MiB | diagnostics、renderer research-tasks；恢复/导出、键盘、迟到响应、light/dark 与窄布局 |
| RH-03.4 迁移 | agent 19→20、research 60→61；离线转换保留七库 backup/current 与审计；旧执行不能恢复 | offline-execution-migration；原库 hash 不变、预算对账、历史不可执行、effect/schema/link/目标路径拒绝 |
| RH-03.5 故障 | intent、outbox、effect、预算、事件、cleanup、审批变化与进程重启 | 上述持久化专项；不使用内存对象重建代替冷恢复证据 |

投影回放只覆盖完整保留的 Task 事件流，不是恢复 checkpoint 的命令。
recorded receipt 只读取已验证结果。live re-execution 使用现有显式 retry/continue，
进入当前授权、归档与冻结输入检查，不隐式重做 unknown effect。

## 迁移与删除边界

生产 reader 只接受当前 snapshot，旧 v7/v8/v9 decoder、读取时 UPDATE 升级、
`migrateLegacyRunExecutionSnapshot` 和 effect identity v0 自动升级已删除。
Grant 继续 v1，但只校验当前 snapshot；必需 broker/executor/cleanup 不再可省略。

离线工具：`node scripts/migrate-databases.mjs --source <stopped-root> --destination <new-root> --stopped`。
只接受迁移台账锁定的七库来源 schema/checksum；无原始冻结证明的旧执行进入不可恢复审计，
不回填当前版本、不保留可执行的旧审批。演练仅使用隔离 fixture，没有迁移用户真实数据。
S08 仍需匹配应用包的完整升级/冷恢复演练；本阶段证据覆盖数据库转换、旧备份读回和新 reader。

## 验证记录

工作目录统一为 `/Users/Apple_501/Desktop/Roc/Roc`。
宿主 Node v26.13.0、pnpm 12.5.1；Python 通过本地 3.14 环境执行。
精确命令、起止时间、退出码、日志 hash 与源码 hash 由采集器写入 JSON。

- 首轮全量：[verification.json](../.artifacts/research-harness/S02/2026-11-06T17-33-29.412Z/verification.json)。
  构建/IPC/Harness/smoke/integration 通过；并行 unit/renderer 出现失败，保留日志。
- 最终顺序复核：[verification.json](../.artifacts/research-harness/S02/2026-11-06T17-44-18.620Z/verification.json)。
  全部 exit 0，源码 hash 无变化；unit 1517/1517，失败七份 Renderer 文件顺序复跑 114/114，
  IPC、94/94 Harness、build（含 typecheck）、renderer chunks 与 13/13 Electron smoke 通过。
  首轮其余 Renderer 用例通过，未重复已通过文件；没有放宽超时或业务断言。
  smoke 使用本次 dist 构建，`full=false`，不等于 S08 打包应用验收。
- 只读回放 CLI：[verification.json](../.artifacts/research-harness/S02/replay-cli/verification.json)。
  exit 0，执行前后 DB hash 相同，externalCalls=0。

没有使用真实模型、付费 provider、远端写入或发布。S01 独立科学数据仍为 0/200，
S02 工程恢复不证明科学收益。S03～S08 按各自合同继续；S09 为独立条件扩展。
