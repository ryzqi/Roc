# S09 / RH-21：Remote / Container Workspace RFC

日期：2026-11-07。RFC 状态：`Designed`，待具体 workload/目标评审；backend 未实施。
用户已确认“暂未确定，先完成 RFC”；本次不选择目标或实施远程 backend。
基线：`5b8ac3e95179b1a664760d11f37a2d110733dba0`。
关联：[阶段计划](phase-09-conditional.md)、[实验树设计](s09-experiment-tree-design.md)、
[启动报告](s09-execution-report.md)。本文定义验收约束，不声称已有远端能力。

## 1. 需求判断

当前 [process-runner.ts](../src/main/plugins/research/process-runner.ts) 明确只在 darwin 运行；
实验使用 Seatbelt，普通实验无网络/GPU。CPU/内存通过 100ms 采样监测，
[资源合同](../src/shared/schemas/research-process-resources.ts) 明确 cpuHardLimit=false、
memoryHardLimit=false。因此需要 Linux/CUDA 或内核硬限额的任务不能直接使用这条路径。
这证明产品能力边界，尚未证明用户某个真实 workload 需要 Remote。

以下目前均为未提供：任务代码/数据/许可、实际 local 不足的证据、目标 runner 和账号、
OS/架构/GPU/内存要求、传输范围与费用 hard cap。无目标时不选择服务商，不安装容器环境，
不建立空 backend 或调用云端试跑。

| 需要补齐的实证 | 判定方式 |
| --- | --- |
| local 不足 | 保存真实任务的兼容性错误或 CPU/内存/时间/隔离要求；已有明确不支持的能力可先静态判定，性能瓶颈需实测 |
| 远端收益 | 同任务的质量/容差、排队+启动+上传+运行+下载时间、资源与费用；不只比较计算时间 |
| 资源模型 | 明确单个本地容器、已有私有 runner 或具体云端 runner；实际的 OS/image digest/架构/硬件与限制能力 |
| 授权范围 | 数据许可、目标账户/区域、准确文件清单与最大字节数、网络规则、保存期限、删除责任、费用及取消上限 |

先比较所提供目标能否满足任务；目标不支持所需限额或对账能力则不采纳。
Kubernetes、多租户、集群调度和泛化供应商适配层不在本阶段范围。

## 2. 所有权与接入位置

[backend.ts](../src/main/services/deep-agent/backend.ts) 当前为 RocNonExecutingCompositeBackend，
路由 workspace/skills/memory 文件操作，没有 exec/snapshot/restore；
它不是实验进程隔离器。不能只替换 Deep Agents 文件 backend 就称远程执行已完成。

本 RFC 倾向先为研究计算交付单个真实目标：研究助手 → 既有 Task/Stage/grant →
Experiment Service → 显式指定 local 或已验收的目标 → 同一 Effect/预算/资源与结果验证。
workspace 文件能力和执行能力分别通过目标的真实能力清单核验；全局 memory、skills、
本机目录与凭证不会因选择远端自动映射过去。最终接入文件和 API 以目标确定后的实现为准。
主进程负责凭证引用和服务请求；renderer 仅展示可审查的目标、数据、限额与状态。
不增加第二个壳、第二个任务入口或远端失败后的宿主执行回退。

## 3. 最小操作合同（设计，非现有 SDK API）

| 操作 | 输入/前置条件 | 真实输出/拒绝 |
| --- | --- | --- |
| read | task/workspace scope、相对路径、expected hash、最大字节数 | 内容、hash/长度、版本；越界/漂移明确失败 |
| write | scope、内容 hash、expected prior hash、grant、quota、operation identity | 原子写 receipt 与最终 hash；同身份不同内容拒绝 |
| exec | 已批准的 manifest hash、reservation、operation identity、deadline | 持久 operation handle；启动前原子记账和幂等登记；不接受任意宿主 shell |
| inspect | 原 operation identity / handle | 排队/运行/终止/未知、实际 exit、用量/计费、输出库存与 receipt；not-found 必须有权威依据 |
| snapshot | 已停止/一致性点、允许的文件清单与限额 | 不含秘密的不可变 bundle、hash、环境描述；不是活进程恢复承诺 |
| restore | snapshot hash、目标环境 digest、新 scope、批准与资源边界 | 逐文件校验后的新工作区 receipt；不恢复凭证、活进程或绕过 effect 历史 |
| limits | 实际目标策略、所需能力 | CPU/内存/GPU/磁盘/进程/网络/时间限制及 enforcement mode；unsupported 返回明确错误 |
| cancel | 原 operation identity、授权 scope | 服务端持久 stop intent，终态与子进程清理证明；请求已收到不等于清理已完成 |

cancel 为必要控制操作，不能仅依赖客户端断开。接口上所有路径禁止绝对路径、
穿越、symlink/hardlink 逃逸；还需由实际容器/runner 的 mount/UID/执行边界验证。
snapshot/restore 只保证文件与环境声明；重运行仍服从原 effect 对账及科学重复的批准规则。

## 4. 可信 manifest 与授权

