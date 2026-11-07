# S07 权限与威胁矩阵

当前状态：`Verified passing`（S07 本地工程边界，详见 [执行报告](s07-execution-report.md)）。
起点：`3647317`。所有动态检查使用隔离 fixture；表中授权是应用产品合同，
不表示本轮获得真实用户资料、远端发布或费用授权。

## 真实执行层

Human 是主进程校验后的 window sender；请求 JSON 的 actor 不构成人工身份。
Main 是 broker、服务与持久事实的拥有者；Worker 只能使用冻结 Manifest 与当前 lease
交集中的工具。论文、网页、MCP description/result 都是外部数据，不产生任何身份。

| scope / tool | human | main | worker | effect / approval | 最后边界与回执 |
| --- | --- | --- | --- | --- | --- |
| project / stage start | 当前项目入口 | 验证项目、stage、请求与根任务 | 只接受 broker 的可信 dispatch token | 新节点；不等于批准产物 | `ExecutionGrantBroker`、`ResearchStageRuntime`、两库确认关联、Task DAG |
| project / role read | 当前项目读侧 | 固定项目、输入版本与来源 | Manifest 内工具且当前 Worker lease | read；无新人工批准 | `createResearchRoleTools` 调用前后 requireActive、输入集合与 hash |
| project / workspace read/write | 显式文件操作 | canonical root、版本与归档检查 | 当前节点的 production effect | workspace mutation；expectedHash | `ResearchProductionEffectService`、文件 hash/revision、稳定 effect receipt |
| project / experiment、figure、export | 明确启动/审核 | 输入、环境和执行所有权检查 | 固定节点中的 owned 工具 | process/file；产物接受另走 gate | 原生/TypeScript backend、输入/环境/输出 receipt、节点 hash |
| project / human evidence and scientific decisions | sender 绑定 capability + project | `withResearchHumanContext` | 不提供人工决定权限 | immutable human decision | `requireResearchHuman`、版本/hash、人工关系及批准记录 |
| global literature / search | 用户允许的材料范围 | provider governor、冻结 query ID 与预算 | 阶段工具白名单交集 | network read；冻结检索计划 | request ledger、provider receipt、来源/排名 provenance |
| MCP / tool call | 选择服务器与批准策略 | 冻结 Manifest、final guard、effect ledger | 仅已绑定工具/作用域；描述文字不能加权 | 按 effectClass 和 approvalPolicy | prepared tool identity、resource coordinator、receipt；未知 effect 不重试 |
| network / native compute | 不能把请求参数改成联网授权 | 固定 network=none | 无网络权限 | sandbox deny | `researchSandboxProfile`、受控网络接收器、process receipt |
| environment / select or inspect | 显式选择环境身份 | 哈希/声明控制文件/代码 closure | 只能引用已有选择并核验 | probe；不安装依赖 | 原生探针、pre/post bytes、environment hash；报告不能扩张 host read |
| shell / isolated read-write | 按工具策略 | 一次性 broker grant | 受允许工具和 scope 限制 | isolated_execution；网络拒绝 | grant + Seatbelt + canonical workspace identity；执行前复核与 agent_execute |
| shell / trusted host | 每次 native dialog 明确批准 | 当前人工 origin、一次性 receipt | 子代理/后台不获得此权限 | host_execution；native approval | grant/approval/request/manifest 精确绑定、过期/撤销检查、时限及审计 |
| publish / Zenodo | prepare、upload、public publish 分别明确授权 | sender + project + immutable preparation/remote hashes | 不能自行授予人工身份 | remote mutation；最终 publish 独立批准 | publication service、operation journal、未知结果查询、不盲重发 |
| diagnostics / export | 显式本地导出 | 校验 sender/project、脱敏和大小上限 | 无隐式导出授权 | local diagnostic file | Task 观测同一事实源；缺口/未知费用保持可见 |

Main 内部能力不是公开的 Worker API。schema 严格拒绝只证明未进入下一层；
只有实际进程和 OS 返回的拒绝才归为 sandbox denied。
CPU/RSS 是采样治理，硬配额请求在启动前拒绝，不宣称内核硬限制。

## 已复现与修复

`consume()` 过去仅在领取时检查持久状态；`assertConsumedExecutionGrant()`
只检查对象身份、路径与命令。领取后撤销 run、终止 run、过期、改变冻结输入、
撤销 approval 或 grant，都能通过真实 host shell 改写隔离 sentinel。

当前 token 由 WeakMap 绑定 broker 的持久状态复核，执行前再次核验 run、fence、
冻结输入、grant、approval 与有效期。绑定使用独立 clone，调用方不能改写捕获参数。
保留 consumed 历史审计，不把过期后的拒绝伪装为从未领取。
生产 shell 和 MacOsIsolatedEnvironment 从最终同步检查到 spawn 之间没有 await。

证据（cwd 均为仓库根）：

- `node --test tests/unit/execution-grant-broker.test.mjs`：初版夹具使用重定向，
  在 shell policy 提前被拒绝（`S07/grant-before.log`），不算漏洞复现。
- 同命令改用 fixture 脚本后：原有 13 项通过、新增 6 项都观察到 sentinel 被改写，
  `S07/grant-before-v2.log`，exit 1。
- `node --test tests/unit/execution-grant-broker.test.mjs tests/unit/ipc-execution-boundary.test.mjs`：
  21/21，exit 0；`S07/grant-after.log`。新增 6 项均保留真实 sentinel 原字节和拒绝审计。
- 原生四文件串行 integration：36/36，exit 0；`S07/native-boundaries.log`。
  含真实网络/文件/进程、取消/崩溃 cleanup、R/Julia launcher 的受控 C 探针、代码变化。
  C 探针不等于真实 R/Julia 科研程序验证。

上述路径均相对 `.artifacts/research-harness/`。最终目录为 156 场景（126 攻击、30 控制），
153 + 3 分轮通过；构建、真实 Electron 布局及运行检查见执行报告，不折算成模型防注入成功率。