manifest 必须绑定 projectId/taskId、stage/node revision、branch/replicate（若有）、
operation/request identity、准确代码/数据/评估器 hash 与字节数、目标/账号/区域、
image digest、runtime 与硬件要求、argv/环境 allowlist、只读输入及独立输出目录、
网络 allowlist、资源限额、总 deadline、成本报价版本/上限、数据许可/保存期限和批准 hash。
版本化规范序列化与服务端重算 hash；客户端提交一个 hash 本身不构成授权。

服务端验证受认证主体与本次 grant 的 scope、时效、撤销状态和 manifest hash，
拒绝拼接字段、跨项目复用、未知或已撤销批准、同 operation 身份不同 hash。
认证方式在目标确定后选定；凭证由主进程/runner 独立注入，短期最小权限；
不导出 Keychain、父进程环境、用户目录、模型 key 或全局 memory。
secret 内容不进入模型上下文、manifest、日志、snapshot 或公共 provenance。

## 5. Effect、恢复与取消

复用 [tool-effect-store.ts](../src/main/services/deep-agent/tool-effect-store.ts) 和
[worker-effects.ts](../src/main/plugins/research/execution/worker-effects.ts) 的逻辑 operation 与 receipt。
远端必须有与本地 operation 对应的持久幂等记录。网络传输可能重发；要求可核验的不重复
计算/effect，不宣称仅靠 HTTP 一次请求即实现 exactly-once。

| 中断窗口 | 恢复动作 |
| --- | --- |
| 预留成功但未提交 | 核查本地 intent 与服务端登记；仅在证实未执行时释放或按同身份提交 |
| 请求发出、响应丢失 | 保持 unknown 与原预留，inspect 原 operation；不得换 request 身份自动重投 |
| 服务端完成、客户端未落 receipt | 拉取持久 receipt，验证 manifest/operation/output hash，幂等落库结算 |
| inspect 不可达或证据不足 | 保持未知，阻塞重复执行/预算释放，等待目标恢复或人工对账 |
| 客户端崩溃/lease 失效 | 服务端独立总 deadline 与限额生效；旧 lease 不能提交当前版本产物 |
| cancel 响应丢失 | 原 operation 再查取消/清理状态；未证明清理前不发新任务、不标完成 |
| snapshot restore 后继续 | 恢复文件与关联事实，不重置 operation、费用或批准；新科学重复需独立已批准 identity |

服务端错误、普通计算失败、未知执行效果、取消中、清理失败必须分别可观察。
Task/Experiment owner 负责本地状态；远端事实进入同一事件/receipt 流，不新增平行事件总线。

## 6. 数据与成本

上传前展示精确文件清单、hash、用途、目标区域、最大入/出站字节与保存期限，
检查许可允许传输。首次 manifest 不含批准范围外文件；新增输入、网络目标、环境或风险
触发新的具体批准。Remote 立项或本机系统授权不等于这些目标已经获准。

现有 [预算账本](../src/main/services/deep-agent/run-budget-ledger.ts) 的非 model 工具预留
尚不能直接证明远端账单 hard cap。实施时在同一 owner 扩展计算、存储、传输、最低计费单位、
取消延迟余量和未决用量；在服务端也有不可被客户端断连绕过的预留/终止规则。
如果供应方只能监测成本，不能保证所需硬上限，则不满足该任务，不将告警描述成硬限制。
未知费用不按零结算；预算拒绝必须发生在上传和 dispatch 前。

输出下载限制总大小/单文件/数量，校验内容 hash、路径与许可后才导入；
公共导出继续通过 [S08 的验证](../src/main/plugins/research/export-public-bundle.ts)。
snapshot 只含批准材料；到期清理需远端确认，不擅自删除其他用户数据。

## 7. 采纳关口

1. 具体 workload/target/授权清单完成；对本 RFC 作目标化评审，确认实施范围。
2. 阅读所选目标当前官方 API 与本地安装版本；只实现这个真实 backend，更新共享 schema、
   IPC、数据迁移、消费者和既有壳状态，逐项声明实际能力。
3. 本地/远端同任务比较；真实 Linux/GPU/隔离能力及 CPU/内存/磁盘/进程/网络限额测试；
   所需硬限额必须测边界，失败可复查。
4. 穿越/链接逃逸、凭证泄露、manifest 篡改、跨项目、过期批准、超预算全部在实际边界阻断；
   未授权上传字节=0、dispatch=0，记录实际调用计数。
5. 提交前后断网、receipt 丢失、客户端/服务端重启、取消、snapshot/restore 与失效 lease；
   原身份核对后无重复计算，清理与费用均有真实 receipt。
6. 获授权真实任务满足质量/容差、成本与恢复标准，完成数据清理；再决定启用该 backend。
   能力不能满足则不采纳，保留失败证据；不生成成功形 mock，也不回退任意宿主执行。

本轮 RFC 可作设计评审；RH-21.1 的真实需求实证及 RH-21.2～21.6 的运行验收均未完成。
没有运行任何远端命令、上传、部署或付费任务。
